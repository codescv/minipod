package dev.minipod.app;

import android.content.Context;
import android.os.Bundle;
import android.view.KeyEvent;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.annotation.StringRes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import com.google.common.collect.ImmutableList;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Lock-screen / notification / System UI media controls for `PlaybackService`:
 * <b>Rewind -10 s</b> | Play/Pause | <b>Fast-forward +30 s</b> (matching `@minipod/core`
 * `SKIP_BACK_MS` / `SKIP_FORWARD_MS`).
 *
 * <p>Verified against the Media3 {@code 1.5.1} bytecode ({@code javap -c -p}):
 * <ul>
 *   <li>{@code DefaultMediaNotificationProvider.getMediaButtons} only copies custom-layout buttons
 *       whose {@code sessionCommand.commandCode == COMMAND_CODE_CUSTOM}; a button built with
 *       {@code setPlayerCommand(COMMAND_SEEK_BACK)} is silently dropped.</li>
 *   <li>{@code PlayerWrapper.createPlaybackStateCompat} likewise only turns enabled
 *       {@code COMMAND_CODE_CUSTOM} buttons into platform {@code PlaybackState.CustomAction}s, which
 *       is what Android 13+ System UI ({@code MediaControlPanel}) renders next to Play/Pause.</li>
 *   <li>{@code CommandButton.Builder.build} rejects a button that sets both a session and a player
 *       command, so the buttons use custom {@link SessionCommand}s ({@link #ACTION_SEEK_BACK},
 *       {@link #ACTION_SEEK_FORWARD}) handled by {@code MediaSession.Callback.onCustomCommand}.</li>
 *   <li>Android 13+ System UI fills its prev/next slots with {@code ACTION_SKIP_TO_PREVIOUS/NEXT}
 *       when present in the platform {@code PlaybackState} actions; only when they are absent (and
 *       the slot is not reserved via {@code EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_PREV/NEXT}) does it
 *       put the 1st / 2nd custom action there. Media3 1.5.1 derives those actions from the
 *       intersection of the player's commands and the commands granted to the media notification
 *       controller in {@code onConnect} ({@code setAvailableFrameworkControllerCommands}), so the
 *       queue track-skip commands ({@link #HIDDEN_SYSTEM_UI_PLAYER_COMMANDS}) are withheld from that
 *       controller only. ExoPlayer itself is untouched, so autonomous playlist auto-advance keeps
 *       working with the screen off.</li>
 *   <li>Media3 1.5.1 never sets the slot-reservation session extras by itself; they are set to
 *       {@code false} explicitly ({@link #slotReservationFlags()}).</li>
 * </ul>
 *
 * <p>The pure-Java parts (specs, clamping, key mapping) are covered by JVM unit tests; the
 * Android/Media3 object builders below them are thin glue.
 */
@OptIn(markerClass = UnstableApi.class)
public final class LockScreenControls {
    private LockScreenControls() {}

    /** Matches `@minipod/core` `SKIP_BACK_MS`. */
    public static final long SEEK_BACK_MS = 10_000L;
    /** Matches `@minipod/core` `SKIP_FORWARD_MS`. */
    public static final long SEEK_FORWARD_MS = 30_000L;

    public static final String ACTION_SEEK_BACK = "dev.minipod.app.session.SEEK_BACK_10";
    public static final String ACTION_SEEK_FORWARD = "dev.minipod.app.session.SEEK_FORWARD_30";

    /** Collapsed `MediaStyle` (compact view, Android 12 and below) positions. */
    public static final int COMPACT_INDEX_REWIND = 0;
    public static final int COMPACT_INDEX_PLAY_PAUSE = 1;
    public static final int COMPACT_INDEX_FAST_FORWARD = 2;

    /**
     * Queue track-skip commands withheld from the media notification controller (and therefore
     * from the platform `PlaybackState` / System UI), so the slots flanking Play/Pause go to the
     * Rewind / Fast-forward custom actions regardless of the queue length.
     */
    public static final int[] HIDDEN_SYSTEM_UI_PLAYER_COMMANDS = {
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
    };

    /** Immutable description of one lock-screen button (unit-testable without Android). */
    public static final class ButtonSpec {
        public final String action;
        public final int icon;
        public final int slot;
        public final int compactViewIndex;
        @StringRes public final int labelRes;
        public final long deltaMs;

        ButtonSpec(String action, int icon, int slot, int compactViewIndex, int labelRes, long deltaMs) {
            this.action = action;
            this.icon = icon;
            this.slot = slot;
            this.compactViewIndex = compactViewIndex;
            this.labelRes = labelRes;
            this.deltaMs = deltaMs;
        }
    }

    public static ButtonSpec rewindSpec() {
        return new ButtonSpec(
            ACTION_SEEK_BACK,
            CommandButton.ICON_SKIP_BACK_10,
            CommandButton.SLOT_BACK,
            COMPACT_INDEX_REWIND,
            R.string.lock_screen_rewind_10,
            -SEEK_BACK_MS
        );
    }

    public static ButtonSpec fastForwardSpec() {
        return new ButtonSpec(
            ACTION_SEEK_FORWARD,
            CommandButton.ICON_SKIP_FORWARD_30,
            CommandButton.SLOT_FORWARD,
            COMPACT_INDEX_FAST_FORWARD,
            R.string.lock_screen_fast_forward_30,
            SEEK_FORWARD_MS
        );
    }

    /** Custom-layout order: index 0 -> System UI left slot, index 1 -> right slot. */
    public static List<ButtonSpec> buttonSpecs() {
        List<ButtonSpec> specs = new ArrayList<>(2);
        specs.add(rewindSpec());
        specs.add(fastForwardSpec());
        return Collections.unmodifiableList(specs);
    }

    public static boolean isHiddenSystemUiPlayerCommand(int command) {
        for (int c : HIDDEN_SYSTEM_UI_PLAYER_COMMANDS) {
            if (c == command) return true;
        }
        return false;
    }

    /** Seek delta for a custom session action, or 0 when the action is not a lock-screen seek. */
    public static long deltaForAction(@Nullable String action) {
        if (ACTION_SEEK_BACK.equals(action)) return -SEEK_BACK_MS;
        if (ACTION_SEEK_FORWARD.equals(action)) return SEEK_FORWARD_MS;
        return 0L;
    }

    /**
     * Hardware / Bluetooth key mapping (ACTION_DOWN only; Media3 1.5.1 filters ACTION_UP before
     * calling `MediaSession.Callback.onMediaButtonEvent`). With the track-skip actions hidden from
     * the platform session, headset NEXT / PREVIOUS (and AVRCP skip) seek like the lock-screen
     * buttons instead of being ignored. REWIND / FAST_FORWARD are handled here too (Media3 would
     * otherwise drop them while ExoPlayer reports `COMMAND_SEEK_BACK/FORWARD` unavailable, e.g. on a
     * restored, still unprepared track). Returns 0 for other keys (play / pause / headset hook are
     * mapped by {@link #playPauseActionForMediaKey}; stop etc. are left to Media3).
     */
    public static long deltaForMediaKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return SEEK_FORWARD_MS;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return -SEEK_BACK_MS;
            default:
                return 0L;
        }
    }

    /** {@link #playPauseActionForMediaKey}: not a play / pause key (let Media3 / seek mapping handle it). */
    public static final int MEDIA_KEY_NONE = 0;
    /** {@link #playPauseActionForMediaKey}: resume playback. */
    public static final int MEDIA_KEY_PLAY = 1;
    /** {@link #playPauseActionForMediaKey}: pause playback. */
    public static final int MEDIA_KEY_PAUSE = 2;

    /**
     * Wired / Bluetooth / TWS Play-Pause key mapping (bc737679), handled by `PlaybackService`
     * itself instead of Media3 1.5.1's default, which (verified via `javap`):
     * <ul>
     *   <li>toggles `KEYCODE_MEDIA_PLAY_PAUSE` / `KEYCODE_HEADSETHOOK` on {@code playWhenReady}
     *       alone, so after a network error (`STATE_IDLE` keeps {@code playWhenReady = true}) or at
     *       the end of an episode (`STATE_ENDED`) the first press <i>pauses</i> a player that is
     *       not playing — the press seems ignored;</li>
     *   <li>delays every single press by the double-tap timeout and turns a double tap into
     *       `seekToNext` (a track skip the notification controller is not granted);</li>
     *   <li>dispatches through `checkNotNull(getMediaNotificationControllerInfo())`, which is not
     *       yet connected right after `MediaButtonReceiver` cold-starts the service.</li>
     * </ul>
     * Play / pause then goes through `LockScreenSessionPlayer.play()` / `pause()`, which restores
     * an empty player, re-prepares an idle one at its paused position and restarts an ended one.
     */
    public static int playPauseActionForMediaKey(int keyCode, boolean playWhenReady, int playbackState) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return MEDIA_KEY_PLAY;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                return MEDIA_KEY_PAUSE;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return shouldShowPlay(playWhenReady, playbackState) ? MEDIA_KEY_PLAY : MEDIA_KEY_PAUSE;
            default:
                return MEDIA_KEY_NONE;
        }
    }

    /** True when a toggle should resume: paused, or not actually playing (idle / ended). */
    public static boolean shouldShowPlay(boolean playWhenReady, int playbackState) {
        return !playWhenReady
            || playbackState == Player.STATE_IDLE
            || playbackState == Player.STATE_ENDED;
    }

    /**
     * Clamps a relative seek: never below 0, and never past a known duration (seeking to the end
     * completes the episode through the normal `STATE_ENDED` / auto-advance path, exactly like the
     * in-app skip which clamps to `durationMs`). Unknown duration (`<= 0` / `C.TIME_UNSET`, e.g. a
     * restored, still unprepared track) only clamps the lower bound. Overflow-safe.
     */
    public static long clampSeekTargetMs(long currentMs, long deltaMs, long durationMs) {
        long base = Math.max(0L, currentMs);
        long target;
        if (deltaMs > 0 && base > Long.MAX_VALUE - deltaMs) {
            target = Long.MAX_VALUE;
        } else {
            target = base + deltaMs;
        }
        if (durationMs != C.TIME_UNSET && durationMs > 0L && target > durationMs) {
            target = durationMs;
        }
        return Math.max(0L, target);
    }

    /** True for user/system seeks that `PlaybackService` must checkpoint and emit immediately. */
    public static boolean isSeekDiscontinuity(int reason) {
        return reason == Player.DISCONTINUITY_REASON_SEEK
            || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT;
    }

    /** Explicit "do not reserve" flags so System UI may place custom actions in prev/next slots. */
    public static Map<String, Boolean> slotReservationFlags() {
        Map<String, Boolean> flags = new LinkedHashMap<>();
        flags.put(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_PREV, false);
        flags.put(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_NEXT, false);
        return Collections.unmodifiableMap(flags);
    }

    // -------------------------------------------------------------------------
    // Android / Media3 glue
    // -------------------------------------------------------------------------

    public static SessionCommand sessionCommand(ButtonSpec spec) {
        return new SessionCommand(spec.action, Bundle.EMPTY);
    }

    public static CommandButton toCommandButton(Context context, ButtonSpec spec) {
        Bundle extras = new Bundle();
        extras.putInt(DefaultMediaNotificationProvider.COMMAND_KEY_COMPACT_VIEW_INDEX, spec.compactViewIndex);
        return new CommandButton.Builder(spec.icon)
            .setSessionCommand(sessionCommand(spec))
            .setDisplayName(context.getString(spec.labelRes))
            .setSlots(spec.slot)
            .setExtras(extras)
            .build();
    }

    public static ImmutableList<CommandButton> buildCustomLayout(Context context) {
        ImmutableList.Builder<CommandButton> out = ImmutableList.builder();
        for (ButtonSpec spec : buttonSpecs()) {
            out.add(toCommandButton(context, spec));
        }
        return out.build();
    }

    public static SessionCommands withSeekSessionCommands(SessionCommands base) {
        SessionCommands.Builder builder = base.buildUpon();
        for (ButtonSpec spec : buttonSpecs()) {
            builder.add(sessionCommand(spec));
        }
        return builder.build();
    }

    public static Player.Commands withoutTrackSkipCommands(Player.Commands base) {
        return base.buildUpon().removeAll(HIDDEN_SYSTEM_UI_PLAYER_COMMANDS).build();
    }

    public static Bundle buildSessionExtras() {
        Bundle extras = new Bundle();
        for (Map.Entry<String, Boolean> e : slotReservationFlags().entrySet()) {
            extras.putBoolean(e.getKey(), e.getValue());
        }
        return extras;
    }

    @Nullable
    public static CommandButton findButton(List<CommandButton> buttons, String action) {
        for (CommandButton b : buttons) {
            if (b.sessionCommand != null && action.equals(b.sessionCommand.customAction)) {
                return b;
            }
        }
        return null;
    }
}
