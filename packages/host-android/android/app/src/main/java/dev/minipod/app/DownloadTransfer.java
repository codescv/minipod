package dev.minipod.app;

import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Streams an episode download into a `.part` file with HTTP Range resume, then atomically renames it
 * to the final path. Pure Java + okhttp3 (no android.*) so it is JVM-unit-testable.
 *
 * <p>Failure semantics: when the transfer was cancelled by the user the `.part` file is deleted;
 * on any other failure it is kept (every written byte is already on disk: `RandomAccessFile`
 * writes are unbuffered) so a later attempt can resume from its length via Range.
 *
 * <p>Failures are typed so {@link DownloadRetryPolicy} can tell transient from permanent errors:
 * {@link HttpStatusException} (non-2xx), {@link DownloadFileException} (local disk / path error,
 * e.g. ENOSPC), {@link CancelledException} (user stop), any other {@link IOException} is a
 * network-level failure (timeout, reset, premature EOF, DNS, TLS, ...).
 */
final class DownloadTransfer {

    /** Non-2xx HTTP status (after the 416 restart); carries `Retry-After` for 429 / 503. */
    static final class HttpStatusException extends IOException {
        final int code;
        /** Raw `Retry-After` header value, or null. */
        final String retryAfter;

        HttpStatusException(int code, String retryAfter) {
            super("Download failed with HTTP " + code);
            this.code = code;
            this.retryAfter = retryAfter;
        }
    }

    /** Local file-system failure (disk full, unwritable path, rename failure): never retried. */
    static final class DownloadFileException extends IOException {
        DownloadFileException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** The user stopped the download. */
    static final class CancelledException extends IOException {
        CancelledException() {
            super("Canceled");
        }
    }

    /** Opens the HTTP response; sends `Range: bytes=<resumeFrom>-` when resumeFrom > 0. */
    interface StreamOpener {
        Response open(long resumeFrom) throws IOException;
    }

    interface CancelCheck {
        boolean isCancelled();
    }

    interface ProgressSink {
        /** @param totalBytes -1 when unknown. */
        void onProgress(long bytesDownloaded, long totalBytes);
    }

    static final class Result {
        final long size;
        /** Content-Type response header, or null. */
        final String contentType;

        Result(long size, String contentType) {
            this.size = size;
            this.contentType = contentType;
        }
    }

    private static final Pattern CONTENT_RANGE =
        Pattern.compile("^\\s*bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)\\s*$", Pattern.CASE_INSENSITIVE);

    private DownloadTransfer() {}

    static Result run(
        StreamOpener opener,
        File partFile,
        File finalFile,
        long resumeFrom,
        CancelCheck cancel,
        ProgressSink sink,
        long throttleMs,
        LongSupplier clock
    ) throws IOException {
        try {
            return runInner(opener, partFile, finalFile, resumeFrom, cancel, sink, throttleMs, clock);
        } catch (IOException | RuntimeException e) {
            if (cancel.isCancelled()) {
                //noinspection ResultOfMethodCallIgnored
                partFile.delete();
            }
            throw e;
        }
    }

