import Foundation
import MSAL

/// Gets access tokens for the signed-in crew member without any UI.
///
/// Uses the same MSAL keychain cache as the sign-in plugin (same clientId, default
/// keychain group "com.microsoft.adalcache"), so whoever signed in through the app
/// is the user these uploads are sent on behalf of. MSAL returns the cached access
/// token while it is valid, and otherwise uses the refresh token, which needs network.
enum TokenProvider {
    private static let configKey = "TokenProvider.authConfig"

    /// Saved from JS on every enqueue so it is still available when iOS relaunches us in the background.
    static func configure(clientId: String, tenantId: String, scope: String) {
        UserDefaults.standard.set(["clientId": clientId, "tenantId": tenantId, "scope": scope], forKey: configKey)
    }

    /// Calls back with a token, or nil (not signed in, refresh token expired, or offline with an expired token).
    static func token(forceRefresh: Bool = false, completion: @escaping (String?) -> Void) {
        guard let cfg = UserDefaults.standard.dictionary(forKey: configKey) as? [String: String],
              let clientId = cfg["clientId"], let tenantId = cfg["tenantId"], let scope = cfg["scope"],
              let authorityURL = URL(string: "https://login.microsoftonline.com/\(tenantId)"),
              let authority = try? MSALAADAuthority(url: authorityURL),
              let app = try? MSALPublicClientApplication(configuration:
                  MSALPublicClientApplicationConfig(clientId: clientId, redirectUri: nil, authority: authority)),
              let account = (try? app.allAccounts())?.first
        else { return completion(nil) }

        let params = MSALSilentTokenParameters(scopes: [scope], account: account)
        params.forceRefresh = forceRefresh
        app.acquireTokenSilent(with: params) { result, _ in
            completion(result?.accessToken)
        }
    }
}
