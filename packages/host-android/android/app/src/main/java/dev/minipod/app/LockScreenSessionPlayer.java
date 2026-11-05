package dev.minipod.app;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.IdentityHashMap;
import java.util.Map;

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
 *
 * <p>Command availability (verified against Media3 1.5.1 bytecode): an unprepared / idle ExoPlayer
 * exposes a `MaskingMediaSource.PlaceholderTimeline` whose window is not seekable, so
 * `Util.getAvailableCommands` drops `COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM`, `COMMAND_SEEK_BACK` and
 * `COMMAND_SEEK_FORWARD`. `PlayerWrapper` intersects with those commands (platform `PlaybackState`
 * would lose `ACTION_SEEK_TO` / `ACTION_REWIND` / `ACTION_FAST_FORWARD`, locking the System UI
 * seekbar) and `ConnectedControllersManager` silently drops such seeks before they reach this
 * player. Since every seek here prepares the player first, those commands are advertised whenever
 * a track is loaded or restorable ({@link #getAvailableCommands()},
 * {@link #isCommandAvailable(int)}, and `onAvailableCommandsChanged` via wrapped listeners), and
 * {@link #getDuration()} / {@link #getCurrentPosition()} fall back to the duration hint / last
 * known position so the lock-screen seekbar has a range and a thumb position.
 *
 * Checkpointing and UI sync happen in `PlaybackService.onPositionDiscontinuity`.
 */
@OptIn(markerClass = UnstableApi.class)
public class LockScreenSessionPlayer extends ForwardingPlayer {

    /** Service hooks (implemented by `PlaybackService`; faked in JVM unit tests). */
    public interface Host {
        /** Restores the last track into an empty player. Returns true if a track is loaded. */
        boolean ensureTrackLoaded();

        /** Non-mutating: true if {@link #ensureTrackLoaded()} could restore a track. */
        boolean canRestoreTrack();

        /** Last known position (ms) of the active track, used when an idle player reports 0. */
        long lastKnownPositionMs();

        /** Duration hint (ms, `<= 0` when unknown) used when ExoPlayer has no duration yet. */
        long durationHintMs();
    }

    /** Commands this wrapper can always serve (it prepares / restores before seeking). */
    public static final int[] SEEK_COMMANDS_SERVED_WHEN_LOADED = {
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
        Player.COMMAND_SEEK_BACK,
        Player.COMMAND_SEEK_FORWARD,
    };

    private final Host host;
    /** Session listener -> wrapper that reports this player's (augmented) available commands. */
    private final Map<Player.Listener, Player.Listener> listenerWrappers = new IdentityHashMap<>();

    public LockScreenSessionPlayer(Player player, Host host) {
        super(player);
        this.host = host;
    }

    // -------------------------------------------------------------------------
    // Command availability
    // -------------------------------------------------------------------------

    /** True when the seek commands are served even though the wrapped player may not list them. */
    public boolean servesSeekCommands() {
        Player p = getWrappedPlayer();
        if (p.isPlayingAd()) return false;
        return p.getMediaItemCount() > 0 || host.canRestoreTrack();
    }

    static boolean isServedSeekCommand(int command) {
        for (int c : SEEK_COMMANDS_SERVED_WHEN_LOADED) {
            if (c == command) return true;
        }
        return false;
    }

    @Override
    public boolean isCommandAvailable(int command) {
        if (isServedSeekCommand(command) && servesSeekCommands()) return true;
        return super.isCommandAvailable(command);
    }

    @Override
    public Player.Commands getAvailableCommands() {
        Player.Commands base = super.getAvailableCommands();
        if (!servesSeekCommands()) return base;
        boolean missing = false;
        for (int c : SEEK_COMMANDS_SERVED_WHEN_LOADED) {
            if (!base.contains(c)) {
                missing = true;
                break;
            }
        }
        if (!missing) return base;
        return base.buildUpon().addAll(SEEK_COMMANDS_SERVED_WHEN_LOADED).build();
    }

    @Override
    public void addListener(Player.Listener listener) {
        Player.Listener wrapper = wrapListener(listener);
        synchronized (listenerWrappers) {
            listenerWrappers.put(listener, wrapper);
        }
        super.addListener(wrapper);
    }

    @Override
    public void removeListener(Player.Listener listener) {
        Player.Listener wrapper;
        synchronized (listenerWrappers) {
            wrapper = listenerWrappers.remove(listener);
        }
        super.removeListener(wrapper != null ? wrapper : listener);
    }

    /** Overridable for tests: the commands passed to `onAvailableCommandsChanged` listeners. */
    @Nullable
    Player.Commands availableCommandsForListeners() {
        return getAvailableCommands();
    }

    /**
     * Wraps a session listener so `onAvailableCommandsChanged` carries {@link
     * #getAvailableCommands()} (Media3 forwards that argument to connected controllers) while every
     * other callback (37 in Media3 1.5.1, incl. future ones) is forwarded unchanged.
     */
    Player.Listener wrapListener(Player.Listener delegate) {
        InvocationHandler handler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                String name = method.getName();
                if (method.getDeclaringClass() == Object.class) {
                    switch (name) {
                        case "equals":
                            return proxy == args[0];
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        default:
                            return "LockScreenSessionPlayer.Listener(" + delegate + ")";
                    }
                }
                if ("onAvailableCommandsChanged".equals(name) && args != null && args.length == 1) {
                    delegate.onAvailableCommandsChanged(availableCommandsForListeners());
                    return null;
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause() != null ? e.getCause() : e;
                }
            }
        };
        return (Player.Listener) Proxy.newProxyInstance(
            Player.Listener.class.getClassLoader(),
            new Class<?>[] {Player.Listener.class},
            handler
        );
    }

    // -------------------------------------------------------------------------
    // Duration / position fallbacks (lock-screen seekbar range + thumb while idle)
    // -------------------------------------------------------------------------

    @Override
    public long getDuration() {
        return resolveDurationMs(getWrappedPlayer());
    }

    @Override
    public long getCurrentPosition() {
        Player p = getWrappedPlayer();
        long pos = p.getCurrentPosition();
        if ((p.getPlaybackState() == Player.STATE_IDLE || p.getMediaItemCount() == 0) && pos <= 0L) {
            return Math.max(0L, host.lastKnownPositionMs());
        }
        return Math.max(0L, pos);
    }

    @Override
    public long getContentPosition() {
        Player p = getWrappedPlayer();
        if (p.isPlayingAd()) return p.getContentPosition();
        return getCurrentPosition();
    }

    // -------------------------------------------------------------------------
    // Seeking
    // -------------------------------------------------------------------------

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
