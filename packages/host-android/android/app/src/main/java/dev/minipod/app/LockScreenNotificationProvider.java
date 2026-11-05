package dev.minipod.app;

import android.content.Context;
import android.os.Bundle;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import com.google.common.collect.ImmutableList;

/**
 * `DefaultMediaNotificationProvider` that lays out the `MediaStyle` notification actions as
 * <b>Rewind -10 s</b> | Play/Pause | <b>Fast-forward +30 s</b>, with explicit
 * `COMMAND_KEY_COMPACT_VIEW_INDEX` 0 / 1 / 2 so the collapsed notification and the pre-Android-13
 * lock screen show the same three buttons in the same order.
 *
 * <p>Media3 1.5.1's default `getMediaButtons` emits [prev?, play/pause, next?, custom...] (custom
 * buttons always <i>after</i> Play/Pause); the media notification controller does not get the
 * track-skip commands (see {@link LockScreenControls}), so prev/next would be absent anyway, but
 * the custom buttons would both land to the right of Play/Pause. Android 13+ System UI renders
 * from the platform `PlaybackState` instead and gets the same order from the custom-layout order.
 */
@OptIn(markerClass = UnstableApi.class)
public final class LockScreenNotificationProvider extends DefaultMediaNotificationProvider {
    private final Context context;

    public LockScreenNotificationProvider(Context context, int notificationId, String channelId) {
        super(context, session -> notificationId, channelId, R.string.playback_channel_name);
        this.context = context.getApplicationContext();
    }

    @Override
    protected ImmutableList<CommandButton> getMediaButtons(
        MediaSession session,
        Player.Commands playerCommands,
        ImmutableList<CommandButton> mediaButtonPreferences,
        boolean showPauseButton
    ) {
        ImmutableList.Builder<CommandButton> out = ImmutableList.builder();
        CommandButton rewind =
            LockScreenControls.findButton(mediaButtonPreferences, LockScreenControls.ACTION_SEEK_BACK);
        CommandButton forward =
            LockScreenControls.findButton(mediaButtonPreferences, LockScreenControls.ACTION_SEEK_FORWARD);

        if (rewind != null && rewind.isEnabled) {
            out.add(rewind);
        }
        if (playerCommands.contains(Player.COMMAND_PLAY_PAUSE)) {
            Bundle extras = new Bundle();
            extras.putInt(COMMAND_KEY_COMPACT_VIEW_INDEX, LockScreenControls.COMPACT_INDEX_PLAY_PAUSE);
            out.add(
                new CommandButton.Builder(showPauseButton ? CommandButton.ICON_PAUSE : CommandButton.ICON_PLAY)
                    .setPlayerCommand(Player.COMMAND_PLAY_PAUSE)
                    .setExtras(extras)
                    .setDisplayName(context.getString(
                        showPauseButton
                            ? androidx.media3.session.R.string.media3_controls_pause_description
                            : androidx.media3.session.R.string.media3_controls_play_description))
                    .build()
            );
        }
        if (forward != null && forward.isEnabled) {
            out.add(forward);
        }
        // Keep any other custom button (none today) after the transport row, like Media3 does.
        for (CommandButton b : mediaButtonPreferences) {
            if (b == rewind || b == forward) continue;
            if (b.sessionCommand != null && b.sessionCommand.commandCode == SessionCommand.COMMAND_CODE_CUSTOM) {
                out.add(b);
            }
        }
        return out.build();
    }
}
