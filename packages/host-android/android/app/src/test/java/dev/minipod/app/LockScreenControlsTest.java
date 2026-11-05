package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.view.KeyEvent;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaConstants;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** JVM tests for the lock-screen Rewind -10 s | Play/Pause | Fast-forward +30 s controls. */
public class LockScreenControlsTest {

    @Test
    public void increments_matchCoreSkipConstants() {
        // `@minipod/core` SKIP_BACK_MS = 10_000, SKIP_FORWARD_MS = 30_000
        assertEquals(10_000L, LockScreenControls.SEEK_BACK_MS);
        assertEquals(30_000L, LockScreenControls.SEEK_FORWARD_MS);
    }

    @Test
    public void rewindSpec_isSkipBack10InBackSlotLeftOfPlayPause() {
        LockScreenControls.ButtonSpec spec = LockScreenControls.rewindSpec();
        assertEquals(CommandButton.ICON_SKIP_BACK_10, spec.icon);
        assertEquals(CommandButton.SLOT_BACK, spec.slot);
        assertEquals(LockScreenControls.ACTION_SEEK_BACK, spec.action);
        assertEquals(-10_000L, spec.deltaMs);
        assertEquals(R.string.lock_screen_rewind_10, spec.labelRes);
        assertEquals(0, spec.compactViewIndex);
    }

    @Test
    public void fastForwardSpec_isSkipForward30InForwardSlotRightOfPlayPause() {
        LockScreenControls.ButtonSpec spec = LockScreenControls.fastForwardSpec();
        assertEquals(CommandButton.ICON_SKIP_FORWARD_30, spec.icon);
        assertEquals(CommandButton.SLOT_FORWARD, spec.slot);
        assertEquals(LockScreenControls.ACTION_SEEK_FORWARD, spec.action);
        assertEquals(30_000L, spec.deltaMs);
        assertEquals(R.string.lock_screen_fast_forward_30, spec.labelRes);
        assertEquals(2, spec.compactViewIndex);
    }

    @Test
    public void compactViewIndices_flankPlayPause() {
        assertEquals(0, LockScreenControls.COMPACT_INDEX_REWIND);
        assertEquals(1, LockScreenControls.COMPACT_INDEX_PLAY_PAUSE);
        assertEquals(2, LockScreenControls.COMPACT_INDEX_FAST_FORWARD);
    }

    @Test
    public void buttonSpecs_orderIsRewindThenFastForward() {
        // Android 13+ System UI: 1st custom action -> slot left of Play/Pause, 2nd -> right.
        List<LockScreenControls.ButtonSpec> specs = LockScreenControls.buttonSpecs();
        assertEquals(2, specs.size());
        assertEquals(LockScreenControls.ACTION_SEEK_BACK, specs.get(0).action);
        assertEquals(LockScreenControls.ACTION_SEEK_FORWARD, specs.get(1).action);
        assertNotEquals(specs.get(0).action, specs.get(1).action);
    }

    @Test(expected = UnsupportedOperationException.class)
    public void buttonSpecs_isImmutable() {
        LockScreenControls.buttonSpecs().clear();
    }

