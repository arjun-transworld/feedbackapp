import Foundation

/// Owns the background URLSession that sends feedback records.
///
/// iOS performs these transfers out-of-process: it waits for connectivity on its
/// own, keeps going while the app is suspended or terminated by the system, and
/// relaunches the app in the background to report results. (A user force-quit
/// cancels pending transfers; they are queued again on the next launch.)
///
/// A record is never sent without the signed-in user's access token. Each attempt has two steps:
///  1. Connection check: a background download of the tenant's public sign-in metadata from
///     Microsoft. It carries no feedback and no token. It only finishes once the device is
///     online, and iOS relaunches the app when it does.
///  2. Upload: a token is fetched right then (MSAL refreshes it if needed, now that there is
///     network) and the record is sent with it. No token: nothing is sent, and the record waits
///     for crew to sign in again (reported to JS as 401, "crew sign-in needed").
/// A 401 from the server triggers a forced token refresh and an immediate resend (up to 2 times).
final class BackgroundUploader: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
    static let shared = BackgroundUploader()
    static let sessionId = "com.transworld.jets.feedback.upload"

    /// Recorded when no token can be had; JS treats it like a 401 ("crew sign-in needed").
    private static let noTokenStatus = 401

    /// Set by AppDelegate when iOS relaunches us to deliver session events.
    var backgroundCompletionHandler: (() -> Void)?

    private let stateQueue = DispatchQueue(label: "BackgroundUploader.state")
    private let dir: URL
    private let resultsURL: URL

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.timeoutIntervalForResource = 7 * 24 * 3600 // give each attempt up to a week offline
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private override init() {
        dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PendingUploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        resultsURL = dir.appendingPathComponent("results.json")
        super.init()
    }

    /// Call at app launch so the session reattaches to transfers from earlier runs.
    func start() { _ = session }

    // MARK: - Queueing

    func enqueue(id: String, request: URLRequest, body: Data, completion: @escaping (Error?) -> Void) {
        do {
            // Readable while the device is locked (after first unlock), so uploads can run in a pocket.
            try body.write(to: bodyURL(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            let saved: [String: Any] = ["url": request.url?.absoluteString ?? "",
                                        "headers": request.allHTTPHeaderFields ?? [:]]
            try JSONSerialization.data(withJSONObject: saved)
                .write(to: requestURL(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return completion(error)
        }
        session.getAllTasks { tasks in
            if !Self.isQueued(id, in: tasks) { self.checkConnection(id: id, attempt: 0) }
            completion(nil)
        }
    }

    /// Tracks token fetches still running, so iOS doesn't suspend us before the upload is queued.
    private let work = DispatchGroup()

    /// Step 1. Finishes once the device is online (not before `delay`, for retries).
    private func checkConnection(id: String, attempt: Int, delay: TimeInterval = 0) {
        guard let tenantId = TokenProvider.tenantId,
              let url = URL(string: "https://login.microsoftonline.com/\(tenantId)/v2.0/.well-known/openid-configuration")
        else { return finish(id: id, status: Self.noTokenStatus) }
        let task = session.downloadTask(with: url)
        task.taskDescription = "\(id)|\(attempt)|0|check"
        if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
        task.resume()
    }

    /// Step 2. The device is online: send with a token fetched now, or don't send at all.
    private func upload(id: String, attempt: Int, authRetries: Int = 0) {
        guard var request = savedRequest(id) else { return }
        work.enter()
        TokenProvider.token(forceRefresh: authRetries > 0) { token in
            defer { self.work.leave() }
            guard let token = token else { return self.finish(id: id, status: Self.noTokenStatus) }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let task = self.session.uploadTask(with: request, fromFile: self.bodyURL(id))
            task.taskDescription = "\(id)|\(attempt)|\(authRetries)"
            task.resume()
        }
    }

    // MARK: - Delegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // Connection check only; the downloaded metadata isn't needed.
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (id, attempt, authRetries, isCheck) = Self.parse(task.taskDescription)
        guard let id = id, FileManager.default.fileExists(atPath: bodyURL(id).path) else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode

        if (error as NSError?)?.code == NSURLErrorCancelled {
            // Cancelled, not failed: iOS cancels every transfer when the user swipes the app
            // away, and reports it on the next launch. Start again now, not after a backoff.
            restartIfNotQueued(id: id)
        } else if isCheck {
            if error == nil {
                upload(id: id, attempt: attempt) // online
            } else {
                checkConnection(id: id, attempt: attempt + 1, delay: backoff(attempt))
            }
        } else if status == 401, authRetries < 2 {
            // Token rejected: force a refresh and resend now.
            upload(id: id, attempt: attempt, authRetries: authRetries + 1)
        } else if let status = status, error == nil, status < 500, status != 408, status != 429 {
            // Final answer from the server (2xx, or 4xx the JS side decides about,
            // including 401 when the user must sign in again).
            finish(id: id, status: status)
        } else {
            // Network failure, 5xx or throttling: back off 15 min, 30 min, ... up to 6 h,
            // then check the connection and fetch a token again.
            checkConnection(id: id, attempt: attempt + 1, delay: backoff(attempt))
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        work.notify(queue: .main) {
            self.backgroundCompletionHandler?()
            self.backgroundCompletionHandler = nil
        }
    }

    private func backoff(_ attempt: Int) -> TimeInterval {
        min(15 * 60 * pow(2, Double(attempt)), 6 * 3600)
    }

    /// The JS side may already have re-queued this record on launch; don't send it twice.
    private func restartIfNotQueued(id: String) {
        work.enter()
        session.getAllTasks { tasks in
            if !Self.isQueued(id, in: tasks) { self.checkConnection(id: id, attempt: 0) }
            self.work.leave()
        }
    }

    // MARK: - Results store (read by JS via the plugin)

    private struct Result: Codable {
        let status: Int
        let at: Double // ms since 1970, when the server answered
    }

    /// Finished records ([{id, status, at}]) and ids of transfers still queued in iOS.
    func state(completion: @escaping ([[String: Any]], [String]) -> Void) {
        session.getAllTasks { tasks in
            let active = tasks.filter { $0.state != .completed }.compactMap { Self.parse($0.taskDescription).id }
            let results = self.stateQueue.sync { self.loadResults() }
                .map { ["id": $0.key, "status": $0.value.status, "at": $0.value.at] as [String: Any] }
            completion(results, active)
        }
    }

    func clearResults(ids: [String]) {
        stateQueue.sync {
            var results = loadResults()
            ids.forEach { results.removeValue(forKey: $0) }
            saveResults(results)
        }
    }

    /// Final outcome: remember it for JS and drop the queued copy.
    private func finish(id: String, status: Int) {
        stateQueue.sync {
            var results = loadResults()
            results[id] = Result(status: status, at: Date().timeIntervalSince1970 * 1000)
            saveResults(results)
        }
        try? FileManager.default.removeItem(at: bodyURL(id))
        try? FileManager.default.removeItem(at: requestURL(id))
    }

    private func loadResults() -> [String: Result] {
        guard let data = try? Data(contentsOf: resultsURL) else { return [:] }
        return (try? JSONDecoder().decode([String: Result].self, from: data)) ?? [:]
    }

    private func saveResults(_ results: [String: Result]) {
        if let data = try? JSONEncoder().encode(results) {
            try? data.write(to: resultsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    // MARK: - Helpers

    private func bodyURL(_ id: String) -> URL {
        dir.appendingPathComponent("\(id).json")
    }

    /// URL and headers of the record's POST, so it can be rebuilt after a relaunch.
    private func requestURL(_ id: String) -> URL {
        dir.appendingPathComponent("\(id).request.json")
    }

    private func savedRequest(_ id: String) -> URLRequest? {
        guard let data = try? Data(contentsOf: requestURL(id)),
              let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let url = URL(string: saved["url"] as? String ?? "")
        else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        for (name, value) in saved["headers"] as? [String: String] ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    private static func isQueued(_ id: String, in tasks: [URLSessionTask]) -> Bool {
        tasks.contains { $0.state != .completed && parse($0.taskDescription).id == id }
    }

    /// taskDescription is "id|attempt|authRetries", plus "|check" for connection checks.
    private static func parse(_ description: String?) -> (id: String?, attempt: Int, authRetries: Int, isCheck: Bool) {
        let parts = (description ?? "").split(separator: "|")
        guard parts.count == 3 || parts.count == 4 else { return (nil, 0, 0, false) }
        return (String(parts[0]), Int(parts[1]) ?? 0, Int(parts[2]) ?? 0, parts.count == 4)
    }
}
