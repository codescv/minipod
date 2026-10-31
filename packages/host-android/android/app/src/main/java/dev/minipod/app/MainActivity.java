package dev.minipod.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Edge-to-edge Capacitor `BridgeActivity` for MiniPod (`ARCHITECTURE.md §3.2`, `§10`).
 *
 * - Registers `MiniPodPlugin` and forwards launch / live deep-link & `ACTION_SEND` intents.
 * - Computes density-scaled `WindowInsetsCompat` (`systemBars | displayCutout`) and injects
 *   `--m-safe-top`, `--m-safe-right`, `--m-safe-bottom`, `--m-safe-left` CSS variables.
 * - Intercepts hardware/gesture back via `OnBackPressedCallback` calling `window.__minipodHandleBack()`.
 * - Configures WebView mixed content (`MIXED_CONTENT_ALWAYS_ALLOW`) for `http://` podcast/episode covers,
 *   requests `POST_NOTIFICATIONS` on Android 13+, and keeps `PlaybackService` running across backgrounding.
 */
public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 1001;
    private static final String ARTWORK_USER_AGENT = "Podcasts/0.1.10";
    private static final OkHttpClient ARTWORK_HTTP_CLIENT = new OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build();
    private static final ConcurrentHashMap<String, Object> ARTWORK_LOCKS = new ConcurrentHashMap<>();

    private float safeTopDp = 0f;
    private float safeRightDp = 0f;
    private float safeBottomDp = 0f;
    private float safeLeftDp = 0f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MiniPodPlugin.class);
        super.onCreate(savedInstanceState);
        this.keepRunning = true;

        MiniPodPlugin.recordLaunchIntent(getIntent());
        requestNotificationPermissionIfNeeded();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWebView();
            }
        });

        Window window = getWindow();
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            View decorView = window.getDecorView();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, decorView);
            if (controller != null) {
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
            }

            View content = findViewById(android.R.id.content);
            if (content != null) {
                content.setPadding(0, 0, 0, 0);
            }

            ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean kbVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;

                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                safeBottomDp = (kbVisible ? 0 : bars.bottom) / density;
                safeLeftDp = bars.left / density;

                int imePadBottom = kbVisible && ime.bottom > bars.bottom ? ime.bottom : 0;
                v.setPadding(0, 0, 0, imePadBottom);
                if (content != null) {
                    content.setPadding(0, 0, 0, 0);
                }
                syncSafeAreaCssVars();

                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            });
            ViewCompat.requestApplyInsets(decorView);
        }

        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    syncSafeAreaCssVars();
                }

                @Override
                public void onPageLoaded(WebView view) {
                    syncSafeAreaCssVars();
                }
            });
            if (getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                WebSettings webSettings = webView.getSettings();
                webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                webSettings.setMediaPlaybackRequiresUserGesture(false);
                webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);
                webSettings.setDomStorageEnabled(true);
                getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        WebResourceResponse cached = interceptArtworkRequest(request);
                        if (cached != null) {
                            return cached;
                        }
                        return super.shouldInterceptRequest(view, request);
                    }
                });
                webView.postDelayed(this::syncSafeAreaCssVars, 150);
                webView.postDelayed(this::syncSafeAreaCssVars, 600);
            }
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    REQ_POST_NOTIFICATIONS
                );
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        MiniPodPlugin.deliverNewIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
        syncSafeAreaCssVars();
        MiniPodPlugin.resumePendingApkInstall(this);
    }

    @Override
    public void onPause() {
        this.keepRunning = true;
        super.onPause();
        // Never pause or stop PlaybackService when MainActivity leaves the foreground.
    }

    @Override
    public void onStop() {
        this.keepRunning = true;
        super.onStop();
        // PlaybackService continues running independently as a mediaPlayback foreground service.
    }

    private void syncSafeAreaCssVars() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String js = String.format(
            Locale.US,
            "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--m-safe-top','%.2fpx');"
                + "r.setProperty('--m-safe-right','%.2fpx');"
                + "r.setProperty('--m-safe-bottom','%.2fpx');"
                + "r.setProperty('--m-safe-left','%.2fpx');"
                + "r.setProperty('--safe-area-inset-top','%.2fpx');"
                + "r.setProperty('--safe-area-inset-right','%.2fpx');"
                + "r.setProperty('--safe-area-inset-bottom','%.2fpx');"
                + "r.setProperty('--safe-area-inset-left','%.2fpx');"
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp,
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void dispatchBackToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.evaluateJavascript(
                "(function(){try{return typeof window.__minipodHandleBack==='function'?Boolean(window.__minipodHandleBack()):false;}catch(e){return false;}})()",
                result -> {
                    if (!"true".equals(result)) {
                        moveTaskToBack(true);
                    }
                }
            ));
        } else {
            moveTaskToBack(true);
        }
    }

    private WebResourceResponse interceptArtworkRequest(WebResourceRequest request) {
        if (request == null || request.getUrl() == null) return null;
        String method = request.getMethod();
        if (method != null && !"GET".equalsIgnoreCase(method)) return null;

        Uri url = request.getUrl();
        String path = url.getPath() != null ? url.getPath() : "";
        boolean isImageProxy = "/api/image-proxy".equals(path);
        String targetUrl = null;

        if (isImageProxy) {
            targetUrl = url.getQueryParameter("url");
        } else {
            String scheme = url.getScheme();
            String host = url.getHost();
            if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && host != null
                && !"localhost".equalsIgnoreCase(host)
                && !"127.0.0.1".equals(host)
                && isLikelyImageRequest(request, path)) {
                targetUrl = url.toString();
            }
        }

        if (targetUrl == null || targetUrl.trim().isEmpty()) {
            return isImageProxy ? buildBadGatewayResponse() : null;
        }
        targetUrl = targetUrl.trim();
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            return isImageProxy ? buildBadGatewayResponse() : null;
        }

        String hash = sha256Hex(targetUrl);
        if (hash == null) {
            return isImageProxy ? buildBadGatewayResponse() : null;
        }

        File cacheDir = new File(getCacheDir(), "artwork-cache");
        if (!cacheDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            cacheDir.mkdirs();
        }
        File binFile = new File(cacheDir, hash + ".bin");
        File mimeFile = new File(cacheDir, hash + ".mime");

        Object lock = ARTWORK_LOCKS.computeIfAbsent(hash, k -> new Object());
        try {
            synchronized (lock) {
                if (binFile.isFile() && binFile.length() > 0) {
                    String cachedMime = readSmallTextFile(mimeFile);
                    if (cachedMime == null || !cachedMime.startsWith("image/")) {
                        cachedMime = inferMimeFromUrl(targetUrl);
                    }
                    return buildCachedArtworkResponse(binFile, cachedMime, hash);
                }

                Request okReq = new Request.Builder()
                    .url(targetUrl)
                    .header("User-Agent", ARTWORK_USER_AGENT)
                    .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
                    .get()
                    .build();

                try (Response resp = ARTWORK_HTTP_CLIENT.newCall(okReq).execute()) {
                    if (!resp.isSuccessful()) {
                        return isImageProxy ? buildBadGatewayResponse() : null;
                    }
                    ResponseBody body = resp.body();
                    if (body == null) {
                        return isImageProxy ? buildBadGatewayResponse() : null;
                    }
                    byte[] bytes = body.bytes();
                    if (bytes.length == 0) {
                        return isImageProxy ? buildBadGatewayResponse() : null;
                    }
                    String declaredType = resp.header("Content-Type");
                    String mimeType = resolveArtworkMime(declaredType, targetUrl, bytes);
                    if (mimeType == null) {
                        return isImageProxy ? buildBadGatewayResponse() : null;
                    }

                    File tmpBin = new File(cacheDir, hash + ".bin.tmp." + Thread.currentThread().getId());
                    try (FileOutputStream fos = new FileOutputStream(tmpBin)) {
                        fos.write(bytes);
                    }
                    if (!tmpBin.renameTo(binFile)) {
                        try (FileOutputStream fos = new FileOutputStream(binFile)) {
                            fos.write(bytes);
                        }
                        //noinspection ResultOfMethodCallIgnored
                        tmpBin.delete();
                    }
                    try (FileOutputStream mfos = new FileOutputStream(mimeFile)) {
                        mfos.write(mimeType.getBytes(StandardCharsets.UTF_8));
                    }

                    return buildCachedArtworkResponse(binFile, mimeType, hash);
                }
            }
        } catch (Exception e) {
            return isImageProxy ? buildBadGatewayResponse() : null;
        } finally {
            ARTWORK_LOCKS.remove(hash, lock);
        }
    }

    private static boolean isLikelyImageRequest(WebResourceRequest request, String path) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String k = entry.getKey();
                String v = entry.getValue();
                if (k == null || v == null) continue;
                if ("Sec-Fetch-Dest".equalsIgnoreCase(k) && "image".equalsIgnoreCase(v.trim())) {
                    return true;
                }
                if ("Accept".equalsIgnoreCase(k) && v.trim().toLowerCase(Locale.US).startsWith("image/")) {
                    return true;
                }
            }
        }
        String lower = path.toLowerCase(Locale.US);
        return lower.endsWith(".jpg")
            || lower.endsWith(".jpeg")
            || lower.endsWith(".png")
            || lower.endsWith(".webp")
            || lower.endsWith(".gif")
            || lower.endsWith(".avif");
    }

    private static WebResourceResponse buildCachedArtworkResponse(File binFile, String mimeType, String hash) throws Exception {
        InputStream stream = new FileInputStream(binFile);
        Map<String, String> responseHeaders = new HashMap<>();
        responseHeaders.put("Cache-Control", "public, max-age=31536000, immutable");
        responseHeaders.put("ETag", "\"" + hash + "\"");
        responseHeaders.put("Access-Control-Allow-Origin", "*");
        responseHeaders.put("Content-Length", String.valueOf(binFile.length()));
        return new WebResourceResponse(mimeType, null, 200, "OK", responseHeaders, stream);
    }

    private static WebResourceResponse buildBadGatewayResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            502,
            "Bad Gateway",
            headers,
            new ByteArrayInputStream(new byte[0])
        );
    }

    private static String readSmallTextFile(File file) {
        if (!file.isFile() || file.length() <= 0 || file.length() > 256) return null;
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] buf = new byte[(int) file.length()];
            int n = fis.read(buf);
            if (n <= 0) return null;
            return new String(buf, 0, n, StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return null;
        }
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format(Locale.US, "%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String inferMimeFromUrl(String url) {
        String lower = url.toLowerCase(Locale.US);
        int q = lower.indexOf('?');
        if (q >= 0) lower = lower.substring(0, q);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        return "image/jpeg";
    }

    private static String resolveArtworkMime(String declaredHeader, String url, byte[] bytes) {
        if (bytes.length >= 8
            && (bytes[0] & 0xff) == 0x89
            && bytes[1] == 0x50
            && bytes[2] == 0x4e
            && bytes[3] == 0x47) {
            return "image/png";
        }
        if (bytes.length >= 3
            && (bytes[0] & 0xff) == 0xff
            && (bytes[1] & 0xff) == 0xd8
            && (bytes[2] & 0xff) == 0xff) {
            return "image/jpeg";
        }
        if (bytes.length >= 6
            && bytes[0] == 0x47
            && bytes[1] == 0x49
            && bytes[2] == 0x46) {
            return "image/gif";
        }
        if (bytes.length >= 12
            && bytes[0] == 0x52
            && bytes[1] == 0x49
            && bytes[2] == 0x46
            && bytes[3] == 0x46
            && bytes[8] == 0x57
            && bytes[9] == 0x45
            && bytes[10] == 0x42
            && bytes[11] == 0x50) {
            return "image/webp";
        }
        if (declaredHeader != null) {
            String base = declaredHeader.split(";")[0].trim().toLowerCase(Locale.US);
            if ("image/jpg".equals(base)) return "image/jpeg";
            if (base.startsWith("image/") && !"image/*".equals(base)) return base;
            if ("text/html".equals(base) || "application/xhtml+xml".equals(base)) return null;
        }
        return inferMimeFromUrl(url);
    }
}
