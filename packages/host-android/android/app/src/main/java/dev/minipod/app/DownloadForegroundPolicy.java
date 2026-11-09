package dev.minipod.app;

/**
 * Pure decision helpers for {@code EpisodeDownloadService} (no android.*, JVM-unit-testable):
 * when to promote / update / stop the `dataSync` foreground service, how to aggregate the
 * notification progress, `onTimeout` handling, and idempotent wake / Wi-Fi lock bookkeeping.
 */
final class DownloadForegroundPolicy {

    /** Upper bound of a single wake-lock acquisition; renewed while downloads stay active. */
    static final long WAKE_LOCK_TIMEOUT_MS = 60L * 60L * 1000L;
    /** Min interval between notification progress refreshes (count changes are immediate). */
    static final long NOTIFICATION_THROTTLE_MS = 1_000L;

    enum Action { NONE, UPDATE_NOTIFICATION, STOP }

    private DownloadForegroundPolicy() {}

    static boolean isActive(int running, int queued) {
        return running + queued > 0;
    }

    /**
     * Whether a new `startForegroundService` should be requested for the given activity.
     * Skipped when the service is already alive, nothing is active, or Android 15+ already timed
     * the `dataSync` FGS out (re-promotion would throw until the user returns to the app):
     * downloads then continue best-effort in-process.
     */
    static boolean shouldRequestStart(boolean serviceAlive, boolean timedOut, int running, int queued) {
        return !serviceAlive && !timedOut && isActive(running, queued);
    }

    /**
     * Aggregated progress in percent over jobs with a known size, or -1 (indeterminate) when no
     * running job knows its size.
     */
    static int aggregatePercent(long[] bytes, long[] totals) {
        if (bytes == null || totals == null) return -1;
        long sumDone = 0L;
        long sumTotal = 0L;
        for (int i = 0; i < Math.min(bytes.length, totals.length); i++) {
            if (totals[i] > 0L) {
                sumTotal += totals[i];
                sumDone += Math.min(Math.max(0L, bytes[i]), totals[i]);
            }
        }
        if (sumTotal <= 0L) return -1;
        return (int) Math.max(0L, Math.min(100L, (sumDone * 100L) / sumTotal));
    }

    /** Foreground-service lifecycle state of one service instance. Not thread-safe (main thread). */
    static final class ServiceState {
        private boolean foreground;
        private boolean promotionDenied;
        private boolean timedOut;
        private long lastNotifyMs = Long.MIN_VALUE;
        private int lastRunning = -1;
        private int lastQueued = -1;

        /**
         * Every `onStartCommand` must answer a `startForegroundService` with `startForeground`
         * (even when the queue already drained) or Android crashes the app.
         */
        boolean shouldPromoteOnStart() {
            return !foreground && !timedOut;
        }

        void onPromotionResult(boolean success) {
            foreground = success;
            promotionDenied = !success;
        }

        boolean isForeground() {
            return foreground;
        }

        boolean wasPromotionDenied() {
            return promotionDenied;
        }

        boolean isTimedOut() {
            return timedOut;
        }

        /** Download counts / progress changed. */
        Action onUpdate(int running, int queued, long nowMs) {
            if (!isActive(running, queued)) return Action.STOP;
            if (!foreground) return Action.NONE;
            boolean countsChanged = running != lastRunning || queued != lastQueued;
            if (!countsChanged && lastNotifyMs != Long.MIN_VALUE
                && nowMs - lastNotifyMs < NOTIFICATION_THROTTLE_MS) {
                return Action.NONE;
            }
            lastRunning = running;
            lastQueued = queued;
            lastNotifyMs = nowMs;
            return Action.UPDATE_NOTIFICATION;
        }

        /**
         * Android 15+ `Service.onTimeout` for the `dataSync` type: stop foreground and the service
         * right away (never let Android raise its timeout crash). In-flight downloads keep going
         * in-process; `.part` files make anything interrupted resumable.
         */
        Action onTimeout() {
            timedOut = true;
            foreground = false;
            return Action.STOP;
        }

        void onStopped() {
            foreground = false;
        }
    }

    /** One lock (wake lock / Wi-Fi lock) abstraction. */
    interface Lock {
        void acquire(long timeoutMs);

        void release();

        boolean isHeld();
    }

    /**
     * Holds the `PARTIAL_WAKE_LOCK` + `WifiLock` exactly while downloads are active or queued.
     * Idempotent; {@link #update(boolean)} with {@code true} renews the bounded wake lock.
     */
    static final class Locks {
        private final Lock wakeLock;
        private final Lock wifiLock;
        private boolean held;

        Locks(Lock wakeLock, Lock wifiLock) {
            this.wakeLock = wakeLock;
            this.wifiLock = wifiLock;
        }

        synchronized void update(boolean active) {
            if (active) {
                safeAcquire(wakeLock, WAKE_LOCK_TIMEOUT_MS);
                if (wifiLock != null && !wifiLock.isHeld()) safeAcquire(wifiLock, 0L);
                held = true;
            } else {
                releaseAll();
            }
        }

        synchronized void releaseAll() {
            safeRelease(wakeLock);
            safeRelease(wifiLock);
            held = false;
        }

        synchronized boolean isHeld() {
            return held;
        }

        private static void safeAcquire(Lock lock, long timeoutMs) {
            if (lock == null) return;
            try {
                lock.acquire(timeoutMs);
            } catch (RuntimeException ignored) {
                // missing permission / OEM quirk: downloads still run
            }
        }

        private static void safeRelease(Lock lock) {
            if (lock == null) return;
            try {
                if (lock.isHeld()) lock.release();
            } catch (RuntimeException ignored) {
                // under-locked: already released
            }
        }
    }
}
