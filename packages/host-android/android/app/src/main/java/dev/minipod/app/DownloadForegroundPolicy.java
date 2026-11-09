package dev.minipod.app;

/**
 * Pure decision helpers for {@code EpisodeDownloadService} (no android.*, JVM-unit-testable):
 * when to promote / update / stop the `dataSync` foreground service, how to aggregate the
 * notification progress, `onTimeout` handling, and idempotent wake / Wi-Fi lock bookkeeping.
 */
final class DownloadForegroundPolicy {

    /** Upper bound of a single wake-lock acquisition; renewed while downloads stay active. */
    static final long WAKE_LOCK_TIMEOUT_MS = 60L * 60L * 1000L;
    /** Re-acquire (extend) the bounded wake lock this often while downloads stay active. */
    static final long WAKE_LOCK_RENEW_MS = 10L * 60L * 1000L;
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

    /**
     * Foreground-service lifecycle state of one service instance. Not thread-safe (main thread).
     *
     * <p>Every `onStartCommand` answers its `startForegroundService` with `startForeground`
     * <b>unconditionally</b> (idempotent when already foreground): Android records `fgRequired` per
     * start request, so skipping it for a second coalesced / late request crashes the app with
     * `ForegroundServiceDidNotStartInTimeException`. Only afterwards does the service decide to
     * stop ({@link #shouldStopAfterStart}).
     */
    static final class ServiceState {
        private boolean foreground;
        private boolean promotionDenied;
        private boolean timedOut;
        private long lastNotifyMs = Long.MIN_VALUE;
        private int lastRunning = -1;
        private int lastQueued = -1;

        /** A new start request arrived: a fresh promotion cycle begins. */
        void onStartCommand() {
            timedOut = false;
            lastNotifyMs = Long.MIN_VALUE;
            lastRunning = -1;
            lastQueued = -1;
        }

        void onPromotionResult(boolean success) {
            foreground = success;
            promotionDenied = !success;
        }

        /**
         * After the mandatory promotion: stop right away when nothing is active, or when Android
         * 15+ already timed the `dataSync` FGS out (downloads continue best-effort in-process).
         */
        static boolean shouldStopAfterStart(int running, int queued, boolean managerTimedOut) {
            return !isActive(running, queued) || managerTimedOut;
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

    /**
     * Coalesces `startForegroundService` requests while one is already pending (main thread).
     * Without it every queued episode (`下载全部` x N) would issue its own start before the service
     * instance exists.
     */
    static final class StartGate {
        private boolean pending;

        /** Returns true when the caller should issue a new `startForegroundService` now. */
        boolean tryBegin(boolean serviceAlive, boolean timedOut, int running, int queued) {
            if (pending || !shouldRequestStart(serviceAlive, timedOut, running, queued)) return false;
            pending = true;
            return true;
        }

        /** `onStartCommand` arrived, the service was destroyed, or the start call threw. */
        void clear() {
            pending = false;
        }

        boolean isPending() {
            return pending;
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
        private long lastWakeAcquireMs = Long.MIN_VALUE;

        Locks(Lock wakeLock, Lock wifiLock) {
            this.wakeLock = wakeLock;
            this.wifiLock = wifiLock;
        }

        /** Same as {@link #update(boolean, long)} with a forced wake-lock renewal. */
        synchronized void update(boolean active) {
            if (active) lastWakeAcquireMs = Long.MIN_VALUE;
            update(active, 0L);
        }

        /**
         * Acquires both locks while {@code active}; the bounded wake lock is re-acquired (extended)
         * when not held or every {@link #WAKE_LOCK_RENEW_MS}, so a long download never outlives
         * {@link #WAKE_LOCK_TIMEOUT_MS}. Releases both when idle.
         */
        synchronized void update(boolean active, long nowMs) {
            if (active) {
                boolean wakeHeld = wakeLock != null && safeIsHeld(wakeLock);
                if (wakeLock != null && (!wakeHeld || lastWakeAcquireMs == Long.MIN_VALUE
                    || nowMs - lastWakeAcquireMs >= WAKE_LOCK_RENEW_MS)) {
                    if (safeAcquire(wakeLock, WAKE_LOCK_TIMEOUT_MS)) lastWakeAcquireMs = nowMs;
                }
                if (wifiLock != null && !safeIsHeld(wifiLock)) safeAcquire(wifiLock, 0L);
                held = true;
            } else {
                releaseAll();
            }
        }

        synchronized void releaseAll() {
            safeRelease(wakeLock);
            safeRelease(wifiLock);
            held = false;
            lastWakeAcquireMs = Long.MIN_VALUE;
        }

        synchronized boolean isHeld() {
            return held;
        }

        private static boolean safeIsHeld(Lock lock) {
            try {
                return lock.isHeld();
            } catch (RuntimeException e) {
                return false;
            }
        }

        private static boolean safeAcquire(Lock lock, long timeoutMs) {
            if (lock == null) return false;
            try {
                lock.acquire(timeoutMs);
                return true;
            } catch (RuntimeException ignored) {
                // missing permission / OEM quirk: downloads still run
                return false;
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
