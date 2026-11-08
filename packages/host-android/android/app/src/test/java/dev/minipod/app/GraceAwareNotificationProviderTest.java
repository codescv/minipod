package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.os.Bundle;
import androidx.media3.common.Player;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import com.google.common.collect.ImmutableList;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * bc737679: a late (async artwork) Media3 notification update must not detach the paused
 * notification from the foreground inside the grace window.
 */
public class GraceAwareNotificationProviderTest {

    /** Delegate that records the callback Media3's provider would invoke later. */
    private static final class FakeDelegate implements MediaNotification.Provider {
        MediaNotification.Provider.Callback captured;
        final List<String> customCommands = new ArrayList<>();

        @Override
        public MediaNotification createNotification(
            MediaSession mediaSession,
            ImmutableList<CommandButton> mediaButtonPreferences,
            MediaNotification.ActionFactory actionFactory,
            MediaNotification.Provider.Callback onNotificationChangedCallback
        ) {
            captured = onNotificationChangedCallback;
            return null;
        }

        @Override
        public boolean handleCustomCommand(MediaSession session, String action, Bundle extras) {
            customCommands.add(action);
            return true;
        }
    }

    @Test
    public void lateArtworkUpdate_insideGrace_isRepostedByService_notForwardedToMedia3() {
        FakeDelegate delegate = new FakeDelegate();
        int[] intercepts = {0};
        List<MediaNotification> forwarded = new ArrayList<>();
        GraceAwareNotificationProvider provider = new GraceAwareNotificationProvider(delegate, () -> {
            intercepts[0]++;
            return true; // service re-posted it in the foreground
        });

        assertNull(provider.createNotification(null, ImmutableList.of(), null, forwarded::add));
        MediaNotification.Provider.Callback wrapped = delegate.captured;
        wrapped.onNotificationChanged(null);

        assertEquals(1, intercepts[0]);
        assertTrue(forwarded.isEmpty());
    }

    @Test
    public void lateArtworkUpdate_notIntercepted_isForwardedUnchanged() {
        FakeDelegate delegate = new FakeDelegate();
        List<MediaNotification> forwarded = new ArrayList<>();
        MediaNotification.Provider.Callback original = forwarded::add;
        GraceAwareNotificationProvider provider = new GraceAwareNotificationProvider(delegate, () -> false);

        provider.createNotification(null, ImmutableList.of(), null, original);
        assertNotSame(original, delegate.captured);
        delegate.captured.onNotificationChanged(null);
        delegate.captured.onNotificationChanged(null);

        assertEquals(2, forwarded.size());
    }

    @Test
    public void customCommands_delegated() {
        FakeDelegate delegate = new FakeDelegate();
        GraceAwareNotificationProvider provider = new GraceAwareNotificationProvider(delegate, () -> false);
        assertTrue(provider.handleCustomCommand(null, LockScreenControls.ACTION_SEEK_BACK, null));
        assertEquals(List.of(LockScreenControls.ACTION_SEEK_BACK), delegate.customCommands);
    }

    @Test
    public void wrapCallback_consultsInterceptorOnEveryUpdate() {
        List<Boolean> answers = new ArrayList<>(List.of(true, false, true));
        int[] forwarded = {0};
        MediaNotification.Provider.Callback cb = GraceAwareNotificationProvider.wrapCallback(
            n -> forwarded[0]++, () -> answers.remove(0));
        cb.onNotificationChanged(null);
        cb.onNotificationChanged(null);
        cb.onNotificationChanged(null);
        assertEquals(1, forwarded[0]);
        assertTrue(answers.isEmpty());
    }

    @Test
    public void interceptPolicy_onlyForegroundPausedInsideGrace() {
        // Paused within grace while Media3 is foreground: intercept (stay foreground).
        assertTrue(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(true, false, true, false));
        // Playing: Media3's own callback keeps it foreground.
        assertFalse(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(true, true, true, false));
        // Already detached (grace over / demoted): never re-promote from the background.
        assertFalse(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(false, false, true, false));
        // Grace expired.
        assertFalse(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(true, false, false, false));
        // Android just refused a foreground start: plain update.
        assertFalse(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(true, false, true, true));
    }

    @Test
    public void scenario_pauseBeforeArtworkLoaded_staysForegroundForWholeGrace() {
        long grace = PlaybackForegroundPolicy.PAUSED_FOREGROUND_GRACE_MS;
        long pausedAt = 1_000_000L;
        long artworkArrives = pausedAt + 3_000L;
        boolean keep = PlaybackForegroundPolicy.shouldKeepForeground(
            1, Player.STATE_READY, false, pausedAt, artworkArrives, grace);
        assertTrue(keep);
        assertTrue(PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(
            true, PlaybackForegroundPolicy.isActivelyPlaying(false, Player.STATE_READY), keep, false));
    }
}
