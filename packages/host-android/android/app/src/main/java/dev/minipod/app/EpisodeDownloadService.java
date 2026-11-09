package dev.minipod.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * `dataSync` foreground service that keeps native episode downloads alive in the background on
 * Android 14–17 (`targetSdk 36`): while {@link EpisodeDownloadManager} has anything RUNNING or
 * QUEUED it shows a silent low-importance progress notification (channel `minipod_downloads`,
 * id {@value #NOTIFICATION_ID}, never colliding with `PlaybackService`'s 1001) and holds a
 * bounded `PARTIAL_WAKE_LOCK` (`minipod:downloads`) + `WifiLock`, so the Cached Apps Freezer /
 * Doze no longer freeze the process and drop the sockets after the screen turns off.
 *
 * <p>Safety: every `startForegroundService` / `startForeground` is wrapped (a refused promotion
 * never crashes the app; downloads continue best-effort in-process), `onTimeout` (Android 15+
 * `dataSync` time limit) stops foreground + the service immediately, and the locks are released
 * on every drain / stop / destroy path.
 */
public class EpisodeDownloadService extends Service {

    static final String CHANNEL_ID = "minipod_downloads";
    static final int NOTIFICATION_ID = 1002;
    static final String WAKE_LOCK_TAG = "minipod:downloads";

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    @Nullable private static volatile EpisodeDownloadService instance;
    @Nullable private static DownloadForegroundPolicy.Locks locks;
    /** Main-thread only: coalesces `startForegroundService` while a start is in flight. */
    private static final DownloadForegroundPolicy.StartGate START_GATE = new DownloadForegroundPolicy.StartGate();

    private final DownloadForegroundPolicy.ServiceState state = new DownloadForegroundPolicy.ServiceState();
    private final Runnable refreshRunnable = this::refreshNow;

    // ------------------------------------------------------------------ static coordination

    /**
     * Syncs locks + service with the manager's counts (any thread). {@code allowStart}: request a
     * new `startForegroundService` when the service is not alive (user-initiated enqueue).
     */
    static void sync(Context context, boolean allowStart) {
        Context app = context.getApplicationContext();
        MAIN.post(() -> syncOnMain(app, allowStart));
    }

    /**
     * Progress tick (any thread): renews the bounded wake lock periodically and refreshes an
     * already running service's notification (throttled). Never starts the service.
     */
    static void refreshIfRunning(Context context) {
        Context app = context.getApplicationContext();
        MAIN.post(() -> {
            EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
            boolean active = manager != null && !manager.isIdle();
            locksFor(app).update(active, SystemClock.elapsedRealtime());
            EpisodeDownloadService svc = instance;
            if (svc != null) svc.refreshNow();
        });
    }

    private static void syncOnMain(Context app, boolean allowStart) {
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        int running = manager != null ? manager.runningCount() : 0;
        int queued = manager != null ? manager.queuedCount() : 0;
        boolean active = DownloadForegroundPolicy.isActive(running, queued);
        locksFor(app).update(active, SystemClock.elapsedRealtime());

        EpisodeDownloadService svc = instance;
        if (svc != null) {
            svc.refreshNow();
            return;
        }
        boolean timedOut = manager != null && manager.isForegroundTimedOut();
        // One `startForegroundService` per start cycle: N queued episodes post N syncs before the
        // instance exists; every extra start would require its own `startForeground`.
        if (allowStart && START_GATE.tryBegin(false, timedOut, running, queued)) {
            try {
                ContextCompat.startForegroundService(app, new Intent(app, EpisodeDownloadService.class));
            } catch (RuntimeException ignored) {
                START_GATE.clear();
                // `ForegroundServiceStartNotAllowedException` (app in background) /
                // `SecurityException` / `IllegalStateException`: downloads still run best-effort
                // in-process under the wake / Wi-Fi locks.
            }
        }
    }

    private static synchronized DownloadForegroundPolicy.Locks locksFor(Context app) {
        if (locks == null) {
            locks = new DownloadForegroundPolicy.Locks(createWakeLock(app), createWifiLock(app));
        }
        return locks;
    }

    @Nullable
    private static DownloadForegroundPolicy.Lock createWakeLock(Context app) {
        try {
            PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return null;
            PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wl.setReferenceCounted(false);
            return new DownloadForegroundPolicy.Lock() {
                @Override
                public void acquire(long timeoutMs) {
                    // Bounded: renewed on every activity change while downloads stay active.
                    wl.acquire(timeoutMs > 0L ? timeoutMs : DownloadForegroundPolicy.WAKE_LOCK_TIMEOUT_MS);
                }

                @Override
                public void release() {
                    wl.release();
                }

                @Override
                public boolean isHeld() {
                    return wl.isHeld();
                }
            };
        } catch (RuntimeException e) {
            return null;
        }
    }

    @Nullable
    @SuppressWarnings("deprecation")
    private static DownloadForegroundPolicy.Lock createWifiLock(Context app) {
        try {
            WifiManager wm = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return null;
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            WifiManager.WifiLock lock = wm.createWifiLock(mode, WAKE_LOCK_TAG);
            lock.setReferenceCounted(false);
            return new DownloadForegroundPolicy.Lock() {
                @Override
                public void acquire(long timeoutMs) {
                    lock.acquire();
                }

                @Override
                public void release() {
                    lock.release();
                }

                @Override
                public boolean isHeld() {
                    return lock.isHeld();
                }
            };
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void releaseLocksIfIdle(Context app) {
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        if (manager == null || manager.isIdle()) {
            locksFor(app).releaseAll();
        }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // Android may reuse this instance (restart requested before `onDestroy`): re-register.
        instance = this;
        START_GATE.clear();
        state.onStartCommand();
        // ALWAYS answer `startForegroundService` with `startForeground` (idempotent when already
        // foreground): AMS tracks `fgRequired` per start request, and skipping it crashes the app
        // with `ForegroundServiceDidNotStartInTimeException` (Android 12+).
        state.onPromotionResult(promoteToForeground());
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        int running = manager != null ? manager.runningCount() : 0;
        int queued = manager != null ? manager.queuedCount() : 0;
        boolean timedOut = manager != null && manager.isForegroundTimedOut();
        if (DownloadForegroundPolicy.ServiceState.shouldStopAfterStart(running, queued, timedOut)) {
            stopEverything(startId);
        } else {
            refreshNow();
        }
        // Downloads are in-memory: a restarted (killed) process has nothing to resume here.
        return START_NOT_STICKY;
    }

    private boolean promoteToForeground() {
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
            return true;
        } catch (RuntimeException e) {
            // `ForegroundServiceStartNotAllowedException` (incl. Android 15+ exhausted `dataSync`
            // budget) / `SecurityException` / `IllegalStateException`: never crash.
            return false;
        }
    }

    private void refreshNow() {
        if (instance != this) return; // stopping: a new start cycle owns the notification
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        int running = manager != null ? manager.runningCount() : 0;
        int queued = manager != null ? manager.queuedCount() : 0;
        DownloadForegroundPolicy.Action action = state.onUpdate(running, queued, SystemClock.elapsedRealtime());
        switch (action) {
            case STOP:
                stopEverything(-1);
                break;
            case UPDATE_NOTIFICATION:
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
                } catch (RuntimeException ignored) {
                    // notification permission revoked / OEM quirk
                }
                break;
            case NONE:
            default:
                // Throttled, or promotion was refused (`wasPromotionDenied`): keep running as a
                // plain started service (best-effort) and stop as soon as the queue drains.
                break;
        }
    }

    private void stopEverything(int startId) {
        MAIN.removeCallbacks(refreshRunnable);
        // Clear right away (not only in the async `onDestroy`) so a download enqueued while this
        // instance is dying requests a fresh start instead of talking to a stopping service.
        if (instance == this) instance = null;
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
            // not foreground
        }
        state.onStopped();
        releaseLocksIfIdle(getApplicationContext());
        if (startId >= 0) {
            stopSelf(startId);
        } else {
            stopSelf();
        }
    }

    /** Android 15+ (API 35) foreground-service timeout for `dataSync`. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        handleTimeout(startId);
    }

    /** Android 14 (API 34) variant (short services); handled identically for safety. */
    @Override
    public void onTimeout(int startId) {
        handleTimeout(startId);
    }

    private void handleTimeout(int startId) {
        state.onTimeout();
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        if (manager != null) manager.onForegroundServiceTimeout();
        // Ongoing transfers keep running in-process (locks stay held while active);
        // interrupted ones leave a resumable `.part`.
        MAIN.removeCallbacks(refreshRunnable);
        if (instance == this) instance = null;
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException ignored) {
            // ignore
        }
        stopSelf();
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // `stopWithTask="false"`: swiping the app from Recents keeps the queue downloading.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        MAIN.removeCallbacks(refreshRunnable);
        state.onStopped();
        if (instance == this) {
            instance = null;
        }
        START_GATE.clear();
        releaseLocksIfIdle(getApplicationContext());
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------ notification

    private void ensureNotificationChannel() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.download_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setShowBadge(false);
                channel.setSound(null, null);
                channel.enableVibration(false);
                nm.createNotificationChannel(channel);
            }
        } catch (RuntimeException ignored) {
            // ignore
        }
    }

    private PendingIntent contentIntent() {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_MAIN);
        launch.addCategory(Intent.CATEGORY_LAUNCHER);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this, NOTIFICATION_ID, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private Notification buildNotification() {
        EpisodeDownloadManager manager = EpisodeDownloadManager.peek();
        int[] counts = manager != null ? manager.notificationCounts() : new int[] { 0, 0, -1 };
        int running = counts[0];
        int queued = counts[1];
        int percent = counts[2];
        String title = getResources().getQuantityString(
            R.plurals.download_notification_title, Math.max(1, running + queued), running + queued
        );
        String text;
        String episodeTitle = manager != null ? manager.firstRunningTitle() : null;
        if (queued > 0) {
            text = getString(R.string.download_notification_queued, running, queued);
        } else if (episodeTitle != null) {
            text = episodeTitle;
        } else {
            text = getString(R.string.download_notification_running, running);
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent())
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (percent >= 0) {
            b.setProgress(100, percent, false);
        } else {
            b.setProgress(0, 0, true);
        }
        return b.build();
    }
}
