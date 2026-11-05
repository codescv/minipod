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
        boolean playingAd = false;
        /** Commands the wrapped (unprepared) ExoPlayer reports as available. */
        final java.util.Set<Integer> innerCommands = new java.util.HashSet<>();
        final List<String> calls = new ArrayList<>();
        final List<Player.Listener> added = new ArrayList<>();
        final List<Player.Listener> removed = new ArrayList<>();

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
                        case "getContentPosition":
                            return positionMs;
                        case "isPlayingAd":
                            return playingAd;
                        case "isCommandAvailable":
                            return innerCommands.contains((Integer) args[0]);
                        case "addListener":
                            added.add((Player.Listener) args[0]);
                            return null;
                        case "removeListener":
                            removed.add((Player.Listener) args[0]);
                            return null;
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
        int canRestoreCalls = 0;
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
        public boolean canRestoreTrack() {
            canRestoreCalls++;
            return restorable;
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

    // -------------------------------------------------------------------------
    // Command availability / duration / position for an unprepared (placeholder-timeline) player.
    // `Player.Commands` itself is backed by `android.util.SparseBooleanArray` (stub in JVM tests),
    // so `getAvailableCommands()` is exercised through `isCommandAvailable` + the listener path.
    // -------------------------------------------------------------------------

    @Test
    public void isCommandAvailable_seekCommandsServedForUnpreparedLoadedTrack() {
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE; // placeholder timeline: not seekable
        fake.innerCommands.add(Player.COMMAND_PLAY_PAUSE);
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));

        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM));
        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_BACK));
        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_FORWARD));
        // Everything else is the wrapped player's answer.
        assertTrue(p.isCommandAvailable(Player.COMMAND_PLAY_PAUSE));
        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT));
        assertFalse(p.isCommandAvailable(Player.COMMAND_SET_SPEED_AND_PITCH));
        assertTrue(p.servesSeekCommands());
    }

    @Test
    public void isCommandAvailable_emptyButRestorable_vs_emptyNotRestorable() {
        FakePlayer fake = new FakePlayer();
        fake.mediaItemCount = 0;
        fake.playbackState = Player.STATE_IDLE;
        FakeHost host = new FakeHost(fake);
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_BACK));
        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM));

        host.restorable = true;
        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_BACK));
        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_FORWARD));
        assertTrue(p.isCommandAvailable(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM));
        // The availability check never mutates the player (no restore / prepare / seek).
        assertEquals(0, host.restoreCalls);
        assertTrue(host.canRestoreCalls > 0);
        assertTrue(fake.calls.isEmpty());
        assertEquals(0, fake.mediaItemCount);
    }

    @Test
    public void isCommandAvailable_notAugmentedDuringAds() {
        FakePlayer fake = new FakePlayer();
        fake.playingAd = true;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));
        assertFalse(p.isCommandAvailable(Player.COMMAND_SEEK_BACK));
        assertFalse(p.servesSeekCommands());
    }

    @Test
    public void servedSeekCommands_areExactlySeekInItemBackForward() {
        assertEquals(3, LockScreenSessionPlayer.SEEK_COMMANDS_SERVED_WHEN_LOADED.length);
        assertTrue(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM));
        assertTrue(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_BACK));
        assertTrue(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_FORWARD));
        assertFalse(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_TO_NEXT));
        assertFalse(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_TO_PREVIOUS));
        assertFalse(LockScreenSessionPlayer.isServedSeekCommand(Player.COMMAND_SEEK_TO_MEDIA_ITEM));
    }

    @Test
    public void getDuration_fallsBackToHintWhileUnprepared() {
        FakePlayer fake = new FakePlayer();
        fake.playbackState = Player.STATE_IDLE;
        fake.durationMs = C.TIME_UNSET;
        FakeHost host = new FakeHost(fake);
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        assertEquals(C.TIME_UNSET, p.getDuration());
        host.durationHintMs = 1_800_000L;
        assertEquals(1_800_000L, p.getDuration());
        fake.durationMs = 1_795_000L; // prepared: ExoPlayer's real duration wins
        assertEquals(1_795_000L, p.getDuration());
    }

    @Test
    public void getCurrentPosition_idleZeroFallsBackToLastKnown_otherwiseWrapped() {
        FakePlayer fake = new FakePlayer();
        FakeHost host = new FakeHost(fake);
        host.lastKnownPositionMs = 95_000L;
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), host);

        fake.playbackState = Player.STATE_IDLE;
        fake.positionMs = 0L;
        assertEquals(95_000L, p.getCurrentPosition());
        assertEquals(95_000L, p.getContentPosition());

        fake.positionMs = 42_000L; // restored unprepared: masked start position
        assertEquals(42_000L, p.getCurrentPosition());

        fake.playbackState = Player.STATE_READY;
        fake.positionMs = 0L; // a real (e.g. rewound) 0 while ready is reported as is
        assertEquals(0L, p.getCurrentPosition());
    }

    /** Test double that records what listeners receive as available commands. */
    private static final class RecordingSessionPlayer extends LockScreenSessionPlayer {
        int augmentedQueries = 0;

        RecordingSessionPlayer(Player player, Host host) {
            super(player, host);
        }

        @Override
        Player.Commands availableCommandsForListeners() {
            augmentedQueries++;
            return null; // `Player.Commands` cannot be instantiated in a plain JVM test
        }
    }

    @Test
    public void listeners_getAugmentedCommands_andAllOtherCallbacksForwarded() {
        FakePlayer fake = new FakePlayer();
        RecordingSessionPlayer p = new RecordingSessionPlayer(fake.asPlayer(), new FakeHost(fake));
        final List<String> received = new ArrayList<>();
        Player.Listener session = new Player.Listener() {
            @Override
            public void onAvailableCommandsChanged(Player.Commands availableCommands) {
                received.add("commands:" + availableCommands);
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                received.add("isPlaying:" + isPlaying);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                received.add("state:" + playbackState);
            }

            @Override
            public void onPositionDiscontinuity(
                Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                received.add("discontinuity:" + reason);
            }
        };

        p.addListener(session);
        assertEquals(1, fake.added.size());
        Player.Listener registered = fake.added.get(0);

        registered.onAvailableCommandsChanged(null);
        registered.onIsPlayingChanged(true);
        registered.onPlaybackStateChanged(Player.STATE_READY);
        registered.onPositionDiscontinuity(null, null, Player.DISCONTINUITY_REASON_SEEK);
        registered.onVolumeChanged(0.5f); // default no-op in `session`: must not throw

        assertEquals(1, p.augmentedQueries);
        assertEquals(
            List.of("commands:null", "isPlaying:true", "state:" + Player.STATE_READY,
                "discontinuity:" + Player.DISCONTINUITY_REASON_SEEK),
            received);

        p.removeListener(session);
        assertEquals(1, fake.removed.size());
        assertEquals(registered, fake.removed.get(0));
        assertEquals(registered.hashCode(), fake.removed.get(0).hashCode());
    }

    @Test
    public void listenerWrapper_rethrowsDelegateExceptions() {
        FakePlayer fake = new FakePlayer();
        LockScreenSessionPlayer p = new LockScreenSessionPlayer(fake.asPlayer(), new FakeHost(fake));
        Player.Listener wrapper = p.wrapListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                throw new IllegalStateException("boom");
            }
        });
        try {
            wrapper.onIsPlayingChanged(true);
            org.junit.Assert.fail("expected exception");
        } catch (IllegalStateException expected) {
            assertEquals("boom", expected.getMessage());
        }
        assertTrue(wrapper.equals(wrapper));
        assertFalse(wrapper.equals(p.wrapListener(new Player.Listener() {})));
    }
}
