package com.transworld.jets.feedback;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * JS bridge: window.Capacitor.Plugins.BackgroundUpload — same API as the iOS plugin.
 *   signIn({ clientId, tenantId, scope, keyHash }) -> { idToken, username }: Microsoft sign-in (crew)
 *   enqueue({ id, url, headers, body, auth: { clientId, tenantId, scope, keyHash } })
 *   getState()          -> { results: [{id, status, at}], active: [id] }
 *   clearResults({ ids })
 */
@CapacitorPlugin(name = "BackgroundUpload")
public class BackgroundUploadPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = call.getString("clientId");
        String tenantId = call.getString("tenantId");
        String scope = call.getString("scope");
        String keyHash = call.getString("keyHash");
        if (clientId == null || tenantId == null || scope == null || keyHash == null || keyHash.isEmpty()) {
            call.reject("clientId, tenantId, scope and keyHash are required");
            return;
        }
        TokenProvider.configure(getContext(), clientId, tenantId, scope, keyHash);
        TokenProvider.signIn(getActivity(), (result, error) -> {
            if (result == null) {
                call.reject(error != null ? error.getMessage() : "Sign-in failed");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("idToken", result.getAccount().getIdToken());
            ret.put("username", result.getAccount().getUsername());
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String body = call.getString("body");
        if (id == null || url == null || body == null) {
            call.reject("id, url and body are required");
            return;
        }
        JSObject auth = call.getObject("auth");
        if (auth != null) {
            TokenProvider.configure(getContext(), auth.getString("clientId"), auth.getString("tenantId"),
                    auth.getString("scope"), auth.getString("keyHash"));
        }
        JSObject headers = call.getObject("headers", new JSObject());
        try {
            UploadQueue.enqueue(getContext(), id, url, headers.toString(), body);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        try {
            JSONObject stored = UploadQueue.loadResults(getContext());
            JSArray results = new JSArray();
            for (String id : UploadQueue.keys(stored)) {
                JSONObject r = stored.getJSONObject(id);
                JSObject item = new JSObject();
                item.put("id", id);
                item.put("status", r.getInt("status"));
                item.put("at", r.getLong("at"));
                results.put(item);
            }
            JSArray active = new JSArray();
            for (String id : UploadQueue.activeIds(getContext())) active.put(id);
            JSObject ret = new JSObject();
            ret.put("results", results);
            ret.put("active", active);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void clearResults(PluginCall call) {
        try {
            UploadQueue.clearResults(getContext(), call.getArray("ids", new JSArray()).<String>toList());
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
