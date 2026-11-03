import Foundation
import UIKit
import MSAL

/// Crew sign-in and access tokens for the signed-in crew member.
///
/// Sign-in (interactive) and the background uploader (silent) use this one MSAL setup and
/// its keychain cache (default group "com.microsoft.adalcache"), so whoever signed in through
/// the app is the user these uploads are sent on behalf of. MSAL returns the cached access
/// token while it is valid, and otherwise uses the refresh token, which needs network.
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

    private static func makeApp() -> (app: MSALPublicClientApplication, scope: String)? {
        guard let cfg = UserDefaults.standard.dictionary(forKey: configKey) as? [String: String],
              let clientId = cfg["clientId"], let tenantId = cfg["tenantId"], let scope = cfg["scope"],
              let authorityURL = URL(string: "https://login.microsoftonline.com/\(tenantId)"),
              let authority = try? MSALAADAuthority(url: authorityURL),
              let app = try? MSALPublicClientApplication(configuration:
                  MSALPublicClientApplicationConfig(clientId: clientId, redirectUri: nil, authority: authority))
        else { return nil }
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

    /// Calls back with a token, or nil (not signed in, refresh token expired, or offline with an expired token).
    static func token(forceRefresh: Bool = false, completion: @escaping (String?) -> Void) {
        guard let ctx = makeApp(), let account = (try? ctx.app.allAccounts())?.first else { return completion(nil) }

        let params = MSALSilentTokenParameters(scopes: [ctx.scope], account: account)
        params.forceRefresh = forceRefresh
        ctx.app.acquireTokenSilent(with: params) { result, _ in
            completion(result?.accessToken)
        }
    }
}
