package com.transworld.jets.feedback;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Queues feedback uploads with WorkManager.
 *
 * Android runs each job once the device has network, even if the app is closed
 * or the phone was rebooted, and retries with backoff (15 min, 30 min, ... max 5 h).
 * A "Force stop" from Settings cancels pending jobs until the app is opened again;
 * the JS side then re-queues them.
 */
final class UploadQueue {
    static final String TAG = "feedback-upload";
    private static final Object lock = new Object();

    private UploadQueue() {}

    private static File dir(Context c) {
        File dir = new File(c.getFilesDir(), "PendingUploads");
        dir.mkdirs();
        return dir;
    }

    static File bodyFile(Context c, String id) {
        return new File(dir(c), id + ".json");
    }

    static void enqueue(Context c, String id, String url, String headersJson, String body) throws IOException {
        write(bodyFile(c, id), body);
        Data input = new Data.Builder()
                .putString("id", id)
                .putString("url", url)
                .putString("headers", headersJson)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(UploadWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
                .setInputData(input)
                .addTag(TAG)
                .addTag("id:" + id)
                .build();
        // KEEP: if this record is already queued or running, leave it alone.
        WorkManager.getInstance(c).enqueueUniqueWork("upload-" + id, ExistingWorkPolicy.KEEP, request);
    }

    /** Ids of uploads still waiting or running. Blocking; Capacitor calls plugins off the main thread. */
    static List<String> activeIds(Context c) throws Exception {
        List<String> ids = new ArrayList<>();
        for (WorkInfo info : WorkManager.getInstance(c).getWorkInfosByTag(TAG).get()) {
            if (info.getState().isFinished()) continue;
            for (String tag : info.getTags()) {
                if (tag.startsWith("id:")) ids.add(tag.substring(3));
            }
        }
        return ids;
    }

    // ---- Results store: { id: { status, at } }, read by JS via the plugin ----

    static void record(Context c, String id, int status) {
        synchronized (lock) {
            try {
                JSONObject results = loadResults(c);
                results.put(id, new JSONObject().put("status", status).put("at", System.currentTimeMillis()));
                write(resultsFile(c), results.toString());
            } catch (Exception ignored) {
                // Worst case JS re-queues the record and the server ignores the duplicate.
            }
        }
    }

    static JSONObject loadResults(Context c) {
        synchronized (lock) {
            try {
                return new JSONObject(read(resultsFile(c)));
            } catch (Exception e) {
                return new JSONObject();
            }
        }
    }

    static void clearResults(Context c, List<String> ids) throws IOException {
        synchronized (lock) {
            JSONObject results = loadResults(c);
            for (String id : ids) results.remove(id);
            write(resultsFile(c), results.toString());
        }
    }

    static List<String> keys(JSONObject o) {
        List<String> list = new ArrayList<>();
        for (Iterator<String> it = o.keys(); it.hasNext(); ) list.add(it.next());
        return list;
    }

    // ---- File helpers ----

    private static File resultsFile(Context c) {
        return new File(dir(c), "results.store");
    }

    static String read(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] bytes = new byte[(int) f.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int n = in.read(bytes, offset, bytes.length - offset);
                if (n < 0) break;
                offset += n;
            }
            return new String(bytes, 0, offset, StandardCharsets.UTF_8);
        }
    }

    private static void write(File f, String text) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) throw new IOException("Could not write " + f.getName());
    }
}
