package dev.minipod.app;

import android.os.Bundle;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import com.google.common.collect.ImmutableList;

/**
 * `MediaNotification.Provider` decorator (around {@link LockScreenNotificationProvider}) that keeps
 * the paused-notification foreground grace window (bc737679) intact when artwork arrives late.
 *
 * <p>Media3 1.5.1 ground truth (`javap -c -p`): `DefaultMediaNotificationProvider.createNotification`
 * (final) returns a notification without artwork while the `BitmapLoader` future is pending and
 * later reports the artwork version through `Callback.onNotificationChanged` →
 * `MediaNotificationManager.onNotificationUpdated`, which bypasses
 * `MediaSessionService.onUpdateNotification` and hard-codes
 * `shouldRunInForeground(session, false)`: for a paused player that is
 * `stopForeground(STOP_FOREGROUND_DETACH)`, and Android then stops the service ~1 min later.
 *
 * <p>The wrapped callback first asks the {@link AsyncUpdateInterceptor}; when the service is still
 * foreground inside its paused grace window it re-posts the notification itself through
 * `onUpdateNotification` (the artwork future is now complete and cached by `CacheBitmapLoader`,
 * so that rebuild is synchronous and cannot recurse), staying foreground — a promotion of a
 * service that is <i>already</i> foreground, never a background re-promotion.
 */
@OptIn(markerClass = UnstableApi.class)
public final class GraceAwareNotificationProvider implements MediaNotification.Provider {

    /** Implemented by `PlaybackService`. */
    public interface AsyncUpdateInterceptor {
        /**
         * Called for a late (async artwork) notification update. Return true when the service
         * re-posted the notification itself (the stale Media3 callback is then skipped).
         */
        boolean interceptAsyncNotificationUpdate();
    }

    private final MediaNotification.Provider delegate;
    private final AsyncUpdateInterceptor interceptor;

    public GraceAwareNotificationProvider(
        MediaNotification.Provider delegate,
        AsyncUpdateInterceptor interceptor
    ) {
        this.delegate = delegate;
        this.interceptor = interceptor;
    }

    @Override
    public MediaNotification createNotification(
        MediaSession mediaSession,
        ImmutableList<CommandButton> mediaButtonPreferences,
        MediaNotification.ActionFactory actionFactory,
        MediaNotification.Provider.Callback onNotificationChangedCallback
    ) {
        return delegate.createNotification(
            mediaSession,
            mediaButtonPreferences,
            actionFactory,
            wrapCallback(onNotificationChangedCallback, interceptor)
        );
    }

    @Override
    public boolean handleCustomCommand(MediaSession session, String action, Bundle extras) {
        return delegate.handleCustomCommand(session, action, extras);
    }

    /** The decorated async-update callback (JVM-tested). */
    static MediaNotification.Provider.Callback wrapCallback(
        MediaNotification.Provider.Callback original,
        AsyncUpdateInterceptor interceptor
    ) {
        return notification -> {
            if (interceptor.interceptAsyncNotificationUpdate()) return;
            original.onNotificationChanged(notification);
        };
    }
}
