package dev.minipod.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.junit.Test;

/** Enclosure stream opener: redirects, Range, Basic Auth retry, cancel hook, tuned client. */
public class DownloadHttpOpenerTest {

    private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());

    private OkHttpClient client(Function<Request, Response.Builder> responder) {
        Interceptor fake = chain -> {
            Request req = chain.request();
            requests.add(req);
            return responder.apply(req)
                .request(req)
                .protocol(Protocol.HTTP_1_1)
                .message("msg")
                .body(ResponseBody.create(new byte[] { 1, 2, 3 }, MediaType.get("audio/mpeg")))
                .build();
        };
        return DownloadHttpOpener.createClient().newBuilder().addInterceptor(fake).build();
    }

    @Test
    public void createClient_isTunedForBackgroundEnclosures() {
        OkHttpClient c = DownloadHttpOpener.createClient();
        assertEquals(20_000, c.connectTimeoutMillis());
        assertEquals(60_000, c.readTimeoutMillis());
        assertTrue(c.retryOnConnectionFailure());
        assertTrue(!c.followRedirects() && !c.followSslRedirects());
    }

    @Test
    public void followsRedirects_andSendsRangeOnEveryHop() throws IOException {
        OkHttpClient c = client(req -> req.url().host().equals("feeds.example.com")
            ? new Response.Builder().code(302).header("Location", "https://cdn.example.com/ep.mp3")
            : new Response.Builder().code(206));
        DownloadCancelToken token = new DownloadCancelToken();
        DownloadHttpOpener opener = new DownloadHttpOpener(
            c, "https://feeds.example.com/ep.mp3", Map.of("User-Agent", "MiniPod-Test"), null, null, token
        );
        try (Response r = opener.open(4_096L)) {
            assertEquals(206, r.code());
        }
        assertEquals(2, requests.size());
        for (Request req : requests) {
            assertEquals("bytes=4096-", req.header("Range"));
            assertEquals("MiniPod-Test", req.header("User-Agent"));
            assertNull(req.header("Authorization"));
        }
        assertEquals("cdn.example.com", requests.get(1).url().host());
    }

    @Test
    public void noRangeHeader_whenStartingFromZero() throws IOException {
        OkHttpClient c = client(req -> new Response.Builder().code(200));
        new DownloadHttpOpener(c, "https://x.example.com/a.mp3", null, null, null, null).open(0L).close();
        assertNull(requests.get(0).header("Range"));
    }

    @Test
    public void basicAuth_retriedAfter401() throws IOException {
        OkHttpClient c = client(req -> req.header("Authorization") == null
            ? new Response.Builder().code(401)
            : new Response.Builder().code(200));
        try (Response r = new DownloadHttpOpener(
            c, "https://private.example.com/ep.mp3", null, "user", "pässword", null
        ).open(0L)) {
            assertEquals(200, r.code());
        }
        assertEquals(2, requests.size());
        assertTrue(requests.get(1).header("Authorization").startsWith("Basic "));
    }

    @Test
    public void invalidUrl_isPermanentError() {
        try {
            new DownloadHttpOpener(client(r -> new Response.Builder().code(200)), "not a url", null, null, null, null)
                .open(0L);
            fail("expected invalid URL");
        } catch (IOException e) {
            assertTrue(e instanceof DownloadRetryPolicy.InvalidDownloadUrlException);
            assertTrue(!DownloadRetryPolicy.isTransient(e));
        }
        assertTrue(requests.isEmpty());
    }

    @Test
    public void cancelledToken_neverConnects() {
        DownloadCancelToken token = new DownloadCancelToken();
        token.cancel();
        try {
            new DownloadHttpOpener(client(r -> new Response.Builder().code(200)), "https://x.example.com/a.mp3",
                null, null, null, token).open(0L);
            fail("expected cancel");
        } catch (IOException e) {
            assertTrue(e instanceof DownloadTransfer.CancelledException);
        }
        assertTrue(requests.isEmpty());
    }
}
