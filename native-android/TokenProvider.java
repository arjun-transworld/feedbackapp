package com.transworld.jets.feedback;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;

import com.microsoft.identity.client.AcquireTokenParameters;
import com.microsoft.identity.client.AcquireTokenSilentParameters;
import com.microsoft.identity.client.AuthenticationCallback;
import com.microsoft.identity.client.IAccount;
import com.microsoft.identity.client.IAuthenticationResult;
import com.microsoft.identity.client.IMultipleAccountPublicClientApplication;
import com.microsoft.identity.client.Prompt;
import com.microsoft.identity.client.PublicClientApplication;
import com.microsoft.identity.client.exception.MsalException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

/**
 * Crew sign-in and access tokens for the signed-in crew member.
 *
 * Sign-in (interactive) and the upload worker (silent) use this one MSAL setup and its
 * token cache, so whoever signed in through the app is the user uploads are sent on
 * behalf of. MSAL returns the cached token while valid, otherwise uses the refresh token
 * (needs network, which WorkManager guarantees before running the upload).
 */
final class TokenProvider {
    private static final String PREFS = "TokenProvider";

    interface SignInCallback {
        void done(IAuthenticationResult result, Exception error);
    }

    private TokenProvider() {}

    /** Saved from JS on sign-in and every enqueue so the worker has it with the app closed. */
    static void configure(Context c, String clientId, String tenantId, String scope, String keyHash) {
        if (clientId == null || tenantId == null || scope == null || keyHash == null) return;
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("clientId", clientId)
                .putString("tenantId", tenantId)
                .putString("scope", scope)
                .putString("keyHash", keyHash)
                .commit();
    }

    /**
     * Interactive sign-in. Removes the previous crew account first, so uploads always go out
     * on behalf of whoever signed in last. The callback may run on any thread.
     */
    static void signIn(Activity activity, SignInCallback callback) {
        Context c = activity.getApplicationContext();
        new Thread(() -> {
            try {
                IMultipleAccountPublicClientApplication app = createApp(c);
                if (app == null) throw new IllegalStateException("Entra settings are missing (clientId, tenantId, scope, keyHash).");
                for (IAccount account : app.getAccounts()) app.removeAccount(account);

                app.acquireToken(new AcquireTokenParameters.Builder()
                        .startAuthorizationFromActivity(activity)
                        .withScopes(Collections.singletonList(scope(c)))
                        .withPrompt(Prompt.SELECT_ACCOUNT)
                        .withCallback(new AuthenticationCallback() {
                            @Override public void onSuccess(IAuthenticationResult result) { callback.done(result, null); }
                            @Override public void onError(MsalException e) { callback.done(null, e); }
                            @Override public void onCancel() { callback.done(null, new Exception("Sign-in cancelled")); }
                        })
                        .build());
            } catch (Exception e) {
                callback.done(null, e);
            }
        }).start();
    }

    /** Blocking — call only from a background thread. Returns null if no token can be had silently. */
    static String token(Context c, boolean forceRefresh) {
        try {
            IMultipleAccountPublicClientApplication app = createApp(c);
            if (app == null) return null;
            List<IAccount> accounts = app.getAccounts();
            if (accounts.isEmpty()) return null;
            IAccount account = accounts.get(0);

            AcquireTokenSilentParameters params = new AcquireTokenSilentParameters.Builder()
                    .forAccount(account)
                    .fromAuthority(account.getAuthority())
                    .withScopes(Collections.singletonList(scope(c)))
                    .forceRefresh(forceRefresh)
                    .build();
            return app.acquireTokenSilent(params).getAccessToken();
        } catch (Exception e) {
            return null; // not signed in, refresh token expired/revoked, or MSAL error
        }
    }

    private static String scope(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("scope", null);
    }

    /** Blocking. Null if the Entra settings haven't been saved yet. */
    private static IMultipleAccountPublicClientApplication createApp(Context c) throws Exception {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String clientId = p.getString("clientId", null);
        String tenantId = p.getString("tenantId", null);
        String keyHash = p.getString("keyHash", null);
        if (clientId == null || tenantId == null || keyHash == null || scope(c) == null) return null;
        return PublicClientApplication.createMultipleAccountPublicClientApplication(c, configFile(c, clientId, tenantId, keyHash));
    }

    /**
     * MSAL Android only accepts its configuration as a JSON file.
     * No broker: tokens stay in this app's own cache even on devices with Company Portal/Authenticator.
     */
    private static File configFile(Context c, String clientId, String tenantId, String keyHash) throws Exception {
        JSONObject cfg = new JSONObject()
                .put("client_id", clientId)
                .put("authorization_user_agent", "DEFAULT")
                .put("redirect_uri", "msauth://" + c.getPackageName() + "/" + URLEncoder.encode(keyHash, "UTF-8"))
                .put("broker_redirect_uri_registered", false)
                .put("account_mode", "MULTIPLE")
                .put("authorities", new JSONArray().put(new JSONObject()
                        .put("type", "AAD")
                        .put("audience", new JSONObject()
                                .put("type", "AzureADMyOrg")
                                .put("tenant_id", tenantId))));
        File file = new File(c.getNoBackupFilesDir(), "msal_upload_config.json");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(cfg.toString().getBytes(StandardCharsets.UTF_8));
        }
        return file;
    }
}
