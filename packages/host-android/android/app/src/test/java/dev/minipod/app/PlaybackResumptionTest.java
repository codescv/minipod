package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * bc737679: headless resume (headset / Bluetooth Play via `MediaButtonReceiver` after the service
 * was stopped or the process died, System UI resumption → `onPlaybackResumption`). Exercises the
 * exact `minipod_playback.xml` strings `PlaybackService` persists.
 */
public class PlaybackResumptionTest {

    private static final long T0 = 1_700_000_000_000L;

    private static PlaybackService.TrackSpec spec(String key, String kind, String uri, long startMs) {
        Map<String, String> headers = new HashMap<>();
        return new PlaybackService.TrackSpec(
            key, kind, uri, "audio/mpeg", headers, startMs, 1.0f, "Title " + key, "Feed", "Album",
            "https://img.example/" + key + ".jpg", 1_800_000L, true);
    }

    private static PlaybackService.TrackSpec authedSpec(String key, long startMs, float speed) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Basic dXNlcjpwYXNz");
        headers.put("X-Feed-Token", "abc");
        return new PlaybackService.TrackSpec(
            key, "url", "https://private.example/" + key + ".mp3", null, headers, startMs, speed,
            "Private " + key, null, null, null, 2_400_000L, true);
    }

    private static String lastTrack(PlaybackService.TrackSpec s, long posMs, long durMs, float speed, long wallMs)
        throws Exception {
        return PlaybackResumption.trackSpecToJson(s, posMs, durMs, speed, wallMs).toString();
    }

    private static String checkpoint(String key, long posMs, long durMs, long wallMs, boolean seeked) throws Exception {
        JSONObject cur = new JSONObject();
        cur.put("episodeKey", key);
        cur.put("positionMs", posMs);
        if (durMs > 0L) cur.put("durationMs", durMs);
        cur.put("wallMs", wallMs);
        if (seeked) cur.put("seeked", true);
        return cur.toString();
    }

    @Test
    public void resolve_nothingPersisted_orCorrupt_returnsNull() {
        assertNull(PlaybackResumption.resolve(null, null, null, null, true));
        assertNull(PlaybackResumption.resolve("", "", "", "", true));
        assertNull(PlaybackResumption.resolve("{not json", null, "[", "{", true));
        assertNull(PlaybackResumption.resolve("{\"episodeKey\":\"\",\"uriOrPath\":\"x\"}", null, null, null, true));
    }

    @Test
    public void resolve_restoresActiveTrackAtLatestCheckpoint_withSpeedHeadersAndDuration() throws Exception {
        PlaybackService.TrackSpec a = authedSpec("ep-a", 0L, 1.0f);
        String last = lastTrack(a, 600_000L, 0L, 1.75f, T0);
        // Newer 5 s checkpoint (KEY_CURRENT) wins over `lastTrack`.
        String cur = checkpoint("ep-a", 754_321L, 2_399_000L, T0 + 5_000L, false);

        PlaybackResumption.Plan plan = PlaybackResumption.resolve(last, cur, null, null, true);

        assertNotNull(plan);
        assertEquals("ep-a", plan.spec.episodeKey);
        assertEquals(754_321L, plan.positionMs);
        assertEquals(2_399_000L, plan.durationMs);
        assertEquals(1.75f, plan.speed, 0.0001f);
        assertEquals("https://private.example/ep-a.mp3", plan.spec.uriOrPath);
        assertEquals("url", plan.spec.sourceKind);
        assertEquals("Basic dXNlcjpwYXNz", plan.spec.headers.get("Authorization"));
        assertEquals("abc", plan.spec.headers.get("X-Feed-Token"));
        assertEquals("Private ep-a", plan.spec.title);
        assertTrue(plan.upcoming.isEmpty());
    }

    @Test
    public void resolve_olderOrForeignCheckpointIsIgnored() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "url", "https://x/a.mp3", 0L);
        String last = lastTrack(a, 420_000L, 1_800_000L, 1.0f, T0);

        PlaybackResumption.Plan older =
            PlaybackResumption.resolve(last, checkpoint("ep-a", 10_000L, 0L, T0 - 1L, false), null, null, true);
        assertEquals(420_000L, older.positionMs);

        PlaybackResumption.Plan foreign =
            PlaybackResumption.resolve(last, checkpoint("ep-b", 10_000L, 0L, T0 + 9L, false), null, null, true);
        assertEquals(420_000L, foreign.positionMs);
        assertEquals(1_800_000L, foreign.durationMs);
    }

    @Test
    public void resolve_deliberateSeekToZeroCheckpoint_resumesAtZero() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "url", "https://x/a.mp3", 0L);
        String last = lastTrack(a, 8_000L, 0L, 1.0f, T0);
        PlaybackResumption.Plan plan =
            PlaybackResumption.resolve(last, checkpoint("ep-a", 0L, 0L, T0 + 1L, true), null, null, true);
        assertEquals(0L, plan.positionMs);
    }

    @Test
    public void resolve_speedIsClamped() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "file", "/data/a.mp3", 0L);
        assertEquals(3.0f, PlaybackResumption.resolve(lastTrack(a, 1L, 0L, 9f, T0), null, null, null, true).speed, 0f);
        assertEquals(0.5f, PlaybackResumption.resolve(lastTrack(a, 1L, 0L, 0.1f, T0), null, null, null, true).speed, 0f);
        assertEquals(1.0f, PlaybackResumption.clampSpeed(Float.NaN), 0f);
    }

    @Test
    public void resolve_restoresRemainingQueue_withStartsAndDurationHints() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "url", "https://x/a.mp3", 0L);
        PlaybackService.TrackSpec b = spec("ep-b", "url", "https://x/b.mp3", 90_000L);
        PlaybackService.TrackSpec c = authedSpec("ep-c", 0L, 1.0f);
        String queue = PlaybackResumption.queueToJson(List.of(b, c));

        PlaybackResumption.Plan plan =
            PlaybackResumption.resolve(lastTrack(a, 5_000L, 0L, 1.0f, T0), null, queue, null, true);

        assertEquals(2, plan.upcoming.size());
        assertEquals("ep-b", plan.upcoming.get(0).episodeKey);
        assertEquals(90_000L, plan.upcoming.get(0).startMs);
        assertEquals(1_800_000L, plan.upcoming.get(0).durationMs);
        assertEquals("ep-c", plan.upcoming.get(1).episodeKey);
        assertEquals("Basic dXNlcjpwYXNz", plan.upcoming.get(1).headers.get("Authorization"));
    }

    @Test
    public void resolve_afterAutoAdvance_onlyItemsAfterActive_andNeverCompletedOnes() throws Exception {
        PlaybackService.TrackSpec b = spec("ep-b", "url", "https://x/b.mp3", 0L);
        PlaybackService.TrackSpec c = spec("ep-c", "url", "https://x/c.mp3", 0L);
        PlaybackService.TrackSpec d = spec("ep-d", "url", "https://x/d.mp3", 0L);
        PlaybackService.TrackSpec e = spec("ep-e", "url", "https://x/e.mp3", 0L);
        String queue = PlaybackResumption.queueToJson(List.of(b, c, d, e));
        JSONArray completed = new JSONArray();
        completed.put(new JSONObject().put("episodeKey", "ep-b").put("endedWallMs", T0));
        completed.put(new JSONObject().put("episodeKey", "ep-e").put("endedWallMs", T0));

        // Native marathon advanced into ep-c (now `lastTrack`).
        PlaybackResumption.Plan plan = PlaybackResumption.resolve(
            lastTrack(c, 1_000L, 0L, 1.0f, T0), null, queue, completed.toString(), true);

        assertEquals(1, plan.upcoming.size());
        assertEquals("ep-d", plan.upcoming.get(0).episodeKey);
    }

    @Test
    public void resolve_offline_dropsRemoteQueueItems_keepsLocalOnesAndActiveRemote() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "url", "https://x/a.mp3", 0L);
        PlaybackService.TrackSpec local1 = spec("ep-l1", "file", "/storage/l1.mp3", 0L);
        PlaybackService.TrackSpec remote = spec("ep-r", "url", "https://x/r.mp3", 0L);
        PlaybackService.TrackSpec local2 = spec("ep-l2", "file", "content://dl/l2", 0L);
        String queue = PlaybackResumption.queueToJson(List.of(local1, remote, local2));

        PlaybackResumption.Plan offline =
            PlaybackResumption.resolve(lastTrack(a, 0L, 0L, 1.0f, T0), null, queue, null, false);
        assertEquals("ep-a", offline.spec.episodeKey);
        assertEquals(2, offline.upcoming.size());
        assertEquals("ep-l1", offline.upcoming.get(0).episodeKey);
        assertEquals("ep-l2", offline.upcoming.get(1).episodeKey);

        PlaybackResumption.Plan online =
            PlaybackResumption.resolve(lastTrack(a, 0L, 0L, 1.0f, T0), null, queue, null, true);
        assertEquals(3, online.upcoming.size());
    }

    @Test
    public void upcomingAfter_skipsActiveAndDuplicates_whenActiveNotInQueue() {
        PlaybackService.TrackSpec a = spec("ep-a", "url", "u", 0L);
        PlaybackService.TrackSpec b = spec("ep-b", "url", "u", 0L);
        List<PlaybackService.TrackSpec> queue = new ArrayList<>(List.of(b, a, b));
        // Active ep-a sits in the middle: only what follows it.
        assertEquals(List.of(b), PlaybackResumption.upcomingAfter(queue, "ep-a", Collections.emptySet(), true));
        // Active not queued: whole queue, de-duplicated.
        assertEquals(List.of(b, a),
            PlaybackResumption.upcomingAfter(queue, "ep-z", new HashSet<>(), true));
    }

    @Test
    public void queue_roundTripsEverySpecField() throws Exception {
        PlaybackService.TrackSpec c = authedSpec("ep-c", 33_000L, 1.25f);
        List<PlaybackService.TrackSpec> parsed =
            PlaybackResumption.parseQueue(PlaybackResumption.queueToJson(List.of(c)));
        assertEquals(1, parsed.size());
        PlaybackService.TrackSpec p = parsed.get(0);
        assertEquals(c.episodeKey, p.episodeKey);
        assertEquals(c.sourceKind, p.sourceKind);
        assertEquals(c.uriOrPath, p.uriOrPath);
        assertEquals(c.headers, p.headers);
        assertEquals(33_000L, p.startMs);
        assertEquals(1.25f, p.speed, 0.0001f);
        assertEquals(c.title, p.title);
        assertNull(p.mime);
        assertNull(p.artist);
        assertEquals(2_400_000L, p.durationMs);
        assertTrue(PlaybackResumption.parseQueue("garbage").isEmpty());
        assertTrue(PlaybackResumption.parseQueue(null).isEmpty());
    }

    @Test
    public void completedKeys_parsesJournal_ignoresGarbage() throws Exception {
        JSONArray completed = new JSONArray();
        completed.put(new JSONObject().put("episodeKey", "x").put("endedWallMs", 1));
        completed.put(new JSONObject().put("durationMs", 5));
        assertEquals(Collections.singleton("x"), PlaybackResumption.completedKeys(completed.toString()));
        assertTrue(PlaybackResumption.completedKeys("{").isEmpty());
    }

    @Test
    public void lastTrackJson_keepsStartAndPositionInSync_andParsesBack() throws Exception {
        PlaybackService.TrackSpec a = spec("ep-a", "file", "/data/a.mp3", 0L);
        JSONObject json = PlaybackResumption.trackSpecToJson(a, 77_000L, 0L, 1.5f, T0);
        assertEquals(77_000L, json.getLong("startMs"));
        assertEquals(77_000L, json.getLong("positionMs"));
        assertEquals(1_800_000L, json.getLong("durationMs")); // falls back to the spec duration
        assertEquals(T0, json.getLong("wallMs"));
        PlaybackService.TrackSpec back = PlaybackResumption.parseTrackSpecJson(json.toString());
        assertEquals(77_000L, back.startMs);
        assertEquals("audio/mpeg", back.mime);
        assertEquals("Feed", back.artist);
        assertEquals(false, back.playWhenReady);
    }
}