    private static Result runInner(
        StreamOpener opener,
        File partFile,
        File finalFile,
        long resumeFrom,
        CancelCheck cancel,
        ProgressSink sink,
        long throttleMs,
        LongSupplier clock
    ) throws IOException {
        // Never resume past what is actually on disk (would leave a hole of zero bytes).
        long onDisk = partFile.exists() ? partFile.length() : 0L;
        if (resumeFrom < 0L || resumeFrom > onDisk) {
            resumeFrom = onDisk;
        }

        Response resp = opener.open(resumeFrom);
        if (resp.code() == 416 && resumeFrom > 0L) {
            // Range not satisfiable: the `.part` is stale/oversized. Restart once from scratch.
            resp.close();
            //noinspection ResultOfMethodCallIgnored
            partFile.delete();
            resumeFrom = 0L;
            resp = opener.open(0L);
        }

        try {
            int code = resp.code();
            if (code < 200 || code >= 300) {
                throw new HttpStatusException(code, resp.header("Retry-After"));
            }
            ResponseBody body = resp.body();
            if (body == null) {
                throw new IOException("Download response has empty body");
            }

            boolean appending = code == 206 && resumeFrom > 0L;
            long contentLen = body.contentLength();
            long totalBytes = -1L;
            if (appending) {
                long[] range = parseContentRange(resp.header("Content-Range"));
                if (range != null && range[0] != resumeFrom) {
                    // Server returned a different window than requested; restart cleanly.
                    resp.close();
                    //noinspection ResultOfMethodCallIgnored
                    partFile.delete();
                    return runInner(opener, partFile, finalFile, 0L, cancel, sink, throttleMs, clock);
                }
                if (range != null && range[2] > 0L) {
                    totalBytes = range[2];
                } else if (contentLen > 0L) {
                    totalBytes = resumeFrom + contentLen;
                }
            } else if (code == 206) {
                long[] range = parseContentRange(resp.header("Content-Range"));
                if (range != null && range[2] > 0L) {
                    totalBytes = range[2];
                } else if (contentLen > 0L) {
                    totalBytes = contentLen;
                }
            } else if (contentLen > 0L) {
                totalBytes = contentLen;
            }

            long written = appending ? resumeFrom : 0L;

            RandomAccessFile raf;
            try {
                raf = new RandomAccessFile(partFile, "rw");
            } catch (IOException e) {
                throw new DownloadFileException("Unable to open " + partFile + ": " + e.getMessage(), e);
            }
            try (InputStream in = body.byteStream(); RandomAccessFile out = raf) {
                try {
                    if (appending) {
                        out.setLength(resumeFrom);
                        out.seek(resumeFrom);
                    } else {
                        out.setLength(0L);
                    }
                } catch (IOException e) {
                    throw new DownloadFileException("Unable to prepare " + partFile + ": " + e.getMessage(), e);
                }
                // Immediate snapshot so the UI shows % (incl. resumed offset) without waiting.
                sink.onProgress(written, totalBytes);
                long lastEmitMs = clock.getAsLong();

                byte[] buf = new byte[16_384];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancel.isCancelled()) {
                        throw new CancelledException();
                    }
                    try {
                        out.write(buf, 0, n);
                    } catch (IOException e) {
                        throw new DownloadFileException("Unable to write " + partFile + ": " + e.getMessage(), e);
                    }
                    written += n;
                    long now = clock.getAsLong();
                    if (now - lastEmitMs >= throttleMs) {
                        lastEmitMs = now;
                        sink.onProgress(written, totalBytes);
                    }
                }
                if (cancel.isCancelled()) {
                    throw new CancelledException();
                }
                if (totalBytes > 0L && written < totalBytes) {
                    // Server / proxy closed the connection early: keep `.part` and resume via Range.
                    throw new EOFException(
                        "Premature end of stream (" + written + " of " + totalBytes + " bytes)"
                    );
                }
                try {
                    out.getFD().sync();
                } catch (IOException e) {
                    throw new DownloadFileException("Unable to sync " + partFile + ": " + e.getMessage(), e);
                }
            }
            if (cancel.isCancelled()) {
                throw new CancelledException();
            }
            if (finalFile.exists() && !finalFile.delete()) {
                throw new DownloadFileException("Unable to replace existing file " + finalFile, null);
            }
            if (!partFile.renameTo(finalFile)) {
                throw new DownloadFileException("Unable to rename .part file to " + finalFile, null);
            }
            return new Result(finalFile.length(), resp.header("Content-Type"));
        } finally {
            resp.close();
        }
    }

    /** Returns {start, end, total(-1 if '*')} or null if absent/unparseable. */
    static long[] parseContentRange(String header) {
        if (header == null) return null;
        Matcher m = CONTENT_RANGE.matcher(header);
        if (!m.matches()) return null;
        try {
            long start = Long.parseLong(m.group(1));
            long end = Long.parseLong(m.group(2));
            String t = m.group(3);
            long total = "*".equals(t) ? -1L : Long.parseLong(t);
            return new long[] { start, end, total };
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
