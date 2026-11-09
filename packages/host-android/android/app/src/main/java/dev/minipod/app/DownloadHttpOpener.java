package dev.minipod.app;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Credentials;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Opens an episode enclosure stream for one {@link DownloadTransfer} attempt (pure okhttp3,
 * JVM-unit-testable with an interceptor): manual redirect loop (max 10 hops), `Range:
 * bytes=<resumeFrom>-`, Basic Auth retry on 401 (no auth -> ISO-8859-1 -> UTF-8), and registers
 * every in-flight `Call` on the {@link DownloadCancelToken} so a user stop aborts it at once.
 */
final class DownloadHttpOpener implements DownloadTransfer.StreamOpener {

    static final int MAX_REDIRECTS = 10;

    /**
     * OkHttp tuned for long background podcast enclosures: 20 s connect, 60 s read (a stalled
     * socket is detected and retried by {@link RetryingDownload}), transparent connection
     * retries, manual redirects (Basic Auth is re-applied per hop).
     */
    static OkHttpClient createClient() {
        return new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(true)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();
    }

    private final OkHttpClient client;
    private final String rawUrl;
    private final Map<String, String> baseHeaders;
    private final String authUser;
    private final String authPass;
    private final DownloadCancelToken token;

    DownloadHttpOpener(
        OkHttpClient client,
        String rawUrl,
        Map<String, String> baseHeaders,
        String authUser,
        String authPass,
        DownloadCancelToken token
    ) {
        this.client = client;
        this.rawUrl = rawUrl;
        this.baseHeaders = baseHeaders != null
            ? Collections.unmodifiableMap(new LinkedHashMap<>(baseHeaders))
            : Collections.emptyMap();
        this.authUser = authUser;
        this.authPass = authPass != null ? authPass : "";
        this.token = token;
    }

    @Override
    public Response open(long resumeFrom) throws IOException {
        HttpUrl startUrl = rawUrl != null ? HttpUrl.parse(rawUrl.trim()) : null;
        if (startUrl == null) {
            throw new DownloadRetryPolicy.InvalidDownloadUrlException("Invalid download URL: " + rawUrl);
        }
        Charset[] charsets = authUser != null
            ? new Charset[] { null, StandardCharsets.ISO_8859_1, StandardCharsets.UTF_8 }
            : new Charset[] { null };

        Response lastResp = null;
        HttpUrl targetUrl = startUrl;
        for (Charset cs : charsets) {
            if (lastResp != null) {
                lastResp.close();
                lastResp = null;
            }
            String authHeader = cs != null ? Credentials.basic(authUser, authPass, cs) : null;
            HttpUrl cur = targetUrl;
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                if (token != null && token.isCancelled()) {
                    throw new DownloadTransfer.CancelledException();
                }
                Request.Builder rb = new Request.Builder().url(cur).get();
                for (Map.Entry<String, String> e : baseHeaders.entrySet()) {
                    rb.header(e.getKey(), e.getValue());
                }
                if (resumeFrom > 0L) {
                    rb.header("Range", "bytes=" + resumeFrom + "-");
                }
                if (authHeader != null) {
                    rb.header("Authorization", authHeader);
                }
                Call call = client.newCall(rb.build());
                if (token != null) token.setActiveAbort(call::cancel);
                Response resp = call.execute();
                int code = resp.code();
                String loc = resp.header("Location");
                if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308)
                    && loc != null
                    && hop < MAX_REDIRECTS) {
                    HttpUrl next = cur.resolve(loc.trim());
                    resp.close();
                    if (next == null) throw new IOException("Invalid redirect Location: " + loc);
                    cur = next;
                    continue;
                }
                targetUrl = cur;
                lastResp = resp;
                break;
            }
            if (lastResp != null && lastResp.code() != 401) {
                return lastResp;
            }
        }
        if (lastResp == null) {
            throw new IOException("Download failed with no response");
        }
        return lastResp;
    }
}
