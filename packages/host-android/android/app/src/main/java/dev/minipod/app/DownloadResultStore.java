package dev.minipod.app;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Persisted journal of terminal native download results (`DONE {path}` / `FAILED`) that the
 * WebView has not acknowledged yet (pure Java + org.json, JVM-unit-testable).
 *
 * <p>Downloads keep running natively while the WebView is frozen in the background, reloaded, or
 * recreated. On `visibilitychange` / cold reconnect `capacitor-host.ts` reads
 * {@link #list()} through `getDownloadSnapshot`, applies the results to IndexedDB, then
 * acks them ({@link #ack}). Bounded to {@link #MAX_ENTRIES} (oldest dropped).
 */
final class DownloadResultStore {

    /** Minimal string key/value persistence (Android: `SharedPreferences`). */
    interface Storage {
        String read();

        void write(String value);
    }

    static final int MAX_ENTRIES = 200;

    static final class Entry {
        final String episodeKey;
        /** "DONE" or "FAILED". */
        final String state;
        final String path;
        final long size;
        final String mime;
        final String errorCode;
        final String errorMessage;
        final long updatedWallMs;

        Entry(
            String episodeKey,
            String state,
            String path,
            long size,
            String mime,
            String errorCode,
            String errorMessage,
            long updatedWallMs
        ) {
            this.episodeKey = episodeKey;
            this.state = state;
            this.path = path;
            this.size = size;
            this.mime = mime;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
            this.updatedWallMs = updatedWallMs;
        }

        static Entry done(String key, String path, long size, String mime, long now) {
            return new Entry(key, "DONE", path, size, mime, null, null, now);
        }

        static Entry failed(String key, String code, String message, long now) {
            return new Entry(key, "FAILED", null, -1L, null, code, message, now);
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("episodeKey", episodeKey);
            o.put("state", state);
            if (path != null) o.put("path", path);
            if (size >= 0L) o.put("size", size);
            if (mime != null) o.put("mime", mime);
            if (errorCode != null || errorMessage != null) {
                JSONObject err = new JSONObject();
                err.put("code", errorCode != null ? errorCode : "network");
                err.put("message", errorMessage != null ? errorMessage : "Episode download failed");
                o.put("error", err);
            }
            o.put("updatedWallMs", updatedWallMs);
            return o;
        }

        static Entry fromJson(JSONObject o) {
            String key = o.optString("episodeKey", "");
            String state = o.optString("state", "");
            if (key.isEmpty() || !("DONE".equals(state) || "FAILED".equals(state))) return null;
            JSONObject err = o.optJSONObject("error");
            return new Entry(
                key,
                state,
                o.has("path") ? o.optString("path", null) : null,
                o.optLong("size", -1L),
                o.has("mime") ? o.optString("mime", null) : null,
                err != null ? err.optString("code", "network") : null,
                err != null ? err.optString("message", "") : null,
                o.optLong("updatedWallMs", 0L)
            );
        }
    }

    private final Storage storage;
    private final Object lock = new Object();

    DownloadResultStore(Storage storage) {
        this.storage = storage;
    }

    void put(Entry entry) {
        synchronized (lock) {
            JSONObject all = readLocked();
            all.remove(entry.episodeKey);
            try {
                all.put(entry.episodeKey, entry.toJson());
            } catch (JSONException e) {
                return;
            }
            trimLocked(all);
            storage.write(all.toString());
        }
    }

    /** Drops any terminal record for {@code key} (new download started / user cancelled). */
    void remove(String key) {
        synchronized (lock) {
            JSONObject all = readLocked();
            if (all.remove(key) != null) storage.write(all.toString());
        }
    }

    void ack(List<String> keys) {
        if (keys == null || keys.isEmpty()) return;
        synchronized (lock) {
            JSONObject all = readLocked();
            boolean changed = false;
            for (String k : keys) {
                if (k != null && all.remove(k) != null) changed = true;
            }
            if (changed) storage.write(all.toString());
        }
    }

    List<Entry> list() {
        synchronized (lock) {
            JSONObject all = readLocked();
            List<Entry> out = new ArrayList<>();
            for (Iterator<String> it = all.keys(); it.hasNext(); ) {
                JSONObject o = all.optJSONObject(it.next());
                if (o == null) continue;
                Entry e = Entry.fromJson(o);
                if (e != null) out.add(e);
            }
            out.sort((a, b) -> Long.compare(a.updatedWallMs, b.updatedWallMs));
            return out;
        }
    }

    private JSONObject readLocked() {
        String raw = null;
        try {
            raw = storage.read();
        } catch (RuntimeException ignored) {
            // treat as empty
        }
        if (raw == null || raw.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private void trimLocked(JSONObject all) {
        while (all.length() > MAX_ENTRIES) {
            String oldestKey = null;
            long oldest = Long.MAX_VALUE;
            for (Iterator<String> it = all.keys(); it.hasNext(); ) {
                String k = it.next();
                JSONObject o = all.optJSONObject(k);
                long t = o != null ? o.optLong("updatedWallMs", 0L) : 0L;
                if (t < oldest) {
                    oldest = t;
                    oldestKey = k;
                }
            }
            if (oldestKey == null) return;
            all.remove(oldestKey);
        }
    }
}