    @Test
    public void hiddenSystemUiCommands_areExactlyTheQueueTrackSkipCommands() {
        assertTrue(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS));
        assertTrue(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM));
        assertTrue(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_TO_NEXT));
        assertTrue(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM));
        assertEquals(4, LockScreenControls.HIDDEN_SYSTEM_UI_PLAYER_COMMANDS.length);

        // Everything the lock screen still needs stays available.
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_PLAY_PAUSE));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_BACK));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_FORWARD));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_STOP));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_GET_CURRENT_MEDIA_ITEM));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_GET_METADATA));
        assertFalse(LockScreenControls.isHiddenSystemUiPlayerCommand(Player.COMMAND_SET_SPEED_AND_PITCH));
    }

    @Test
    public void deltaForAction_mapsOnlyOwnActions() {
        assertEquals(-10_000L, LockScreenControls.deltaForAction(LockScreenControls.ACTION_SEEK_BACK));
        assertEquals(30_000L, LockScreenControls.deltaForAction(LockScreenControls.ACTION_SEEK_FORWARD));
        assertEquals(0L, LockScreenControls.deltaForAction(null));
        assertEquals(0L, LockScreenControls.deltaForAction(""));
        assertEquals(0L, LockScreenControls.deltaForAction("dev.minipod.app.session.SEEK_BACK_10 "));
        assertEquals(0L, LockScreenControls.deltaForAction("androidx.media3.session.CUSTOM"));
    }

    @Test
    public void deltaForMediaKey_mapsHeadsetAndBluetoothKeys() {
        assertEquals(30_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_NEXT));
        assertEquals(30_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD));
        assertEquals(30_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD));
        assertEquals(-10_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS));
        assertEquals(-10_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD));
        assertEquals(-10_000L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_REWIND));

        // Left to Media3 (play/pause double-tap handling etc.)
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE));
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_HEADSETHOOK));
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY));
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE));
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_MEDIA_STOP));
        assertEquals(0L, LockScreenControls.deltaForMediaKey(KeyEvent.KEYCODE_VOLUME_UP));
    }

    @Test
    public void clampSeekTarget_rewindNeverGoesBelowZero() {
        assertEquals(0L, LockScreenControls.clampSeekTargetMs(6_000L, -10_000L, 600_000L));
        assertEquals(0L, LockScreenControls.clampSeekTargetMs(0L, -10_000L, 600_000L));
        assertEquals(0L, LockScreenControls.clampSeekTargetMs(-5L, -10_000L, 600_000L));
        assertEquals(32_000L, LockScreenControls.clampSeekTargetMs(42_000L, -10_000L, 600_000L));
        assertEquals(0L, LockScreenControls.clampSeekTargetMs(10_000L, -10_000L, C.TIME_UNSET));
    }

    @Test
    public void clampSeekTarget_fastForwardClampsToKnownDuration() {
        assertEquals(72_000L, LockScreenControls.clampSeekTargetMs(42_000L, 30_000L, 600_000L));
        assertEquals(600_000L, LockScreenControls.clampSeekTargetMs(590_000L, 30_000L, 600_000L));
        assertEquals(600_000L, LockScreenControls.clampSeekTargetMs(600_000L, 30_000L, 600_000L));
        // Position already beyond a stale duration hint still clamps to the duration.
        assertEquals(600_000L, LockScreenControls.clampSeekTargetMs(650_000L, 30_000L, 600_000L));
    }

    @Test
    public void clampSeekTarget_unknownDurationOnlyClampsLowerBound() {
        assertEquals(72_000L, LockScreenControls.clampSeekTargetMs(42_000L, 30_000L, C.TIME_UNSET));
        assertEquals(72_000L, LockScreenControls.clampSeekTargetMs(42_000L, 30_000L, 0L));
        assertEquals(72_000L, LockScreenControls.clampSeekTargetMs(42_000L, 30_000L, -1L));
    }

    @Test
    public void clampSeekTarget_isOverflowSafe() {
        assertEquals(Long.MAX_VALUE, LockScreenControls.clampSeekTargetMs(Long.MAX_VALUE - 5L, 30_000L, C.TIME_UNSET));
        assertEquals(0L, LockScreenControls.clampSeekTargetMs(Long.MIN_VALUE, -10_000L, 600_000L));
    }

    @Test
    public void seekDiscontinuity_onlySeekReasons() {
        assertTrue(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_SEEK));
        assertTrue(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT));
        assertFalse(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_AUTO_TRANSITION));
        assertFalse(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_SKIP));
        assertFalse(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_REMOVE));
        assertFalse(LockScreenControls.isSeekDiscontinuity(Player.DISCONTINUITY_REASON_INTERNAL));
    }

    @Test
    public void slotReservationFlags_explicitlyFreePrevAndNextSlots() {
        Map<String, Boolean> flags = LockScreenControls.slotReservationFlags();
        assertEquals(2, flags.size());
        assertEquals(Boolean.FALSE, flags.get(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_PREV));
        assertEquals(Boolean.FALSE, flags.get(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_NEXT));
        // Platform keys read by Android 13+ System UI (`MediaDataManager`).
        assertTrue(flags.containsKey("android.media.playback.ALWAYS_RESERVE_SPACE_FOR.ACTION_SKIP_TO_PREVIOUS"));
        assertTrue(flags.containsKey("android.media.playback.ALWAYS_RESERVE_SPACE_FOR.ACTION_SKIP_TO_NEXT"));
    }
}
