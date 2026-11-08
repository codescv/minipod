package dev.minipod.app;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure-Java (no Android runtime) persistence + resolution of what a <i>headless</i>
 * `PlaybackService` must resume (bc737679): the active episode at its latest checkpoint, its speed /
 * auth headers / duration hint, and the remaining native queue.
 *
 * <p>Used by `PlaybackService.restoreLastTrackIfNeeded` (fresh service after Android stopped it, or
 * after process death, started by `MediaButtonReceiver` for a headset / Bluetooth Play press) and
 * by `MediaSession.Callback.onPlaybackResumption` (System UI resumption card, AVRCP / controller
 * Play on an empty player). Covered by `PlaybackResumptionTest`.
 *
 * <p>Storage (`minipod_playback.xml`): `lastTrack` = full `TrackSpec` JSON (+ `positionMs`,
 * `wallMs`), `current` = latest 1 s / 5 s checkpoint (`episodeKey`, `positionMs`, `durationMs`,
 * `wallMs`, `seeked?`), `lastQueue` = JSON array of queued `TrackSpec`s (`setQueueTracks`),
 * `completed` = append-only finished-episode journal.
 */
public final class PlaybackResumption {
    private PlaybackResumption() {}

    /** Resolved resume target. */
    public static final class Plan {
        public final PlaybackService.TrackSpec spec;
        public final long positionMs;
        /** Best known duration (checkpoint, then spec), `0` when unknown. */
        public final long durationMs;
        public final float speed;
        /** Queued episodes still to play after {@link #spec}, in order (already connectivity-filtered). */
        public final List<PlaybackService.TrackSpec> upcoming;

        Plan(
            PlaybackService.TrackSpec spec,
            long positionMs,
            long durationMs,
            float speed,
            List<PlaybackService.TrackSpec> upcoming
        ) {
            this.spec = spec;
            this.positionMs = Math.max(0L, positionMs);
            this.durationMs = Math.max(0L, durationMs);
            this.speed = speed;
            this.upcoming = Collections.unmodifiableList(new ArrayList<>(upcoming));
        }
    }

    /** Same clamp as `loadTrack` / `setSpeed` (0.5x – 3.0x). */
    public static float clampSpeed(float speed) {
        if (Float.isNaN(speed) || speed <= 0f) return 1.0f;
        return Math.max(0.5f, Math.min(3.0f, speed));
    }

    /**
     * Resolves the resume target from the persisted strings (any may be `null` / corrupt).
     *
     * @param online when `false` (Airplane Mode), remote queued items are dropped exactly like
     *     `setQueueTracks` does, so ExoPlayer never pre-buffers a URL that would fail and drop the
     *     playing local file to `STATE_IDLE`. The active episode itself is always kept.
     * @return `null` when there is nothing to resume (no / corrupt `lastTrack`).
     */
    @Nullable
    public static Plan resolve(
        @Nullable String lastTrackJson,
        @Nullable String currentJson,
        @Nullable String lastQueueJson,
        @Nullable String completedJson,
        boolean online
    ) {
        JSONObject last = parseJson(lastTrackJson);
        PlaybackService.TrackSpec spec = parseTrackSpec(last);
        if (spec == null) return null;

        long positionMs = Math.max(spec.startMs, last.optLong("positionMs", 0L));
        long durationMs = spec.durationMs;
        long lastWallMs = last.optLong("wallMs", 0L);
        JSONObject cur = parseJson(currentJson);
        if (cur != null
            && spec.episodeKey.equals(cur.optString("episodeKey"))
            && cur.optLong("wallMs", 0L) >= lastWallMs) {
            // The 1 s / 5 s checkpoint is newer than `lastTrack`: it wins (incl. a deliberate
            // rewind to 0:00).
            long p = cur.optLong("positionMs", -1L);
            if (p >= 0L) positionMs = p;
            long d = cur.optLong("durationMs", 0L);
            if (d > 0L) durationMs = d;
        }

        List<PlaybackService.TrackSpec> queue = parseQueue(lastQueueJson);
        List<PlaybackService.TrackSpec> upcoming =
            upcomingAfter(queue, spec.episodeKey, completedKeys(completedJson), online);
        return new Plan(spec, positionMs, durationMs, clampSpeed(spec.speed), upcoming);
    }

