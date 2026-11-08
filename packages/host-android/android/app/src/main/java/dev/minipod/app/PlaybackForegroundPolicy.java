package dev.minipod.app;

import androidx.media3.common.Player;

/**
 * Pure-Java foreground-service / lifecycle rules of `PlaybackService` (bc737679), JVM-tested in
 * `PlaybackForegroundPolicyTest`.
 *
 * <p>Media3 1.5.1 ground truth (`javap -c -p` of `media3-session-1.5.1`):
 * <ul>
 *   <li>`MediaNotificationManager.shouldRunInForeground(session, startInForegroundWhenPaused)` is
 *       `(playWhenReady || startInForegroundWhenPaused) && state in {READY, BUFFERING}`; every
 *       other state makes `updateNotificationInternal` post the notification and call
 *       `stopForeground(false)` (DETACH). A paused, unbound, background-started service is then
 *       stopped by Android (~1 min idle; sooner on ColorOS / OxygenOS) and `onDestroy` →
 *       `removeSession` cancels notification 1001 — "放到后台很快就消失了".</li>
 *   <li>`shouldShowNotification` is `!timeline.isEmpty() && state != IDLE`; otherwise Media3 calls
 *       `stopForeground(true)` (REMOVE), which also removes our bootstrap notification.</li>
 *   <li>`MediaSessionService.onUpdateNotification(session, startInForegroundRequired)` forwards the
 *       flag to `updateNotification` → `updateNotificationInternal`, which calls
 *       `startForeground(...)` when it is `true` (`PlaybackService` overrides it to keep the paused
 *       notification in the foreground for {@link #PAUSED_FOREGROUND_GRACE_MS}).</li>
 *   <li>`isPlaybackOngoing()` is `MediaNotificationManager.isStartedInForeground()` (Media3's own
 *       `startForeground` with its real `MediaStyle` notification).</li>
 * </ul>
 */
public final class PlaybackForegroundPolicy {
    private PlaybackForegroundPolicy() {}

    /**
     * How long a paused / finished episode keeps the media notification (and the
     * `mediaPlayback` foreground service) after playback last ran, so the notification and the
     * headset / Bluetooth Play button keep working while the app is in the background. After it,
     * Media3 detaches the notification and Android may stop the service; resumption then goes
     * through `MediaButtonReceiver` + `onPlaybackResumption` / the System UI resumption card.
     * ExoPlayer holds no wake / Wi-Fi lock while paused, so this costs no battery.
     */
    public static final long PAUSED_FOREGROUND_GRACE_MS = 10L * 60L * 1000L;

    /** `playWhenReady && (READY || BUFFERING)` — Media3's own "must be foreground" condition. */
    public static boolean isActivelyPlaying(boolean playWhenReady, int playbackState) {
        return playWhenReady
            && (playbackState == Player.STATE_READY || playbackState == Player.STATE_BUFFERING);
    }

    /**
     * True while `PlaybackService` should stay a foreground service with its media notification:
     * actively playing, or paused / ended with a loaded episode for less than `graceMs` since
     * playback last ran. Never for an empty or `STATE_IDLE` player (Media3 shows no notification).
     *
     * @param lastActiveElapsedMs `SystemClock.elapsedRealtime()` when playback last ran (`0` = never
     *     in this service instance, e.g. a restored, still unprepared track).
     */
    public static boolean shouldKeepForeground(
        int mediaItemCount,
        int playbackState,
        boolean playWhenReady,
        long lastActiveElapsedMs,
        long nowElapsedMs,
        long graceMs
    ) {
        if (mediaItemCount <= 0 || playbackState == Player.STATE_IDLE) return false;
        if (isActivelyPlaying(playWhenReady, playbackState)) return true;
        if (lastActiveElapsedMs <= 0L) return false;
        long since = nowElapsedMs - lastActiveElapsedMs;
        return since >= 0L && since < graceMs;
    }

    /** Remaining grace (ms) before a paused notification is demoted, `0` when already expired. */
    public static long remainingGraceMs(long lastActiveElapsedMs, long nowElapsedMs, long graceMs) {
        if (lastActiveElapsedMs <= 0L) return 0L;
        long since = Math.max(0L, nowElapsedMs - lastActiveElapsedMs);
        return Math.max(0L, graceMs - since);
    }

    /**
     * `onStartCommand`: post the placeholder foreground notification only for a real start
     * request (`intent != null`: `execute()` / `MediaButtonReceiver` / Media3's own
     * `startForegroundService`) and only when Media3 is not already foreground with its real
     * `MediaStyle` notification — so it never overwrites Media3's notification while playing.
     */
    public static boolean shouldPostBootstrapForeground(boolean hasIntent, boolean media3InForeground) {
        return hasIntent && !media3InForeground;
    }

    /**
     * After a start command was handled (media button dispatched, pending actions drained): stop
     * the service when nothing is loaded at all, so a headset press with nothing to resume never
     * leaves an orphan placeholder notification / foreground service behind.
     */
    public static boolean shouldStopAfterStart(int mediaItemCount) {
        return mediaItemCount <= 0;
    }

    /**
     * `onTaskRemoved` (app swiped from Recents): keep the service — and with it the media
     * notification, lock-screen controls and headset Play — while playing or within the paused
     * grace window; otherwise stop it (Media3's default when nothing is ongoing).
     */
    public static boolean shouldKeepServiceOnTaskRemoved(
        int mediaItemCount,
        int playbackState,
        boolean playWhenReady,
        long lastActiveElapsedMs,
        long nowElapsedMs,
        long graceMs
    ) {
        return shouldKeepForeground(
            mediaItemCount, playbackState, playWhenReady, lastActiveElapsedMs, nowElapsedMs, graceMs);
    }
}
