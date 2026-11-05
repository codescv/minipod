package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.Player;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * `LockScreenSessionPlayer` (session-facing `ForwardingPlayer`): -10 s / +30 s clamping and
 * paused / idle / unprepared handling, against a reflective fake `Player` (no Android runtime).
 */
public class LockScreenSessionPlayerTest {

    /** Minimal mutable fake of the wrapped ExoPlayer; records calls. */
    private static final class FakePlayer {
        int mediaItemCount = 1;
        int playbackState = Player.STATE_READY;
        long positionMs = 0L;
        long durationMs = C.TIME_UNSET;
        boolean playWhenReady = false;
        final List<String> calls = new ArrayList<>();

        Player asPlayer() {
            return (Player) Proxy.newProxyInstance(
                Player.class.getClassLoader(),
                new Class<?>[] {Player.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getMediaItemCount":
                            return mediaItemCount;
                        case "getPlaybackState":
                            return playbackState;
                        case "getCurrentPosition":
                            return positionMs;
                        case "getDuration":
                            return durationMs;
                        case "getPlayWhenReady":
                            return playWhenReady;
                        case "isPlaying":
                            return playWhenReady && playbackState == Player.STATE_READY;
                        case "prepare":
                            calls.add("prepare");
                            if (playbackState == Player.STATE_IDLE) playbackState = Player.STATE_BUFFERING;
                            return null;
                        case "seekTo":
                            if (args != null && args.length == 1) {
                                positionMs = (Long) args[0];
                                calls.add("seekTo:" + positionMs);
                                return null;
                            }
                            calls.add("seekTo:" + args[0] + ":" + args[1]);
                            return null;
                        case "seekToNext":
                        case "seekToPrevious":
                        case "seekToNextMediaItem":
                        case "seekToPreviousMediaItem":
                        case "play":
                        case "pause":
                            calls.add(method.getName());
                            return null;
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        case "equals":
                            return proxy == args[0];
                        case "toString":
                            return "FakePlayer";
                        default:
                            throw new UnsupportedOperationException(method.getName());
                    }
                }
            );
        }
    }

    private static final class FakeHost implements LockScreenSessionPlayer.Host {
        final FakePlayer fake;
        boolean restorable = false;
        long restoredPositionMs = 0L;
        long lastKnownPositionMs = 0L;
        long durationHintMs = 0L;
        int restoreCalls = 0;

        FakeHost(FakePlayer fake) {
            this.fake = fake;
        }

        @Override
        public boolean ensureTrackLoaded() {
            restoreCalls++;
            if (restorable && fake.mediaItemCount == 0) {
                fake.mediaItemCount = 1;
                fake.positionMs = restoredPositionMs;
                fake.playbackState = Player.STATE_BUFFERING; // restoreLastTrackIfNeeded(true) prepares
                fake.calls.add("restore");
            }
            return fake.mediaItemCount > 0;
        }

        @Override
        public long lastKnownPositionMs() {
            return lastKnownPositionMs;
        }

        @Override
        public long durationHintMs() {
            return durationHintMs;
        }
    }

    @Test
    public void seekBack_whilePlaying_rewinds10s() {
        FakePlayer fake = new FakePlayer();
        fake.playWhenReady = true;
        fake.positionMs = 42_000L;
        fake.durationMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        p.seekBack();

        assertEquals(32_000L, fake.positionMs);
        assertFalse(fake.calls.contains("prepare"));
        assertFalse(fake.calls.contains("play"));
    }

    @Test
    public void seekBack_whilePaused_at6s_rewindsTo0_andStaysPaused() {
        FakePlayer fake = new FakePlayer();
        fake.positionMs = 6_000L;
        fake.durationMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        p.seekBack();

        assertEquals(0L, fake.positionMs);
        assertFalse(fake.calls.contains("play"));
        assertFalse(fake.playWhenReady);
    }

    @Test
    public void seekForward_advances30s_andClampsToDurationNearTheEnd() {
        FakePlayer fake = new FakePlayer();
        fake.positionMs = 42_000L;
        fake.durationMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        p.seekForward();
        assertEquals(72_000L, fake.positionMs);

        fake.positionMs = 590_000L;
        p.seekForward();
        assertEquals(600_000L, fake.positionMs);
    }

    @Test
    public void seekForward_onEndedEpisode_isNoOp_butSeekBackReopensIt() {
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_ENDED;
        fake.positionMs = 600_000L;
        fake.durationMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        p.seekForward();
        assertTrue(fake.calls.isEmpty());

        p.seekBack();
        assertEquals(590_000L, fake.positionMs);
    }

    @Test
    public void seekBy_onIdleUnpreparedTrack_preparesThenSeeksFromMaskedPosition() {
        // restoreLastTrackIfNeeded(false): media item set at 0:42, not prepared, duration unknown.
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE;
        fake.positionMs = 42_000L;
        FakeHost host = new FakeHost(fake);
        host.durationHintMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        p.seekBack();

        assertEquals(List.of("prepare", "seekTo:32000"), fake.calls);
        assertEquals(0, host.restoreCalls);
    }

    @Test
    public void seekBy_onIdlePlayerReportingZero_usesLastKnownPosition() {
        // STATE_IDLE after a playback error may report 0 while the paused position was 1:35.
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE;
        fake.positionMs = 0L;
        FakeHost host = new FakeHost(fake);
        host.lastKnownPositionMs = 95_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        p.seekForward();

        assertEquals(List.of("prepare", "seekTo:125000"), fake.calls);
    }

    @Test
    public void seekForward_usesDurationHintWhenExoPlayerHasNoDurationYet() {
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE;
        fake.positionMs = 590_000L;
        FakeHost host = new FakeHost(fake);
        host.durationHintMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        p.seekForward();

        assertEquals(600_000L, fake.positionMs);
    }

    @Test
    public void seekBy_onEmptyPlayer_restoresLastTrackFirst() {
        FakePlayer fake = new FakePlayer();
        fake.mediaItemCount = 0;
        fake.playbackState = Player.STATE_IDLE;
        FakeHost host = new FakeHost(fake);
        host.restorable = true;
        host.restoredPositionMs = 42_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        p.seekBack();

        assertEquals(1, host.restoreCalls);
        assertEquals(List.of("restore", "seekTo:32000"), fake.calls);
    }

    @Test
    public void seekBy_onEmptyPlayerWithNothingToRestore_isNoOp() {
        FakePlayer fake = new FakePlayer();
        fake.mediaItemCount = 0;
        fake.playbackState = Player.STATE_IDLE;
        FakeHost host = new FakeHost(fake);
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        p.seekForward();
        p.seekTo(10_000L);

        assertEquals(2, host.restoreCalls);
        assertTrue(fake.calls.isEmpty());
    }

    @Test
    public void seekTo_fromLockScreenSeekbar_clampsAndPreparesIdlePlayer() {
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE;
        fake.durationMs = 600_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        p.seekTo(-500L);
        assertEquals(List.of("prepare", "seekTo:0"), fake.calls);

        fake.calls.clear();
        p.seekTo(700_000L);
        assertEquals(List.of("seekTo:600000"), fake.calls);
    }

    @Test
    public void increments_reportCoreSkipValues() {
        FakePlayer fake = new FakePlayer();
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));
        assertEquals(10_000L, p.getSeekBackIncrement());
        assertEquals(30_000L, p.getSeekForwardIncrement());
    }

    @Test
    public void trackSkipCalls_stillReachExoPlayer_soQueueAutoAdvanceIsUntouched() {
        // The wrapper only customizes seeking; queue navigation (and ExoPlayer's own autonomous
        // auto-advance, which never goes through the session) is forwarded unchanged.
        FakePlayer fake = new FakePlayer();
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));
        p.seekToNext();
        p.seekToPrevious();
        assertEquals(List.of("seekToNext", "seekToPrevious"), fake.calls);
    }
}
