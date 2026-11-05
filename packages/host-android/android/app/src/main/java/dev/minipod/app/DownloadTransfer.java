package dev.minipod.app;

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
 * on any other failure it is kept so a later call can resume from its length via Range.
 */
final class DownloadTransfer {

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
                throw new IOException("Download failed with HTTP " + code);
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

            try (InputStream in = body.byteStream();
                 RandomAccessFile raf = new RandomAccessFile(partFile, "rw")) {
                if (appending) {
                    raf.setLength(resumeFrom);
                    raf.seek(resumeFrom);
                } else {
                    raf.setLength(0L);
                }
                // Immediate snapshot so the UI shows % (incl. resumed offset) without waiting.
                sink.onProgress(written, totalBytes);
                long lastEmitMs = clock.getAsLong();

                byte[] buf = new byte[16_384];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancel.isCancelled()) {
                        throw new IOException("Canceled");
                    }
                    raf.write(buf, 0, n);
                    written += n;
                    long now = clock.getAsLong();
                    if (now - lastEmitMs >= throttleMs) {
                        lastEmitMs = now;
                        sink.onProgress(written, totalBytes);
                    }
                }
                raf.getFD().sync();
            }

            if (cancel.isCancelled()) {
                throw new IOException("Canceled");
            }
            if (finalFile.exists() && !finalFile.delete()) {
                throw new IOException("Unable to replace existing file " + finalFile);
            }
            if (!partFile.renameTo(finalFile)) {
                throw new IOException("Unable to rename .part file to " + finalFile);
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
