import Foundation

/// Owns the background URLSession that sends feedback records.
///
/// iOS performs these uploads out-of-process: it waits for connectivity on its
/// own, keeps going while the app is suspended or terminated by the system, and
/// relaunches the app in the background to report results. (A user force-quit
/// cancels pending transfers; the JS side re-queues them on next launch.)
///
/// Every attempt carries the signed-in user's MSAL access token (see TokenProvider).
/// A 401 from an expired token triggers a silent refresh and an immediate resend.
final class BackgroundUploader: NSObject, URLSessionDataDelegate {
    static let shared = BackgroundUploader()
    static let sessionId = "com.transworld.jets.feedback.upload"

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
        } catch {
            return completion(error)
        }
        session.getAllTasks { tasks in
            if !tasks.contains(where: { Self.parse($0.taskDescription).id == id }) {
                self.startTask(id: id, request: request, attempt: 0)
            }
            completion(nil)
        }
    }

    /// Tracks token fetches still running, so iOS doesn't suspend us before the retry is queued.
    private let work = DispatchGroup()

    /// Attaches a fresh user token (if one can be had right now) and queues the upload.
    /// With no token — e.g. offline with an expired token — the request still goes out
    /// once online, gets 401, and is retried immediately with a refreshed token.
    private func startTask(id: String, request: URLRequest, attempt: Int, authRetries: Int = 0, delay: TimeInterval = 0) {
        work.enter()
        TokenProvider.token(forceRefresh: authRetries > 0) { token in
            var request = request
            request.setValue(token.map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization")
            let task = self.session.uploadTask(with: request, fromFile: self.bodyURL(id))
            task.taskDescription = "\(id)|\(attempt)|\(authRetries)"
            if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
            task.resume()
            self.work.leave()
        }
    }

    // MARK: - Delegate

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (id, attempt, authRetries) = Self.parse(task.taskDescription)
        guard let id = id else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let hasBody = FileManager.default.fileExists(atPath: bodyURL(id).path)

        if status == 401, authRetries < 2, let request = task.originalRequest, hasBody {
            // Token missing or expired: refresh silently and resend now.
            startTask(id: id, request: request, attempt: attempt, authRetries: authRetries + 1)
        } else if let status = status, error == nil, status < 500, status != 408, status != 429 {
            // Final answer from the server (2xx success, or 4xx the JS side decides about,
            // including 401 when the user must sign in again).
            record(id: id, status: status)
            try? FileManager.default.removeItem(at: bodyURL(id))
        } else if let request = task.originalRequest, hasBody {
            // Network failure, 5xx, throttling, or cancelled (e.g. force-quit):
            // back off 15 min, 30 min, ... up to 6 h. The token is refreshed at that point.
            let delay = min(15 * 60 * pow(2, Double(attempt)), 6 * 3600)
            startTask(id: id, request: request, attempt: attempt + 1, delay: delay)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        work.notify(queue: .main) {
            self.backgroundCompletionHandler?()
            self.backgroundCompletionHandler = nil
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
            let active = tasks.compactMap { Self.parse($0.taskDescription).id }
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

    private func record(id: String, status: Int) {
        stateQueue.sync {
            var results = loadResults()
            results[id] = Result(status: status, at: Date().timeIntervalSince1970 * 1000)
            saveResults(results)
        }
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

    /// taskDescription is "id|attempt|authRetries".
    private static func parse(_ description: String?) -> (id: String?, attempt: Int, authRetries: Int) {
        let parts = (description ?? "").split(separator: "|")
        guard parts.count == 3 else { return (nil, 0, 0) }
        return (String(parts[0]), Int(parts[1]) ?? 0, Int(parts[2]) ?? 0)
    }
}
