package dev.minipod.app;

/**
 * Per-download cancellation token (pure Java, JVM-unit-testable).
 *
 * <p>{@link #cancel()} is idempotent and thread-safe: it flips the flag, aborts the currently
 * registered network call (e.g. {@code okhttp3.Call::cancel}) and wakes every thread blocked in
 * {@link #awaitCancelled(long)} — so a retry backoff sleep ends <b>immediately</b> instead of
 * after its full multi-second delay.
 */
final class DownloadCancelToken implements DownloadTransfer.CancelCheck {

    private final Object lock = new Object();
    private boolean cancelled;
    private Runnable activeAbort;

    @Override
    public boolean isCancelled() {
        synchronized (lock) {
            return cancelled;
        }
    }

    /** Cancels the token; returns true only for the call that actually flipped it. */
    boolean cancel() {
        Runnable abort;
        synchronized (lock) {
            if (cancelled) return false;
            cancelled = true;
            abort = activeAbort;
            activeAbort = null;
            lock.notifyAll();
        }
        runQuietly(abort);
        return true;
    }

    /**
     * Registers the abort hook of the in-flight network call (replacing the previous one). When the
     * token is already cancelled the hook runs right away.
     */
    void setActiveAbort(Runnable abort) {
        boolean runNow;
        synchronized (lock) {
            runNow = cancelled;
            activeAbort = runNow ? null : abort;
        }
        if (runNow) runQuietly(abort);
    }

    void clearActiveAbort() {
        synchronized (lock) {
            activeAbort = null;
        }
    }

    /**
     * Blocks up to {@code timeoutMs} or until cancelled, whichever comes first.
     *
     * @return true when the token is cancelled (immediately, or while waiting).
     */
    boolean awaitCancelled(long timeoutMs) {
        long deadline = System.nanoTime() + Math.max(0L, timeoutMs) * 1_000_000L;
        synchronized (lock) {
            while (!cancelled) {
                long remainingMs = (deadline - System.nanoTime()) / 1_000_000L;
                if (remainingMs <= 0L) break;
                try {
                    lock.wait(remainingMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return cancelled;
        }
    }

    private static void runQuietly(Runnable r) {
        if (r == null) return;
        try {
            r.run();
        } catch (RuntimeException ignored) {
            // aborting a call must never throw into the canceller
        }
    }
}
