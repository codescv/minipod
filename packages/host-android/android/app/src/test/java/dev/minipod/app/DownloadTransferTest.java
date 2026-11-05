package dev.minipod.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
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

public class DownloadTransferTest {

    private static final MediaType AUDIO = MediaType.get("audio/mpeg");

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File finalFile;
    private File partFile;
    private byte[] payload;
    private final List<long[]> progress = new ArrayList<>();
    private final List<Long> openedWith = new ArrayList<>();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);

    @Before
    public void setUp() throws IOException {
        File dir = tmp.newFolder("downloads");
        finalFile = new File(dir, "ep.mp3");
        partFile = new File(dir, "ep.mp3.part");
        payload = new byte[50_000];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i * 31 + 7);
        }
    }

    // ---------------------------------------------------------------- helpers

    private static Response.Builder base(int code) {
        return new Response.Builder()
            .request(new Request.Builder().url("http://127.0.0.1/ep.mp3").build())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("msg")
            .header("Content-Type", "audio/mpeg");
    }

    private static Response full(byte[] bytes) {
        return base(200).body(ResponseBody.create(bytes, AUDIO)).build();
    }

    private static Response partial(byte[] all, long from) {
        byte[] rest = Arrays.copyOfRange(all, (int) from, all.length);
        return base(206)
            .header("Content-Range", "bytes " + from + "-" + (all.length - 1) + "/" + all.length)
            .body(ResponseBody.create(rest, AUDIO))
            .build();
    }

    private static Response status(int code) {
        return base(code).body(ResponseBody.create(new byte[0], AUDIO)).build();
    }

    private static Response streaming(InputStream in, long contentLength) {
        BufferedSource src = Okio.buffer(Okio.source(in));
        return base(200).body(ResponseBody.create(src, AUDIO, contentLength)).build();
    }

    private void writePart(int n) throws IOException {
        try (FileOutputStream out = new FileOutputStream(partFile)) {
            out.write(payload, 0, n);
        }
    }

    private DownloadTransfer.Result run(DownloadTransfer.StreamOpener opener, long resumeFrom, long clockStep)
        throws IOException {
        long[] t = { 0L };
        return DownloadTransfer.run(
            rs -> {
                openedWith.add(rs);
                return opener.open(rs);
            },
            partFile,
            finalFile,
            resumeFrom,
            cancelled::get,
            (done, total) -> progress.add(new long[] { done, total }),
            250L,
            () -> (t[0] += clockStep)
        );
    }

    /** Returns `prefix` (in small reads) then throws; optionally flips `cancelled` before throwing. */
    private static InputStream failingAfter(byte[] prefix, AtomicBoolean cancelOnSecondRead, boolean thenMore) {
        return new InputStream() {
            private final ByteArrayInputStream first = new ByteArrayInputStream(prefix);
            private int reads;

            @Override
            public int read() throws IOException {
                byte[] b = new byte[1];
                int n = read(b, 0, 1);
                return n == -1 ? -1 : (b[0] & 0xff);
            }

            @Override
            public int read(byte[] b, int off, int len) throws IOException {
                reads++;
                if (first.available() > 0) {
                    return first.read(b, off, Math.min(len, first.available()));
                }
                if (cancelOnSecondRead != null) {
                    cancelOnSecondRead.set(true);
                    if (thenMore) {
                        Arrays.fill(b, off, off + Math.min(len, 100), (byte) 1);
                        return Math.min(len, 100);
                    }
                }
                throw new IOException("connection reset");
            }
        };
    }

    // ---------------------------------------------------------------- tests

    @Test
    public void fresh200_writesFullPayload_andEmitsInitialSnapshot() throws IOException {
        DownloadTransfer.Result r = run(rs -> full(payload), 0L, 0L);

        assertEquals(Arrays.asList(0L), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
        assertFalse(partFile.exists());
        assertEquals(payload.length, r.size);
        assertEquals("audio/mpeg", r.contentType);
        // Clock frozen -> only the immediate initial snapshot.
        assertEquals(1, progress.size());
        assertArrayEquals(new long[] { 0L, payload.length }, progress.get(0));
    }

    @Test
    public void progressIsThrottledByClock_andReachesTotal() throws IOException {
        run(rs -> full(payload), 0L, 300L);

        assertTrue(progress.size() > 1);
        assertArrayEquals(new long[] { 0L, payload.length }, progress.get(0));
        assertArrayEquals(new long[] { payload.length, payload.length }, progress.get(progress.size() - 1));
    }

    @Test
    public void existingPart_resumesWithRange206_andAppends() throws IOException {
        int n = 12_345;
        writePart(n);

        run(rs -> partial(payload, rs), n, 0L);

        assertEquals(Arrays.asList((long) n), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
        assertFalse(partFile.exists());
        assertArrayEquals(new long[] { n, payload.length }, progress.get(0));
    }

    @Test
    public void resumeFromBeyondPartLength_isClampedToOnDiskBytes() throws IOException {
        int n = 1_000;
        writePart(n);

        run(rs -> partial(payload, rs), 99_999L, 0L);

        assertEquals(Arrays.asList((long) n), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void range416_deletesPart_andRetriesFromZero() throws IOException {
        int n = 4_000;
        writePart(n);

        run(rs -> rs > 0 ? status(416) : full(payload), n, 0L);

        assertEquals(Arrays.asList((long) n, 0L), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
        assertFalse(partFile.exists());
        assertArrayEquals(new long[] { 0L, payload.length }, progress.get(0));
    }

    @Test
    public void range416Twice_failsWithHttp416() throws IOException {
        writePart(10);
        try {
            run(rs -> status(416), 10L, 0L);
            fail("expected IOException");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("HTTP 416"));
        }
        assertEquals(Arrays.asList(10L, 0L), openedWith);
    }

    @Test
    public void streamErrorWhileNotCancelled_keepsPartWithWrittenBytes() throws IOException {
        byte[] prefix = Arrays.copyOf(payload, 7_000);
        try {
            run(rs -> streaming(failingAfter(prefix, null, false), payload.length), 0L, 0L);
            fail("expected IOException");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("connection reset"));
        }
        assertTrue(partFile.exists());
        assertArrayEquals(prefix, Files.readAllBytes(partFile.toPath()));
        assertFalse(finalFile.exists());
    }

    @Test
    public void cancelledMidStream_deletesPart() throws IOException {
        byte[] prefix = Arrays.copyOf(payload, 7_000);
        try {
            run(rs -> streaming(failingAfter(prefix, cancelled, true), payload.length), 0L, 0L);
            fail("expected IOException");
        } catch (IOException e) {
            assertEquals("Canceled", e.getMessage());
        }
        assertFalse(partFile.exists());
        assertFalse(finalFile.exists());
    }

    @Test
    public void cancelledThenStreamError_deletesPart() throws IOException {
        byte[] prefix = Arrays.copyOf(payload, 7_000);
        try {
            run(rs -> streaming(failingAfter(prefix, cancelled, false), payload.length), 0L, 0L);
            fail("expected IOException");
        } catch (IOException expected) {
            // okhttp Call.cancel() surfaces as a stream IOException.
        }
        assertFalse(partFile.exists());
    }

    @Test
    public void server200ToRangeRequest_rewritesFromZero() throws IOException {
        int n = 9_000;
        writePart(n);

        run(rs -> full(payload), n, 0L);

        assertEquals(Arrays.asList((long) n), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
        assertArrayEquals(new long[] { 0L, payload.length }, progress.get(0));
    }

    @Test
    public void mismatchedContentRangeStart_restartsFromZero() throws IOException {
        int n = 9_000;
        writePart(n);

        run(rs -> rs > 0 ? partial(payload, 100) : full(payload), n, 0L);

        assertEquals(Arrays.asList((long) n, 0L), openedWith);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void http500_throws_andKeepsPart() throws IOException {
        writePart(3_000);
        try {
            run(rs -> status(500), 3_000L, 0L);
            fail("expected IOException");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("HTTP 500"));
        }
        assertTrue(partFile.exists());
        assertEquals(3_000L, partFile.length());
        assertTrue(progress.isEmpty());
    }

    @Test
    public void replacesExistingFinalFile() throws IOException {
        Files.write(finalFile.toPath(), new byte[] { 1, 2, 3 });
        run(rs -> full(payload), 0L, 0L);
        assertArrayEquals(payload, Files.readAllBytes(finalFile.toPath()));
    }

    @Test
    public void parseContentRange_handlesValidAndInvalid() {
        assertArrayEquals(new long[] { 5L, 9L, 10L }, DownloadTransfer.parseContentRange("bytes 5-9/10"));
        assertArrayEquals(new long[] { 5L, 9L, -1L }, DownloadTransfer.parseContentRange("bytes 5-9/*"));
        assertNull(DownloadTransfer.parseContentRange(null));
        assertNull(DownloadTransfer.parseContentRange("bytes */10"));
        assertNull(DownloadTransfer.parseContentRange("garbage"));
    }
}
