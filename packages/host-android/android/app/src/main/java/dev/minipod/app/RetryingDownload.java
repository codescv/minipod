package dev.minipod.app;

import java.io.File;
import java.io.IOException;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;

/**
 * Runs {@link DownloadTransfer} with automatic, progress-preserving retries (pure Java +
 * okhttp3, JVM-unit-testable).
 *
 * <p>Every failed attempt keeps its `.part` bytes; the next attempt resumes from
 * `partFile.length()` with `Range: bytes=<written>-`. While retrying the episode stays `RUNNING`
 * (the {@link Listener} is told about each retry so the UI never flashes `FAILED`); only when
 * {@link DownloadRetryPolicy} gives up is the last error rethrown (`.part` kept for a manual
 * `继续下载`). Cancelling the {@link DownloadCancelToken} aborts the in-flight call and wakes the
 * backoff / offline wait immediately.
 */
final class RetryingDownload {

    /** Waits {@code ms} unless cancelled first; returns true when cancelled. */
    interface Sleeper {
        boolean sleep(long ms, DownloadCancelToken token);
    }

    /** Connectivity probe (Android: `ConnectivityManager`). */
    interface NetworkMonitor {
        boolean isConnected();
    }

    interface Listener {
        /** A transient failure will be retried as attempt {@code nextAttempt} after {@code delayMs}. */
        void onRetryScheduled(int nextAttempt, long delayMs, Throwable cause);
    }

    /** Max extra wait for connectivity to come back (Wi-Fi <-> cellular switch) per retry. */
    static final long DEFAULT_OFFLINE_WAIT_MS = 45_000L;
    static final long OFFLINE_POLL_MS = 1_000L;

    static final Sleeper TOKEN_SLEEPER = (ms, token) -> token.awaitCancelled(ms);
    static final NetworkMonitor ALWAYS_ONLINE = () -> true;

    private final DownloadRetryPolicy policy;
    private final Sleeper sleeper;
    private final NetworkMonitor network;
    private final DoubleSupplier random;
    private final LongSupplier wallClock;
    private final long offlineWaitMs;

    RetryingDownload(
        DownloadRetryPolicy policy,
        Sleeper sleeper,
        NetworkMonitor network,
        DoubleSupplier random,
        LongSupplier wallClock,
        long offlineWaitMs
    ) {
        this.policy = policy;
        this.sleeper = sleeper != null ? sleeper : TOKEN_SLEEPER;
        this.network = network != null ? network : ALWAYS_ONLINE;
        this.random = random != null ? random : Math::random;
        this.wallClock = wallClock != null ? wallClock : System::currentTimeMillis;
        this.offlineWaitMs = Math.max(0L, offlineWaitMs);
    }

    DownloadTransfer.Result run(
        DownloadTransfer.StreamOpener opener,
        File partFile,
        File finalFile,
        DownloadCancelToken token,
        DownloadTransfer.ProgressSink sink,
        long throttleMs,
        LongSupplier clock,
        Listener listener
    ) throws IOException {
        DownloadRetryPolicy.Tracker tracker = policy.newTracker();
        while (true) {
            if (token.isCancelled()) {
                deleteQuietly(partFile);
                throw new DownloadTransfer.CancelledException();
            }
            tracker.beginAttempt();
            long startOffset = partFile.exists() ? partFile.length() : 0L;
            long[] attemptStart = { -1L };
            DownloadTransfer.ProgressSink recordingSink = (done, total) -> {
                if (attemptStart[0] < 0L) attemptStart[0] = done;
                sink.onProgress(done, total);
            };
            try {
                return DownloadTransfer.run(
                    opener, partFile, finalFile, startOffset, token, recordingSink, throttleMs, clock
                );
            } catch (IOException | RuntimeException e) {
                if (token.isCancelled()) {
                    deleteQuietly(partFile);
                    throw e instanceof DownloadTransfer.CancelledException
                        ? (DownloadTransfer.CancelledException) e
                        : new DownloadTransfer.CancelledException();
                }
                long onDisk = partFile.exists() ? partFile.length() : 0L;
                long base = attemptStart[0] >= 0L ? attemptStart[0] : startOffset;
                long writtenThisAttempt = Math.max(0L, onDisk - base);
                DownloadRetryPolicy.Decision d = tracker.onFailure(
                    e, writtenThisAttempt, false, random.getAsDouble(), wallClock.getAsLong()
                );
                if (!d.retry) {
                    throw e;
                }
                if (listener != null) {
                    listener.onRetryScheduled(d.nextAttempt, d.delayMs, e);
                }
                if (sleeper.sleep(d.delayMs, token)) {
                    deleteQuietly(partFile);
                    throw new DownloadTransfer.CancelledException();
                }
                // Offline (e.g. mid Wi-Fi <-> 5G handover): wait briefly for the network instead of
                // burning the remaining retries instantly.
                long waited = 0L;
                while (!network.isConnected() && waited < offlineWaitMs) {
                    long step = Math.min(OFFLINE_POLL_MS, offlineWaitMs - waited);
                    if (sleeper.sleep(step, token)) {
                        deleteQuietly(partFile);
                        throw new DownloadTransfer.CancelledException();
                    }
                    waited += step;
                }
            }
        }
    }

    private static void deleteQuietly(File f) {
        if (f != null && f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
