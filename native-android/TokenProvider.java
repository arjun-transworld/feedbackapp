package com.transworld.jets.feedback;

import android.content.Context;
import android.content.SharedPreferences;

import com.microsoft.identity.client.AcquireTokenSilentParameters;
import com.microsoft.identity.client.IAccount;
import com.microsoft.identity.client.IMultipleAccountPublicClientApplication;
import com.microsoft.identity.client.PublicClientApplication;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

/**
 * Gets access tokens for the signed-in crew member without any UI.
 *
 * MSAL keeps one token cache per app, shared by every MSAL client with the same
 * clientId, so this sees the account the sign-in plugin signed in. MSAL returns
 * the cached token while valid, otherwise uses the refresh token (needs network,
 * which WorkManager guarantees before running the upload).
 */
final class TokenProvider {
    private static final String PREFS = "TokenProvider";

    private TokenProvider() {}

    /** Saved from JS on every enqueue so the worker has it with the app closed. */
    static void configure(Context c, String clientId, String tenantId, String scope, String keyHash) {
        if (clientId == null || tenantId == null || scope == null || keyHash == null) return;
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("clientId", clientId)
                .putString("tenantId", tenantId)
                .putString("scope", scope)
                .putString("keyHash", keyHash)
                .apply();
    }

    /** Blocking — call only from a background thread. Returns null if no token can be had silently. */
    static String token(Context c, boolean forceRefresh) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String clientId = p.getString("clientId", null);
        String tenantId = p.getString("tenantId", null);
        String scope = p.getString("scope", null);
        String keyHash = p.getString("keyHash", null);
        if (clientId == null || tenantId == null || scope == null || keyHash == null) return null;

        try {
            IMultipleAccountPublicClientApplication app =
                    PublicClientApplication.createMultipleAccountPublicClientApplication(c, configFile(c, clientId, tenantId, keyHash));
            List<IAccount> accounts = app.getAccounts();
            if (accounts.isEmpty()) return null;
            IAccount account = accounts.get(0);

            AcquireTokenSilentParameters params = new AcquireTokenSilentParameters.Builder()
                    .forAccount(account)
                    .fromAuthority(account.getAuthority())
                    .withScopes(Collections.singletonList(scope))
                    .forceRefresh(forceRefresh)
                    .build();
            return app.acquireTokenSilent(params).getAccessToken();
        } catch (Exception e) {
            return null; // not signed in, refresh token expired/revoked, or MSAL error
        }
    }

    /** MSAL Android only accepts its configuration as a JSON file. */
    private static File configFile(Context c, String clientId, String tenantId, String keyHash) throws Exception {
        JSONObject cfg = new JSONObject()
                .put("client_id", clientId)
                .put("authorization_user_agent", "DEFAULT")
                .put("redirect_uri", "msauth://" + c.getPackageName() + "/" + URLEncoder.encode(keyHash, "UTF-8"))
                .put("broker_redirect_uri_registered", true)
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
