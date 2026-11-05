package dev.minipod.app;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;

/**
 * `ForwardingPlayer` handed to the Media3 `MediaSession` (lock screen, notification, System UI,
 * Bluetooth / Wear / Auto controllers). The in-app bridge and the `Player.Listener` keep using
 * the wrapped `ExoPlayer` directly, so playlist auto-advance and the sleep timer are unaffected.
 *
 * <p>Seek requests coming from the session are made robust for a paused / idle / not-yet-prepared
 * player (e.g. a track restored by `restoreLastTrackIfNeeded(false)` after Android stopped the
 * service, or `STATE_IDLE` after a network error):
 * <ul>
 *   <li>an empty player first asks {@link Host#ensureTrackLoaded()} to restore the last track;</li>
 *   <li>an idle player is prepared before seeking;</li>
 *   <li>-10 s / +30 s targets are clamped by {@link LockScreenControls#clampSeekTargetMs} using
 *       the duration hint when ExoPlayer does not know the duration yet;</li>
 *   <li>a 0 ms position reported by an idle player falls back to the last known position, so
 *       "-10 s" from a restored 0:42 lands on 0:32 and not on 0:00;</li>
 *   <li>"+30 s" on an already ended episode is a no-op (it is journaled as completed).</li>
 * </ul>
 * Checkpointing and UI sync happen in `PlaybackService.onPositionDiscontinuity`.
 */
@OptIn(markerClass = UnstableApi.class)
public final class LockScreenSessionPlayer extends ForwardingPlayer {

    /** Service hooks (implemented by `PlaybackService`; faked in JVM unit tests). */
    public interface Host {
        /** Restores the last track into an empty player. Returns true if a track is loaded. */
        boolean ensureTrackLoaded();

        /** Last known position (ms) of the active track, used when an idle player reports 0. */
        long lastKnownPositionMs();

        /** Duration hint (ms, `<= 0` when unknown) used when ExoPlayer has no duration yet. */
        long durationHintMs();
    }

    private final Host host;

    public LockScreenSessionPlayer(Player player, Host host) {
        super(player);
        this.host = host;
    }

    @Override
    public void seekBack() {
        seekBy(-LockScreenControls.SEEK_BACK_MS);
    }

    @Override
    public void seekForward() {
        seekBy(LockScreenControls.SEEK_FORWARD_MS);
    }

    @Override
    public long getSeekBackIncrement() {
        return LockScreenControls.SEEK_BACK_MS;
    }

    @Override
    public long getSeekForwardIncrement() {
        return LockScreenControls.SEEK_FORWARD_MS;
    }

    @Override
    public void seekTo(long positionMs) {
        Player p = getWrappedPlayer();
        if (p.getMediaItemCount() == 0 && !host.ensureTrackLoaded()) return;
        if (p.getMediaItemCount() == 0) return;
        long target = Math.max(0L, positionMs);
        long duration = resolveDurationMs(p);
        if (duration > 0L && target > duration) target = duration;
        prepareIfIdle(p);
        p.seekTo(target);
    }

    /** Relative seek used by the lock-screen buttons, `seekBack()/seekForward()` and media keys. */
    public void seekBy(long deltaMs) {
        Player p = getWrappedPlayer();
        if (p.getMediaItemCount() == 0 && !host.ensureTrackLoaded()) return;
        if (p.getMediaItemCount() == 0) return;
        // A finished episode is already journaled as completed: "+30 s" must not re-end it
        // (duplicate `media-ended` / completion entry). "-10 s" re-opens its last seconds.
        if (p.getPlaybackState() == Player.STATE_ENDED && deltaMs > 0L) return;
        long current = Math.max(0L, p.getCurrentPosition());
        if (p.getPlaybackState() == Player.STATE_IDLE && current == 0L) {
            current = Math.max(0L, host.lastKnownPositionMs());
        }
        long target = LockScreenControls.clampSeekTargetMs(current, deltaMs, resolveDurationMs(p));
        prepareIfIdle(p);
        p.seekTo(target);
    }

    private long resolveDurationMs(Player p) {
        long d = p.getDuration();
        if (d != C.TIME_UNSET && d > 0L) return d;
        long hint = host.durationHintMs();
        return hint > 0L ? hint : C.TIME_UNSET;
    }

    private static void prepareIfIdle(Player p) {
        if (p.getPlaybackState() == Player.STATE_IDLE) {
            p.prepare();
        }
    }
}
