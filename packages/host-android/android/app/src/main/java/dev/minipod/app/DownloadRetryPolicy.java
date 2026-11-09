package dev.minipod.app;

import java.io.FileNotFoundException;
import java.net.MalformedURLException;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Automatic-retry policy for episode downloads (pure Java, JVM-unit-testable).
 *
 * <ul>
 *   <li>Transient (retried): network / DNS / TLS / connect errors, socket timeouts, mid-stream
 *       EOF / connection reset / premature close, and HTTP 408 / 429 / 500 / 502 / 503 / 504.
 *   <li>Permanent (never retried): other HTTP 4xx (400 / 401 / 403 / 404 / 410 ...), invalid
 *       URL, local file-system errors (disk full, bad path) and user cancellation.
 * </ul>
 *
 * Up to {@link #maxRetries} consecutive retries per stall point with exponential backoff + jitter
 * (~1.5 s, ~4 s, ~10 s); `Retry-After` (seconds or HTTP-date) on 429 / 503 is honored, capped at
 * {@link #retryAfterCapMs}. An attempt that wrote at least {@link #progressResetBytes} before
 * dropping resets the consecutive-failure counter (a big episode over a flaky mobile network keeps
 * moving forward), bounded by {@link #maxTotalAttempts} so an endless loop is impossible.
 */
final class DownloadRetryPolicy {

    static final int DEFAULT_MAX_RETRIES = 3;
    static final int DEFAULT_MAX_TOTAL_ATTEMPTS = 10;
    static final long DEFAULT_PROGRESS_RESET_BYTES = 256L * 1024L;
    static final long DEFAULT_RETRY_AFTER_CAP_MS = 30_000L;
    static final long[] DEFAULT_DELAYS_MS = { 1_500L, 4_000L, 10_000L };
    /** +/- fraction of jitter applied to each base delay. */
    static final double JITTER_FRACTION = 0.25;

    final int maxRetries;
    final int maxTotalAttempts;
    final long progressResetBytes;
    final long retryAfterCapMs;
    private final long[] delaysMs;

    DownloadRetryPolicy() {
        this(DEFAULT_MAX_RETRIES, DEFAULT_MAX_TOTAL_ATTEMPTS, DEFAULT_PROGRESS_RESET_BYTES,
            DEFAULT_RETRY_AFTER_CAP_MS, DEFAULT_DELAYS_MS);
    }

    DownloadRetryPolicy(
        int maxRetries,
        int maxTotalAttempts,
        long progressResetBytes,
        long retryAfterCapMs,
        long[] delaysMs
    ) {
        this.maxRetries = Math.max(0, maxRetries);
        this.maxTotalAttempts = Math.max(1, maxTotalAttempts);
        this.progressResetBytes = progressResetBytes;
        this.retryAfterCapMs = Math.max(0L, retryAfterCapMs);
        this.delaysMs = delaysMs != null && delaysMs.length > 0 ? delaysMs.clone() : DEFAULT_DELAYS_MS.clone();
    }

    static boolean isRetryableStatus(int code) {
        return code == 408 || code == 429 || code == 500 || code == 502 || code == 503 || code == 504;
    }

    /** True for failures worth another attempt (see class doc). */
    static boolean isTransient(Throwable error) {
        if (error == null) return false;
        if (error instanceof DownloadTransfer.CancelledException) return false;
        if (error instanceof DownloadTransfer.HttpStatusException) {
            return isRetryableStatus(((DownloadTransfer.HttpStatusException) error).code);
        }
        if (error instanceof DownloadTransfer.DownloadFileException) return false;
        if (error instanceof FileNotFoundException) return false;
        if (error instanceof MalformedURLException) return false;
        if (error instanceof InvalidDownloadUrlException) return false;
        // SocketTimeoutException, EOFException, ConnectException, UnknownHostException,
        // SSLException, SocketException ("Software caused connection abort" on Wi-Fi <-> 5G),
        // okhttp StreamResetException / ProtocolException ("unexpected end of stream") ...
        return error instanceof java.io.IOException;
    }

    /** Backoff before retry #{@code retryIndex} (0-based), jittered by {@code random} in [0, 1). */
    long backoffMs(int retryIndex, double random) {
        long base = delaysMs[Math.min(Math.max(0, retryIndex), delaysMs.length - 1)];
        double r = Double.isNaN(random) ? 0.5 : Math.min(1.0, Math.max(0.0, random));
        double factor = 1.0 + JITTER_FRACTION * (2.0 * r - 1.0);
        return Math.max(0L, Math.round(base * factor));
    }

    /**
     * Parses `Retry-After` (delta-seconds or IMF-fixdate / RFC 850 / asctime HTTP-date).
     *
     * @return milliseconds to wait (>= 0) or -1 when absent/unparseable.
     */
    static long parseRetryAfterMs(String header, long nowWallMs) {
        if (header == null) return -1L;
        String v = header.trim();
        if (v.isEmpty()) return -1L;
        if (v.matches("\\d+")) {
            try {
                long secs = Long.parseLong(v);
                return secs > Long.MAX_VALUE / 1000L ? Long.MAX_VALUE : secs * 1000L;
            } catch (NumberFormatException e) {
                return -1L;
            }
        }
        String[] patterns = {
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEEE, dd-MMM-yy HH:mm:ss zzz",
            "EEE MMM d HH:mm:ss yyyy",
        };
        for (String p : patterns) {
            SimpleDateFormat fmt = new SimpleDateFormat(p, Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
            fmt.setLenient(false);
            ParsePosition pos = new ParsePosition(0);
            Date d = fmt.parse(v, pos);
            if (d != null && pos.getIndex() > 0) {
                return Math.max(0L, d.getTime() - nowWallMs);
            }
        }
        return -1L;
    }

    /** Invalid / unsupported enclosure URL (never retried). */
    static final class InvalidDownloadUrlException extends java.io.IOException {
        InvalidDownloadUrlException(String message) {
            super(message);
        }
    }

    /** Outcome of {@link Tracker#onFailure}. */
    static final class Decision {
        final boolean retry;
        final long delayMs;
        /** 1-based number of the next attempt when {@link #retry}. */
        final int nextAttempt;

        Decision(boolean retry, long delayMs, int nextAttempt) {
            this.retry = retry;
            this.delayMs = delayMs;
            this.nextAttempt = nextAttempt;
        }
    }

    /** Mutable per-download attempt accounting. Not thread-safe (one download thread). */
    final class Tracker {
        private int consecutiveFailures;
        private int totalAttempts;

        /** Call before each attempt; returns the 1-based attempt number. */
        int beginAttempt() {
            return ++totalAttempts;
        }

        int totalAttempts() {
            return totalAttempts;
        }

        int consecutiveFailures() {
            return consecutiveFailures;
        }

        /**
         * @param bytesWrittenThisAttempt bytes appended to `.part` by the failed attempt.
         * @param cancelled               the user stopped the download (never retried).
         */
        Decision onFailure(
            Throwable error,
            long bytesWrittenThisAttempt,
            boolean cancelled,
            double random,
            long nowWallMs
        ) {
            if (cancelled || !isTransient(error)) {
                return new Decision(false, 0L, totalAttempts);
            }
            if (progressResetBytes > 0L && bytesWrittenThisAttempt >= progressResetBytes) {
                // Substantial forward progress: this is a fresh stall point.
                consecutiveFailures = 0;
            }
            consecutiveFailures++;
            if (consecutiveFailures > maxRetries || totalAttempts >= maxTotalAttempts) {
                return new Decision(false, 0L, totalAttempts);
            }
            long delay = backoffMs(consecutiveFailures - 1, random);
            if (error instanceof DownloadTransfer.HttpStatusException) {
                DownloadTransfer.HttpStatusException http = (DownloadTransfer.HttpStatusException) error;
                if (http.code == 429 || http.code == 503) {
                    long retryAfter = parseRetryAfterMs(http.retryAfter, nowWallMs);
                    if (retryAfter >= 0L) {
                        delay = Math.min(retryAfterCapMs, Math.max(delay, retryAfter));
                    }
                }
            }
            return new Decision(true, delay, totalAttempts + 1);
        }
    }

    Tracker newTracker() {
        return new Tracker();
    }
}
