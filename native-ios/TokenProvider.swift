import Foundation
import UIKit
import MSAL

/// Crew sign-in and access tokens for the signed-in crew member.
///
/// Sign-in (interactive) and the background uploader (silent) use this one MSAL setup and
/// its keychain cache, so whoever signed in through the app is the user these uploads are
/// sent on behalf of. MSAL returns the cached access token while it is valid, and otherwise
/// uses the refresh token, which needs network.
///
/// The cache lives in the app's own keychain group (its bundle ID), which every app has
/// without the Keychain Sharing capability. Nothing else needs to read it.
enum TokenProvider {
    private static let configKey = "TokenProvider.authConfig"

    enum TokenError: LocalizedError {
        case notConfigured
        var errorDescription: String? { "Entra settings are missing (clientId, tenantId, scope)." }
    }

    /// Saved from JS on sign-in and every enqueue so it is still available when iOS relaunches us in the background.
    static func configure(clientId: String, tenantId: String, scope: String) {
        UserDefaults.standard.set(["clientId": clientId, "tenantId": tenantId, "scope": scope], forKey: configKey)
    }

    /// For the uploader's connection check (Microsoft's public sign-in metadata for this tenant).
    static var tenantId: String? {
        (UserDefaults.standard.dictionary(forKey: configKey) as? [String: String])?["tenantId"]
    }

    private static func makeApp() -> (app: MSALPublicClientApplication, scope: String)? {
        guard let cfg = UserDefaults.standard.dictionary(forKey: configKey) as? [String: String],
              let clientId = cfg["clientId"], let tenantId = cfg["tenantId"], let scope = cfg["scope"],
              let authorityURL = URL(string: "https://login.microsoftonline.com/\(tenantId)"),
              let authority = try? MSALAADAuthority(url: authorityURL)
        else { return nil }
        let config = MSALPublicClientApplicationConfig(clientId: clientId, redirectUri: nil, authority: authority)
        if let bundleId = Bundle.main.bundleIdentifier { config.cacheConfig.keychainSharingGroup = bundleId }
        guard let app = try? MSALPublicClientApplication(configuration: config) else { return nil }
        return (app, scope)
    }

    /// Interactive sign-in. Removes the previous crew account first, so uploads always go out
    /// on behalf of whoever signed in last. Call on the main thread.
    static func signIn(from viewController: UIViewController, completion: @escaping (MSALResult?, Error?) -> Void) {
        guard let ctx = makeApp() else { return completion(nil, TokenError.notConfigured) }
        for account in (try? ctx.app.allAccounts()) ?? [] { try? ctx.app.remove(account) }

        let params = MSALInteractiveTokenParameters(scopes: [ctx.scope],
            webviewParameters: MSALWebviewParameters(authPresentationViewController: viewController))
        params.promptType = .selectAccount
        ctx.app.acquireToken(with: params, completionBlock: completion)
    }

    /// Crew sign-out: removes the account and its tokens from this device's MSAL cache, so nothing
    /// more is sent on that person's behalf. Queued records stay and go out after the next sign-in.
    /// (The browser sign-in session may remember the account; the next sign-in shows an account picker.)
    static func signOut() {
        guard let ctx = makeApp() else { return }
        for account in (try? ctx.app.allAccounts()) ?? [] { try? ctx.app.remove(account) }
    }

    /// Calls back with a token, or nil and the reason (shown to crew in the queue list): not signed in,
    /// refresh token expired or revoked, a sign-in policy requiring interaction, or keychain locked.
    static func token(forceRefresh: Bool = false, completion: @escaping (_ token: String?, _ failure: String?) -> Void) {
        guard let ctx = makeApp() else { return completion(nil, "Entra settings missing on this device") }
        let accounts: [MSALAccount]
        do { accounts = try ctx.app.allAccounts() } catch { return completion(nil, describe(error)) }
        guard let account = accounts.first else { return completion(nil, "no crew member signed in on this device") }

        let params = MSALSilentTokenParameters(scopes: [ctx.scope], account: account)
        params.forceRefresh = forceRefresh
        ctx.app.acquireTokenSilent(with: params) { result, error in
            if let token = result?.accessToken { completion(token, nil) } else { completion(nil, describe(error)) }
        }
    }

    /// MSAL's localizedDescription is only "MSALErrorDomain error -50000"; the reason is in userInfo
    /// (e.g. "AADSTS53000: Device is not in required device state" for a Conditional Access block).
    static func describe(_ error: Error?) -> String {
        guard let error = error as NSError? else { return "unknown MSAL error" }
        var text = (error.userInfo[MSALErrorDescriptionKey] as? String ?? error.localizedDescription)
            .components(separatedBy: "\n").first ?? ""
        var codes = "\(error.domain) \(error.code)"
        if let internalCode = error.userInfo[MSALInternalErrorCodeKey] { codes += ", internal \(internalCode)" }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            codes += ", \(underlying.domain) \(underlying.code)"
        }
        if text.count > 160 { text = String(text.prefix(160)) + "…" }
        return "\(text) (\(codes))"
    }
}
