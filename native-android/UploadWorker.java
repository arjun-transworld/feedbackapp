package com.transworld.jets.feedback;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Sends one queued record. Runs on a WorkManager background thread, with the
 * app open or not, and only once the device is online (network constraint).
 *
 * A record is never sent without the signed-in user's access token. The token is
 * fetched right before sending; MSAL renews an expired one silently with the refresh
 * token, in the background. A 401 triggers a forced refresh and an immediate resend.
 * If no token can be had, nothing is sent and the record waits for crew to sign in
 * again (reported to JS as 401, "crew sign-in needed").
 */
public class UploadWorker extends Worker {

    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        String id = getInputData().getString("id");
        String url = getInputData().getString("url");
        String headers = getInputData().getString("headers");
        File bodyFile = UploadQueue.bodyFile(c, id);
        if (!bodyFile.exists()) return Result.success(); // already sent

        try {
            byte[] body = UploadQueue.read(bodyFile).getBytes(StandardCharsets.UTF_8);
            String token = TokenProvider.token(c, false);
            if (token == null) return noToken(c, id, bodyFile);
            int status = post(url, headers, body, token);
            for (int i = 0; status == 401 && i < 2; i++) {
                token = TokenProvider.token(c, true);
                if (token == null) return noToken(c, id, bodyFile);
                status = post(url, headers, body, token);
            }

            if (status >= 500 || status == 408 || status == 429) {
                return Result.retry(); // temporary: WorkManager backs off and tries again
            }
            // Final answer (2xx success, or 4xx the JS side decides about, including
            // 401 when the user must sign in again).
            UploadQueue.record(c, id, status);
            bodyFile.delete();
            return Result.success();
        } catch (IOException e) {
            return Result.retry(); // no connection / timeout
        }
    }

    /** No token: don't send. Retry twice (a brief network/MSAL hiccup), then wait for crew to sign in. */
    private Result noToken(Context c, String id, File bodyFile) {
        if (getRunAttemptCount() < 2) return Result.retry();
        UploadQueue.record(c, id, 401);
        bodyFile.delete();
        return Result.success();
    }

    private static int post(String url, String headersJson, byte[] body, String token) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(60_000);
            conn.setReadTimeout(60_000);
            conn.setFixedLengthStreamingMode(body.length);
            try {
                JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String name = it.next();
                    conn.setRequestProperty(name, headers.getString(name));
                }
            } catch (Exception ignored) {
                conn.setRequestProperty("Content-Type", "application/json");
            }
            conn.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }
            return conn.getResponseCode();
        } finally {
            conn.disconnect();
        }
    }
}
