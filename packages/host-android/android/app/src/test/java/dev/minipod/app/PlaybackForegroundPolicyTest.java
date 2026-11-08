package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.Player;
import org.junit.Test;

/**
 * bc737679: foreground-service / notification retention across play → background → pause →
 * background idle → headset resume, plus `onStartCommand` placeholder and `onTaskRemoved` rules.
 */
public class PlaybackForegroundPolicyTest {

    private static final long GRACE = PlaybackForegroundPolicy.PAUSED_FOREGROUND_GRACE_MS;
    private static final long NOW = 50_000_000L;

    private static boolean keep(int count, int state, boolean pwr, long lastActive, long now) {
        return PlaybackForegroundPolicy.shouldKeepForeground(count, state, pwr, lastActive, now, GRACE);
    }

    @Test
    public void grace_isTenMinutes() {
        assertEquals(10L * 60L * 1000L, GRACE);
    }

    @Test
    public void activelyPlaying_matchesMedia3ShouldRunInForeground() {
        assertTrue(PlaybackForegroundPolicy.isActivelyPlaying(true, Player.STATE_READY));
        assertTrue(PlaybackForegroundPolicy.isActivelyPlaying(true, Player.STATE_BUFFERING));
        assertFalse(PlaybackForegroundPolicy.isActivelyPlaying(true, Player.STATE_IDLE));
        assertFalse(PlaybackForegroundPolicy.isActivelyPlaying(true, Player.STATE_ENDED));
        assertFalse(PlaybackForegroundPolicy.isActivelyPlaying(false, Player.STATE_READY));
    }

    @Test
    public void playing_alwaysForeground_evenWithoutHistory() {
        assertTrue(keep(1, Player.STATE_READY, true, 0L, NOW));
        assertTrue(keep(3, Player.STATE_BUFFERING, true, 0L, NOW));
    }

    @Test
    public void lifecycle_play_background_pause_staysForegroundForGrace_thenDemotes() {
        long pausedAt = NOW;
        // Paused (in-app, notification, headset, noisy unplug, focus loss) right after playing.
        assertTrue(keep(1, Player.STATE_READY, false, pausedAt, pausedAt));
        assertTrue(keep(1, Player.STATE_READY, false, pausedAt, pausedAt + 60_000L)); // > Android's ~1 min idle stop
        assertTrue(keep(1, Player.STATE_READY, false, pausedAt, pausedAt + GRACE - 1L));
        // Grace over: Media3 may detach the notification; MediaButtonReceiver takes over.
        assertFalse(keep(1, Player.STATE_READY, false, pausedAt, pausedAt + GRACE));
        assertEquals(GRACE, PlaybackForegroundPolicy.remainingGraceMs(pausedAt, pausedAt, GRACE));
        assertEquals(GRACE - 60_000L, PlaybackForegroundPolicy.remainingGraceMs(pausedAt, pausedAt + 60_000L, GRACE));
        assertEquals(0L, PlaybackForegroundPolicy.remainingGraceMs(pausedAt, pausedAt + GRACE + 5L, GRACE));
        // Headset resume: actively playing again -> foreground regardless of the old timestamp.
        assertTrue(keep(1, Player.STATE_BUFFERING, true, pausedAt, pausedAt + GRACE * 3));
    }

    @Test
    public void endedEpisode_keepsNotificationDuringGrace() {
        assertTrue(keep(1, Player.STATE_ENDED, true, NOW, NOW + 1_000L));
        assertFalse(keep(1, Player.STATE_ENDED, true, NOW, NOW + GRACE + 1L));
    }

    @Test
    public void neverForeground_forIdleOrEmpty_orRestoredTrackThatNeverPlayed() {
        assertFalse(keep(0, Player.STATE_READY, true, NOW, NOW));
        assertFalse(keep(1, Player.STATE_IDLE, true, NOW, NOW));
        assertFalse(keep(1, Player.STATE_IDLE, false, NOW, NOW));
        // `onCreate` restore (`STATE_IDLE` → prepared paused) without any playback in this instance.
        assertFalse(keep(1, Player.STATE_READY, false, 0L, NOW));
        assertEquals(0L, PlaybackForegroundPolicy.remainingGraceMs(0L, NOW, GRACE));
        // Clock oddities never extend the grace.
        assertFalse(keep(1, Player.STATE_READY, false, NOW + 10L, NOW));
    }

    @Test
    public void bootstrapPlaceholder_onlyForRealStartsWhenMedia3NotForeground() {
        // `execute()` / `MediaButtonReceiver` start while paused / not started: placeholder.
        assertTrue(PlaybackForegroundPolicy.shouldPostBootstrapForeground(true, false));
        // Media3 already foreground with its real notification (incl. its own startSelfIntent):
        // never overwrite it with the action-less placeholder.
        assertFalse(PlaybackForegroundPolicy.shouldPostBootstrapForeground(true, true));
        // START_STICKY restart (null intent) is not a `startForegroundService` start.
        assertFalse(PlaybackForegroundPolicy.shouldPostBootstrapForeground(false, false));
    }

    @Test
    public void afterStart_stopOnlyWhenNothingLoaded() {
        assertTrue(PlaybackForegroundPolicy.shouldStopAfterStart(0));
        assertFalse(PlaybackForegroundPolicy.shouldStopAfterStart(1));
        assertFalse(PlaybackForegroundPolicy.shouldStopAfterStart(5));
    }

    @Test
    public void taskRemoved_keepsServiceWhilePlayingOrWithinPausedGrace() {
        assertTrue(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            1, Player.STATE_READY, true, NOW, NOW, GRACE));
        // Paused a moment ago: notification + headset Play survive the swipe.
        assertTrue(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            1, Player.STATE_READY, false, NOW, NOW + 5_000L, GRACE));
        // Long paused / never played / idle / empty: stop like Media3's default.
        assertFalse(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            1, Player.STATE_READY, false, NOW, NOW + GRACE + 1L, GRACE));
        assertFalse(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            1, Player.STATE_READY, false, 0L, NOW, GRACE));
        assertFalse(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            1, Player.STATE_IDLE, true, NOW, NOW, GRACE));
        assertFalse(PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            0, Player.STATE_IDLE, false, NOW, NOW, GRACE));
    }
}
