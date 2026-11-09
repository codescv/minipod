package dev.minipod.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLHandshakeException;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import okio.Okio;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Automatic retry with `.part` Range resume: classification, backoff, Retry-After, caps, cancel. */
public class RetryingDownloadTest {

    private static final MediaType AUDIO = MediaType.get("audio/mpeg");

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File finalFile;
    private File partFile;
    private byte[] payload;
    private final List<Long> openedWith = Collections.synchronizedList(new ArrayList<>());
    private final List<Long> sleeps = Collections.synchronizedList(new ArrayList<>());
    private final List<int[]> retries = new ArrayList<>();
    private DownloadCancelToken token;

    @Before
    public void setUp() throws IOException {
        File dir = tmp.newFolder("downloads");
        finalFile = new File(dir, "ep.mp3");
        partFile = new File(dir, "ep.mp3.part");
        payload = new byte[600_000];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i * 13 + 5);
        token = new DownloadCancelToken();
    }

    // ---------------------------------------------------------------- helpers

    private static Response.Builder base(int code) {
        return new Response.Builder()
            .request(new Request.Builder().url("http://127.0.0.1/ep.mp3").build())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("msg");
    }

    private Response rangeAware(long from) {
        if (from <= 0) return base(200).body(ResponseBody.create(payload, AUDIO)).build();
        byte[] rest = Arrays.copyOfRange(payload, (int) from, payload.length);
        return base(206)
            .header("Content-Range", "bytes " + from + "-" + (payload.length - 1) + "/" + payload.length)
            .body(ResponseBody.create(rest, AUDIO))
            .build();
    }

    private static Response status(int code, String retryAfter) {
        Response.Builder b = base(code).body(ResponseBody.create(new byte[0], AUDIO));
        if (retryAfter != null) b.header("Retry-After", retryAfter);
        return b.build();
    }

    /** Serves {@code count} bytes from {@code from} then drops the connection (IOException). */
    private Response dropping(long from, int count, IOException error) {
        byte[] chunk = Arrays.copyOfRange(payload, (int) from, (int) Math.min(payload.length, from + count));
        InputStream in = new InputStream() {
            private final ByteArrayInputStream first = new ByteArrayInputStream(chunk);

            @Override
            public int read() throws IOException {
                byte[] b = new byte[1];
                int n = read(b, 0, 1);
                return n == -1 ? -1 : (b[0] & 0xff);
            }

            @Override
            public int read(byte[] b, int off, int len) throws IOException {
                if (first.available() > 0) return first.read(b, off, Math.min(len, first.available()));
                throw error;
            }
        };
        BufferedSource src = Okio.buffer(Okio.source(in));
        Response.Builder rb = from > 0
            ? base(206).header("Content-Range", "bytes " + from + "-" + (payload.length - 1) + "/" + payload.length)
            : base(200);
        return rb.body(ResponseBody.create(src, AUDIO, payload.length - from)).build();
    }

    private RetryingDownload retrying(DownloadRetryPolicy policy, RetryingDownload.NetworkMonitor net) {
        return new RetryingDownload(
            policy,
            (ms, t) -> {
                sleeps.add(ms);
                return t.isCancelled();
            },
            net,
            () -> 0.5, // no jitter -> exact base delays
            () -> 1_700_000_000_000L,
            5_000L
        );
    }

    private DownloadTransfer.Result run(RetryingDownload r, DownloadTransfer.StreamOpener opener) throws IOException {
        return r.run(
            rs -> {
                openedWith.add(rs);
                return opener.open(rs);
            },
            partFile,
            finalFile,
            token,
            (done, total) -> {},
            250L,
            () -> 0L,
            (next, delay, cause) -> retries.add(new int[] { next, (int) delay })
        );
    }

    // ---------------------------------------------------------------- policy unit tests

    @Test
    public void classification_transientVsPermanent() {
        assertTrue(DownloadRetryPolicy.isTransient(new SocketTimeoutException("timeout")));
        assertTrue(DownloadRetryPolicy.isTransient(new EOFException("eof")));
        assertTrue(DownloadRetryPolicy.isTransient(new ConnectException("refused")));
        assertTrue(DownloadRetryPolicy.isTransient(new UnknownHostException("dns")));
        assertTrue(DownloadRetryPolicy.isTransient(new SSLHandshakeException("tls")));
        assertTrue(DownloadRetryPolicy.isTransient(new SocketException("Software caused connection abort")));
        assertTrue(DownloadRetryPolicy.isTransient(new IOException("connection reset")));
        for (int code : new int[] { 408, 429, 500, 502, 503, 504 }) {
            assertTrue("HTTP " + code, DownloadRetryPolicy.isTransient(new DownloadTransfer.HttpStatusException(code, null)));
        }
        for (int code : new int[] { 400, 401, 403, 404, 410, 416, 501 }) {
            assertFalse("HTTP " + code, DownloadRetryPolicy.isTransient(new DownloadTransfer.HttpStatusException(code, null)));
        }
        assertFalse(DownloadRetryPolicy.isTransient(new DownloadTransfer.CancelledException()));
        assertFalse(DownloadRetryPolicy.isTransient(new DownloadTransfer.DownloadFileException("ENOSPC", null)));
        assertFalse(DownloadRetryPolicy.isTransient(new DownloadRetryPolicy.InvalidDownloadUrlException("bad")));
        assertFalse(DownloadRetryPolicy.isTransient(new IllegalArgumentException("bad url")));
        assertFalse(DownloadRetryPolicy.isTransient(null));
    }

    @Test
    public void backoff_isExponentialWithBoundedJitter() {
        DownloadRetryPolicy p = new DownloadRetryPolicy();
        assertEquals(1_500L, p.backoffMs(0, 0.5));
        assertEquals(4_000L, p.backoffMs(1, 0.5));
        assertEquals(10_000L, p.backoffMs(2, 0.5));
        assertEquals(10_000L, p.backoffMs(7, 0.5));
        assertEquals(1_125L, p.backoffMs(0, 0.0));
        assertEquals(1_875L, p.backoffMs(0, 1.0));
    }

    @Test
    public void parseRetryAfter_secondsAndHttpDate() {
        long now = 1_700_000_000_000L; // Tue, 14 Nov 2023 22:13:20 GMT
        assertEquals(7_000L, DownloadRetryPolicy.parseRetryAfterMs("7", now));
        assertEquals(0L, DownloadRetryPolicy.parseRetryAfterMs(" 0 ", now));
        assertEquals(20_000L, DownloadRetryPolicy.parseRetryAfterMs("Tue, 14 Nov 2023 22:13:40 GMT", now));
        assertEquals(0L, DownloadRetryPolicy.parseRetryAfterMs("Tue, 14 Nov 2023 22:00:00 GMT", now));
        assertEquals(-1L, DownloadRetryPolicy.parseRetryAfterMs("soon", now));
        assertEquals(-1L, DownloadRetryPolicy.parseRetryAfterMs(null, now));
        assertEquals(-1L, DownloadRetryPolicy.parseRetryAfterMs("", now));
    }

    @Test
    public void tracker_threeRetriesPerStallPoint_progressResets_hardCapTen() {
        DownloadRetryPolicy p = new DownloadRetryPolicy();
        IOException err = new IOException("reset");
        DownloadRetryPolicy.Tracker t = p.newTracker();
        for (int i = 0; i < 3; i++) {
            t.beginAttempt();
            assertTrue(t.onFailure(err, 0L, false, 0.5, 0L).retry);
        }
        t.beginAttempt();
        assertFalse("4th consecutive failure without progress gives up", t.onFailure(err, 0L, false, 0.5, 0L).retry);

        // Every attempt moves >= 256 KB forward: counter resets, but 10 attempts is the hard cap.
        DownloadRetryPolicy.Tracker progressing = p.newTracker();
        int attempts = 0;
        while (true) {
            progressing.beginAttempt();
            attempts++;
            if (!progressing.onFailure(err, 300_000L, false, 0.5, 0L).retry) break;
            assertTrue(attempts < 50);
        }
        assertEquals(DownloadRetryPolicy.DEFAULT_MAX_TOTAL_ATTEMPTS, attempts);

        DownloadRetryPolicy.Tracker cancelled = p.newTracker();
        cancelled.beginAttempt();
        assertFalse(cancelled.onFailure(err, 0L, true, 0.5, 0L).retry);
    }

    @Test
    public void tracker_retryAfterHonored_andCapped() {
        DownloadRetryPolicy p = new DownloadRetryPolicy();
        DownloadRetryPolicy.Tracker t = p.newTracker();
        t.beginAttempt();
        assertEquals(7_000L, t.onFailure(new DownloadTransfer.HttpStatusException(503, "7"), 0L, false, 0.5, 0L).delayMs);
        t.beginAttempt();
        assertEquals(30_000L, t.onFailure(new DownloadTransfer.HttpStatusException(429, "3600"), 0L, false, 0.5, 0L).delayMs);
        // Retry-After shorter than the backoff: never hammer faster than the backoff.
        DownloadRetryPolicy.Tracker t2 = p.newTracker();
        t2.beginAttempt();
        assertEquals(1_500L, t2.onFailure(new DownloadTransfer.HttpStatusException(503, "1"), 0L, false, 0.5, 0L).delayMs);
    }

    // ---------------------------------------------------------------- end-to-end retry loop

    @Test
    public void midStreamDrop_retriesWithRangeResume_andCompletes() throws IOException {
        AtomicInteger call = new AtomicInteger();
        DownloadTransfer.Result r = run(retrying(new DownloadRetryPolicy(), null), rs -> {
            if (call.incrementAndGet() == 1) return dropping(rs, 100_000, new IOException("connection reset"));
            return rangeAware(rs);
        });
        assertEquals(Arrays.asList(0L, 100_000L), openedWith);
        assertEquals(Arrays.asList(1_500L), sleeps);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
        assertFalse(partFile.exists());
        assertEquals(payload.length, r.size);
        assertEquals(1, retries.size());
        assertEquals(2, retries.get(0)[0]);
    }

    @Test
    public void socketTimeoutAndEof_areRetried_resumingFromPart() throws IOException {
        AtomicInteger call = new AtomicInteger();
        run(retrying(new DownloadRetryPolicy(), null), rs -> {
            int n = call.incrementAndGet();
            if (n == 1) return dropping(rs, 50_000, new SocketTimeoutException("timeout"));
            if (n == 2) return dropping(rs, 50_000, new EOFException("unexpected end of stream"));
            return rangeAware(rs);
        });
        assertEquals(Arrays.asList(0L, 50_000L, 100_000L), openedWith);
        assertEquals(Arrays.asList(1_500L, 4_000L), sleeps);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void http503WithRetryAfter_andThen429_waitsAndKeepsPart() throws IOException {
        Files.write(partFile.toPath(), Arrays.copyOf(payload, 12_345));
        AtomicInteger call = new AtomicInteger();
        run(retrying(new DownloadRetryPolicy(), null), rs -> {
            int n = call.incrementAndGet();
            if (n == 1) return status(503, "7");
            if (n == 2) return status(429, null);
            return rangeAware(rs);
        });
        assertEquals(Arrays.asList(12_345L, 12_345L, 12_345L), openedWith);
        assertEquals(Arrays.asList(7_000L, 4_000L), sleeps);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void http404And401_areNotRetried() throws IOException {
        for (int code : new int[] { 404, 401, 403, 410 }) {
            openedWith.clear();
            sleeps.clear();
            try {
                run(retrying(new DownloadRetryPolicy(), null), rs -> status(code, null));
                fail("expected HTTP " + code);
            } catch (DownloadTransfer.HttpStatusException e) {
                assertEquals(code, e.code);
            }
            assertEquals(1, openedWith.size());
            assertTrue(sleeps.isEmpty());
        }
    }

    @Test
    public void exhaustedRetries_throwLastError_andKeepPartForManualResume() throws IOException {
        try {
            run(retrying(new DownloadRetryPolicy(), null), rs -> dropping(rs, 1_000, new IOException("reset")));
            fail("expected IOException");
        } catch (IOException e) {
            assertEquals("reset", e.getMessage());
        }
        assertEquals(Arrays.asList(0L, 1_000L, 2_000L, 3_000L), openedWith);
        assertEquals(Arrays.asList(1_500L, 4_000L, 10_000L), sleeps);
        assertTrue(partFile.exists());
        assertEquals(4_000L, partFile.length());
        assertFalse(finalFile.exists());
    }

    @Test
    public void substantialProgressResetsCounter_butHardCapStopsAtTenAttempts() throws IOException {
        payload = new byte[4_000_000];
        try {
            run(retrying(new DownloadRetryPolicy(), null), rs -> dropping(rs, 300_000, new IOException("flaky")));
            fail("expected IOException");
        } catch (IOException expected) {
            // gave up
        }
        assertEquals(10, openedWith.size());
        assertEquals(9, sleeps.size());
        // Counter reset after each >= 256 KB attempt: always the first backoff step.
        for (long s : sleeps) assertEquals(1_500L, s);
        assertEquals(3_000_000L, partFile.length());
    }

    @Test
    public void cancelDuringBackoff_abortsImmediately_andDeletesPart() throws Exception {
        // Real interruptible wait: a 10 s backoff would hang the test if cancel did not wake it.
        DownloadRetryPolicy longDelays = new DownloadRetryPolicy(3, 10, 256 * 1024, 30_000, new long[] { 10_000L });
        RetryingDownload finalR = new RetryingDownload(
            longDelays, RetryingDownload.TOKEN_SLEEPER, null, () -> 0.5, System::currentTimeMillis, 0L
        );
        Throwable[] thrown = { null };
        Thread worker = new Thread(() -> {
            try {
                run(finalR, rs -> dropping(rs, 5_000, new IOException("reset")));
            } catch (Throwable t) {
                thrown[0] = t;
            }
        });
        worker.start();
        long deadline = System.currentTimeMillis() + 5_000;
        while (retries.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(2);
        assertEquals(1, retries.size());
        assertTrue(partFile.exists());
        long t0 = System.nanoTime();
        token.cancel();
        worker.join(5_000);
        long tookMs = (System.nanoTime() - t0) / 1_000_000L;
        assertFalse(worker.isAlive());
        assertTrue("cancel took " + tookMs + "ms", tookMs < 1_000);
        assertTrue(String.valueOf(thrown[0]), thrown[0] instanceof DownloadTransfer.CancelledException);
        assertFalse(partFile.exists());
        assertEquals(1, openedWith.size());
    }

    @Test
    public void offlineDuringBackoff_waitsForNetworkBeforeRetrying() throws IOException {
        AtomicInteger probes = new AtomicInteger();
        AtomicInteger call = new AtomicInteger();
        run(retrying(new DownloadRetryPolicy(), () -> probes.incrementAndGet() > 3), rs -> {
            if (call.incrementAndGet() == 1) {
                return dropping(rs, 10_000, new SocketException("Software caused connection abort"));
            }
            return rangeAware(rs);
        });
        // backoff, then 3 x 1 s polls while offline, then the resumed attempt.
        assertEquals(Arrays.asList(1_500L, 1_000L, 1_000L, 1_000L), sleeps);
        assertEquals(Arrays.asList(0L, 10_000L), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void cancelledBeforeStart_neverOpensConnection() {
        token.cancel();
        try {
            run(retrying(new DownloadRetryPolicy(), null), this::rangeAware);
            fail("expected cancel");
        } catch (IOException e) {
            assertTrue(e instanceof DownloadTransfer.CancelledException);
        }
        assertTrue(openedWith.isEmpty());
    }

    @Test
    public void fileSystemError_isNotRetried() throws IOException {
        // A directory where the `.part` file should be -> cannot open for writing.
        assertTrue(partFile.mkdirs());
        try {
            run(retrying(new DownloadRetryPolicy(), null), this::rangeAware);
            fail("expected file error");
        } catch (DownloadTransfer.DownloadFileException expected) {
            // not retried
        }
        assertTrue(sleeps.isEmpty());
    }
}
