import Foundation
import Capacitor

/// JS bridge: window.Capacitor.Plugins.BackgroundUpload
///   enqueue({ id, url, headers, body, auth: { clientId, tenantId, scope } })
///                                        -> queue a POST; a user token is attached natively
///   getState()                           -> { results: [{id, status, at}], active: [id] }
///   clearResults({ ids })                -> forget results JS has already applied
@objc(BackgroundUploadPlugin)
public class BackgroundUploadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundUploadPlugin"
    public let jsName = "BackgroundUpload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearResults", returnType: CAPPluginReturnPromise),
    ]

    @objc func enqueue(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let url = URL(string: call.getString("url") ?? ""),
              let body = call.getString("body") else {
            return call.reject("id, url and body are required")
        }
        if let auth = call.getObject("auth"),
           let clientId = auth["clientId"] as? String,
           let tenantId = auth["tenantId"] as? String,
           let scope = auth["scope"] as? String {
            TokenProvider.configure(clientId: clientId, tenantId: tenantId, scope: scope)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        for (name, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        BackgroundUploader.shared.enqueue(id: id, request: request, body: Data(body.utf8)) { error in
            if let error = error { call.reject(error.localizedDescription) } else { call.resolve() }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        BackgroundUploader.shared.state { results, active in
            call.resolve(["results": results, "active": active])
        }
    }

    @objc func clearResults(_ call: CAPPluginCall) {
        BackgroundUploader.shared.clearResults(ids: call.getArray("ids", String.self) ?? [])
        call.resolve()
    }
}