    /**
     * Items of the persisted queue still to play after `activeKey`: everything after `activeKey`
     * when it is part of the queue (it was auto-advanced into), else the whole queue; never the
     * active episode itself, never an episode already journaled as completed, and (offline) never
     * a remote URL.
     */
    public static List<PlaybackService.TrackSpec> upcomingAfter(
        List<PlaybackService.TrackSpec> queue,
        String activeKey,
        Set<String> completedKeys,
        boolean online
    ) {
        int from = 0;
        for (int i = 0; i < queue.size(); i++) {
            if (queue.get(i).episodeKey.equals(activeKey)) {
                from = i + 1;
                break;
            }
        }
        List<PlaybackService.TrackSpec> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        seen.add(activeKey);
        for (int i = from; i < queue.size(); i++) {
            PlaybackService.TrackSpec s = queue.get(i);
            if (!seen.add(s.episodeKey)) continue;
            if (completedKeys.contains(s.episodeKey)) continue;
            if (!online && !isLocal(s)) continue;
            out.add(s);
        }
        return out;
    }

    public static boolean isLocal(PlaybackService.TrackSpec spec) {
        return "file".equals(spec.sourceKind);
    }

    // -------------------------------------------------------------------------
    // (De)serialization
    // -------------------------------------------------------------------------

    public static JSONObject trackSpecToJson(
        PlaybackService.TrackSpec spec,
        long positionMs,
        long durationMs,
        float speed,
        long wallMs
    ) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("episodeKey", spec.episodeKey);
        o.put("sourceKind", spec.sourceKind);
        o.put("uriOrPath", spec.uriOrPath);
        if (spec.mime != null) o.put("mime", spec.mime);
        JSONObject headers = new JSONObject();
        for (Map.Entry<String, String> e : spec.headers.entrySet()) {
            headers.put(e.getKey(), e.getValue());
        }
        o.put("headers", headers);
        o.put("startMs", Math.max(0L, positionMs));
        o.put("positionMs", Math.max(0L, positionMs));
        o.put("speed", (double) speed);
        o.put("title", spec.title);
        if (spec.artist != null) o.put("artist", spec.artist);
        if (spec.album != null) o.put("album", spec.album);
        if (spec.artworkUrl != null) o.put("artworkUrl", spec.artworkUrl);
        o.put("durationMs", durationMs > 0L ? durationMs : spec.durationMs);
        o.put("wallMs", wallMs);
        return o;
    }

    /** `lastQueue` JSON for `setQueueTracks` items (each keeps its own resume `startMs`). */
    public static String queueToJson(List<PlaybackService.TrackSpec> items) throws JSONException {
        JSONArray arr = new JSONArray();
        for (PlaybackService.TrackSpec s : items) {
            arr.put(trackSpecToJson(s, s.startMs, s.durationMs, s.speed, 0L));
        }
        return arr.toString();
    }

    public static List<PlaybackService.TrackSpec> parseQueue(@Nullable String json) {
        List<PlaybackService.TrackSpec> out = new ArrayList<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                PlaybackService.TrackSpec s = parseTrackSpec(arr.optJSONObject(i));
                if (s != null) out.add(s);
            }
        } catch (JSONException ignored) {
            // corrupt queue: resume the active episode only
        }
        return out;
    }

    public static Set<String> completedKeys(@Nullable String completedJson) {
        Set<String> out = new HashSet<>();
        if (completedJson == null || completedJson.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(completedJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null) {
                    String k = o.optString("episodeKey", "");
                    if (!k.isEmpty()) out.add(k);
                }
            }
        } catch (JSONException ignored) {
            // ignore corrupt journal
        }
        return out;
    }

    @Nullable
    public static PlaybackService.TrackSpec parseTrackSpec(@Nullable JSONObject o) {
        if (o == null) return null;
        String episodeKey = o.optString("episodeKey", "");
        String uriOrPath = o.optString("uriOrPath", "");
        if (episodeKey.isEmpty() || uriOrPath.isEmpty()) return null;
        Map<String, String> headers = new HashMap<>();
        JSONObject h = o.optJSONObject("headers");
        if (h != null) {
            JSONArray names = h.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String k = names.optString(i);
                    headers.put(k, h.optString(k));
                }
            }
        }
        long pos = Math.max(o.optLong("startMs", 0L), o.optLong("positionMs", 0L));
        return new PlaybackService.TrackSpec(
            episodeKey,
            o.optString("sourceKind", "url"),
            uriOrPath,
            optNullableString(o, "mime"),
            headers,
            pos,
            (float) o.optDouble("speed", 1.0),
            o.optString("title", ""),
            optNullableString(o, "artist"),
            optNullableString(o, "album"),
            optNullableString(o, "artworkUrl"),
            o.optLong("durationMs", 0L),
            false
        );
    }

    @Nullable
    public static PlaybackService.TrackSpec parseTrackSpecJson(@Nullable String json) {
        return parseTrackSpec(parseJson(json));
    }

    @Nullable
    public static JSONObject parseJson(@Nullable String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            return new JSONObject(json);
        } catch (JSONException ignored) {
            return null;
        }
    }

    @Nullable
    private static String optNullableString(JSONObject o, String key) {
        return o.has(key) && !o.isNull(key) ? o.optString(key) : null;
    }
}
