package dev.minipod.app;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthException;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Credentials;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor native bridge `MiniPod` (`ARCHITECTURE.md §3.2`, `§3.3`, `§8.2`, `§10`):
 *   - `http`: OkHttp manual redirect loop recording `chain: [{status, url, location}]`,
 *     Basic Auth retry (`ISO-8859-1` -> `UTF-8`) + cross-host redirect re-injection, `Range`, `maxBodyBytes`.
 *   - `httpToFile` / `cancelDownload` / `deleteLocalFile` / `readLocalFileRange`: episode downloads.
 *   - `safPick` / `safStat` / `safRead` / `safReadRange` / `safWrite` (`rw` + `truncate` + `fsync`) / `safListTree`.
 *   - `media*`: Media3 `PlaybackService` control, marathon queue, sleep timer, and native journal reconciliation.
 *   - `authStatus` / `authGoogleSignIn`: Google Drive OAuth2 token acquisition.
 */
@CapacitorPlugin(name = "MiniPod")
public class MiniPodPlugin extends Plugin {
    private static final int DEFAULT_MAX_REDIRECTS = 10;
    private static final int DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
    private static final long DOWNLOAD_PROGRESS_THROTTLE_MS = 250L;
    private static final String AUTH_PREFS_NAME = "minipod_auth";
    private static final String AUTH_PREFS_ACCOUNT_EMAIL = "google_account_email";

    @Nullable private static volatile JSObject pendingLaunchIntent;
    @Nullable private static volatile MiniPodPlugin activeInstance;
    @Nullable private static volatile File pendingInstallApkFile;
    @Nullable private volatile Account pendingConsentAccount;

    private final ExecutorService ioPool = Executors.newCachedThreadPool();
    private final Map<String, Call> activeDownloadCalls = new ConcurrentHashMap<>();
    /** `.part` temp files of in-flight downloads so `cancelDownload` can remove them. */
    private final Map<String, File> activeDownloadPartFiles = new ConcurrentHashMap<>();
    /** Episode keys whose in-flight download was stopped via `cancelDownload`. */
    private final Set<String> cancelledDownloadKeys = ConcurrentHashMap.newKeySet();

    private final OkHttpClient okHttp = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();

    private final PlaybackService.ServiceEventListener serviceListener =
        new PlaybackService.ServiceEventListener() {
            @Override
            public void onMediaState(JSObject state) {
                notifyListeners("media-state", state);
            }

            @Override
            public void onMediaEnded(JSObject ended) {
                notifyListeners("media-ended", ended);
            }

            @Override
            public void onMediaError(JSObject error) {
                notifyListeners("media-error", error);
            }

            @Override
            public void onSleepTimerState(JSObject sleepState) {
                notifyListeners("sleep-timer-state", sleepState);
            }
        };

    @Override
    public void load() {
        super.load();
        activeInstance = this;
        PlaybackService.addEventListener(serviceListener);
    }

    @Override
    protected void handleOnDestroy() {
        PlaybackService.removeEventListener(serviceListener);
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    // -------------------------------------------------------------------------
    // Launch & Live Intent Routing (`MainActivity` -> JS `'deep-link'`)
    // -------------------------------------------------------------------------

    public static void recordLaunchIntent(@Nullable Intent intent) {
        JSObject parsed = parseIncomingIntent(intent);
        if (parsed != null) {
            pendingLaunchIntent = parsed;
        }
    }

    public static void deliverNewIntent(@Nullable Intent intent) {
        JSObject parsed = parseIncomingIntent(intent);
        if (parsed == null) return;
        MiniPodPlugin plugin = activeInstance;
        if (plugin != null) {
            plugin.notifyListeners("deep-link", parsed, true);
        } else {
            pendingLaunchIntent = parsed;
        }
    }

    @Nullable
    private static JSObject parseIncomingIntent(@Nullable Intent intent) {
        if (intent == null || intent.getAction() == null) return null;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if ((text == null || text.trim().isEmpty()) && stream == null) return null;
            JSObject out = new JSObject();
            out.put("action", "send");
            if (text != null) out.put("text", text);
            if (stream != null) out.put("uri", stream.toString());
            if (intent.getType() != null) out.put("mimeType", intent.getType());
            return out;
        }
        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data == null) return null;
            JSObject out = new JSObject();
            out.put("action", "view");
            out.put("uri", data.toString());
            if (intent.getType() != null) out.put("mimeType", intent.getType());
            return out;
        }
        return null;
    }

    @PluginMethod
    public void getLaunchIntent(PluginCall call) {
        JSObject pending = pendingLaunchIntent;
        pendingLaunchIntent = null;
        JSObject res = new JSObject();
        if (pending == null) {
            res.put("hasIntent", false);
        } else {
            res.put("hasIntent", true);
            if (pending.has("action")) res.put("action", pending.getString("action"));
            if (pending.has("uri")) res.put("uri", pending.getString("uri"));
            if (pending.has("mimeType")) res.put("mimeType", pending.getString("mimeType"));
            if (pending.has("text")) res.put("text", pending.getString("text"));
        }
        call.resolve(res);
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing URL", "invalid-url");
            return;
        }
        try {
            Uri uri = Uri.parse(url.trim());
            String scheme = uri.getScheme();
            if (scheme != null && "mailto".equalsIgnoreCase(scheme)) {
                try {
                    Intent sendToIntent = new Intent(Intent.ACTION_SENDTO, uri);
                    sendToIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(sendToIntent);
                    call.resolve();
                    return;
                } catch (ActivityNotFoundException ignored) {
                    // Fall back to ACTION_VIEW when no SENDTO handler is registered
                }
            }
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No application can open URL: " + url, "unsupported", e);
        } catch (Exception e) {
            call.reject("Failed to open external URL: " + e.getMessage(), "invalid-url", e);
        }
    }

    /**
     * v0.1.23 Agent Feedback email. With an image attachment, writes the decoded bytes to
     * {@code cache/feedback/<safeName>}, shares them through the app FileProvider, and starts
     * {@code ACTION_SEND} directly in the resolved email app (v0.1.25, see {@link #launchFeedbackEmail}).
     * Without an attachment, launches a plain {@code mailto:} {@code ACTION_SENDTO} as before.
     */
    @PluginMethod
    public void sendFeedbackEmail(PluginCall call) {
        final String to = call.getString("to", "").trim();
        final String subject = call.getString("subject", "");
        final String body = call.getString("body", "");
        final String attachmentBase64 = call.getString("attachmentBase64");
        final String attachmentName = call.getString("attachmentName");
        final String attachmentMimeType = call.getString("attachmentMimeType");
        final Context context = getContext();

        if (attachmentBase64 == null || attachmentBase64.trim().isEmpty()) {
            Uri mailto = Uri.parse(
                "mailto:" + to + "?subject=" + Uri.encode(subject) + "&body=" + Uri.encode(body)
            );
            try {
                Intent sendToIntent = new Intent(Intent.ACTION_SENDTO, mailto);
                sendToIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(sendToIntent);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("No email application available", "unsupported", e);
            } catch (Exception e) {
                call.reject("Failed to open email app: " + e.getMessage(), "io", e);
            }
            return;
        }

        ioPool.execute(() -> {
            final Uri contentUri;
            final String mimeType = FeedbackAttachmentNames.normalizeMime(attachmentMimeType);
            try {
                byte[] bytes = Base64.decode(
                    FeedbackAttachmentNames.stripDataUrlPrefix(attachmentBase64),
                    Base64.DEFAULT
                );
                File dir = new File(context.getCacheDir(), "feedback");
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create feedback cache directory");
                }
                File[] stale = dir.listFiles();
                if (stale != null) {
                    for (File f : stale) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
                String safeName = FeedbackAttachmentNames.sanitize(attachmentName, attachmentMimeType);
                File outFile = new File(dir, safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                }
                contentUri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    outFile
                );
            } catch (IllegalArgumentException e) {
                call.reject("Invalid feedback attachment: " + e.getMessage(), "invalid-attachment", e);
                return;
            } catch (Exception e) {
                call.reject("Failed to prepare feedback attachment: " + e.getMessage(), "io", e);
                return;
            }

            new Handler(Looper.getMainLooper()).post(
                () -> launchFeedbackEmail(call, context, to, subject, body, mimeType, contentUri)
            );
        });
    }

    /**
     * v0.1.25: opens the email client directly instead of the share sheet. Tries, in order:
     * (1) typed {@code ACTION_SEND} pinned to the email app resolved from a {@code mailto:}
     * {@code ACTION_SENDTO} probe, (2) untyped {@code ACTION_SEND} + {@code mailto:} selector
     * (never {@code setType} + selector together, which made every {@code mailto:} filter fail
     * with {@code MATCH_NO_TYPE}), and only then (3) the generic chooser.
     */
    private void launchFeedbackEmail(
        PluginCall call,
        Context context,
        String to,
        String subject,
        String body,
        String mimeType,
        Uri contentUri
    ) {
        List<FeedbackEmailIntentBuilder.SendTarget> targets;
        try {
            targets = resolveFeedbackEmailTargets(context, to, mimeType);
        } catch (Exception e) {
            targets = new ArrayList<>();
        }
        List<FeedbackEmailIntentBuilder.Spec> plan = FeedbackEmailIntentBuilder.plan(targets, to, mimeType);
        Exception lastError = null;
        for (FeedbackEmailIntentBuilder.Spec spec : plan) {
            Intent send = buildFeedbackSendIntent(context, spec, to, subject, body, contentUri);
            Intent toStart = send;
            if (spec.strategy == FeedbackEmailIntentBuilder.Strategy.CHOOSER) {
                toStart = Intent.createChooser(send, subject.isEmpty() ? "Send feedback" : subject);
                toStart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
            try {
                if (spec.packageName != null) {
                    context.grantUriPermission(spec.packageName, contentUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                context.startActivity(toStart);
                call.resolve();
                return;
            } catch (ActivityNotFoundException | SecurityException e) {
                // Try the next strategy (selector fallback, then chooser).
                lastError = e;
            } catch (Exception e) {
                lastError = e;
            }
        }
        if (lastError instanceof ActivityNotFoundException) {
            call.reject("No application can send feedback email", "unsupported", lastError);
        } else {
            call.reject(
                "Failed to open email app: " + (lastError == null ? "unknown" : lastError.getMessage()),
                "io",
                lastError
            );
        }
    }

    /**
     * Resolves concrete email apps from a {@code mailto:} {@code ACTION_SENDTO} probe (default
     * handler first, then Gmail, then other handlers) and, for each, the {@code ACTION_SEND}
     * activity and MIME type that accept the attachment.
     */
    private List<FeedbackEmailIntentBuilder.SendTarget> resolveFeedbackEmailTargets(
        Context context,
        String to,
        String mimeType
    ) {
        PackageManager pm = context.getPackageManager();
        Intent mailtoProbe = new Intent(Intent.ACTION_SENDTO, Uri.parse(FeedbackEmailIntentBuilder.mailtoUri(to)));

        String defaultPackage = null;
        String defaultActivity = null;
        ResolveInfo defaultInfo = pm.resolveActivity(mailtoProbe, PackageManager.MATCH_DEFAULT_ONLY);
        if (defaultInfo != null && defaultInfo.activityInfo != null) {
            defaultPackage = defaultInfo.activityInfo.packageName;
            defaultActivity = defaultInfo.activityInfo.name;
        }

        List<String> candidates = new ArrayList<>();
        Set<String> mailtoActivityNames = new HashSet<>();
        addResolvedPackages(candidates, mailtoActivityNames, pm.queryIntentActivities(mailtoProbe, PackageManager.MATCH_DEFAULT_ONLY));
        addResolvedPackages(candidates, mailtoActivityNames, pm.queryIntentActivities(mailtoProbe, 0));

        List<String> packages = FeedbackEmailIntentBuilder.orderEmailPackages(
            defaultPackage,
            defaultActivity,
            candidates,
            context.getPackageName(),
            true
        );

        List<FeedbackEmailIntentBuilder.SendTarget> targets = new ArrayList<>();
        for (String pkg : packages) {
            for (String type : FeedbackEmailIntentBuilder.sendTypeCandidates(mimeType)) {
                Intent sendProbe = new Intent(Intent.ACTION_SEND);
                sendProbe.setType(type);
                sendProbe.setPackage(pkg);
                List<ResolveInfo> sendActivities = pm.queryIntentActivities(sendProbe, PackageManager.MATCH_DEFAULT_ONLY);
                if (sendActivities == null || sendActivities.isEmpty()) continue;
                List<String> names = new ArrayList<>();
                for (ResolveInfo info : sendActivities) {
                    if (info != null && info.activityInfo != null && pkg.equals(info.activityInfo.packageName)) {
                        names.add(info.activityInfo.name);
                    }
                }
                String className = FeedbackEmailIntentBuilder.pickComposeActivity(pkg, names, mailtoActivityNames);
                if (className == null) continue;
                targets.add(new FeedbackEmailIntentBuilder.SendTarget(
                    pkg,
                    className,
                    FeedbackEmailIntentBuilder.deliveryType(type, mimeType)
                ));
                break;
            }
        }
        return targets;
    }

    private static void addResolvedPackages(
        List<String> out,
        Set<String> activityNames,
        @Nullable List<ResolveInfo> infos
    ) {
        if (infos == null) return;
        for (ResolveInfo info : infos) {
            if (info != null && info.activityInfo != null && info.activityInfo.packageName != null) {
                String pkg = info.activityInfo.packageName;
                // Drop system resolvers / choosers (android, com.oplus.resolver, intentresolver, ...).
                if (!FeedbackEmailIntentBuilder.isConcreteEmailApp(pkg, info.activityInfo.name, null)) continue;
                if (info.activityInfo.name != null) activityNames.add(info.activityInfo.name);
                if (!out.contains(pkg)) out.add(pkg);
            }
        }
    }

    /** Converts a {@link FeedbackEmailIntentBuilder.Spec} into the concrete {@code ACTION_SEND} Intent. */
    private static Intent buildFeedbackSendIntent(
        Context context,
        FeedbackEmailIntentBuilder.Spec spec,
        String to,
        String subject,
        String body,
        Uri contentUri
    ) {
        Intent send = new Intent(Intent.ACTION_SEND);
        if (spec.type != null) send.setType(spec.type);
        if (!to.isEmpty()) send.putExtra(Intent.EXTRA_EMAIL, new String[] { to });
        send.putExtra(Intent.EXTRA_SUBJECT, subject);
        send.putExtra(Intent.EXTRA_TEXT, body);
        send.putExtra(Intent.EXTRA_STREAM, contentUri);
        send.setClipData(ClipData.newUri(context.getContentResolver(), "feedback_image", contentUri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        if (spec.className != null) {
            send.setClassName(spec.packageName, spec.className);
        } else if (spec.packageName != null) {
            send.setPackage(spec.packageName);
        }
        if (spec.selectorMailto != null) {
            send.setSelector(new Intent(Intent.ACTION_SENDTO, Uri.parse(spec.selectorMailto)));
        }
        return send;
    }

    // -------------------------------------------------------------------------
    // HTTP Client (`MiniPodPlugin.http` + `httpToFile`)
    // -------------------------------------------------------------------------

    private static final class ExecutedHttp {
        final int status;
        final Headers headers;
        final String finalUrl;
        final JSArray chain;
        final byte[] body;

        ExecutedHttp(int status, Headers headers, String finalUrl, JSArray chain, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.finalUrl = finalUrl;
            this.chain = chain;
            this.body = body;
        }
    }

    @PluginMethod
    public void http(PluginCall call) {
        ioPool.execute(() -> {
            String rawUrl = call.getString("url");
            if (rawUrl == null || rawUrl.trim().isEmpty()) {
                call.reject("URL is required", "invalid-url");
                return;
            }

            String method = call.getString("method", "GET");
            if (method == null) method = "GET";
            method = method.toUpperCase(Locale.US);

            int maxRedirects = safeInt(call, "maxRedirects", DEFAULT_MAX_REDIRECTS);
            int maxBodyBytes = safeInt(call, "maxBodyBytes", DEFAULT_MAX_BODY_BYTES);
            int timeoutMs = safeInt(call, "timeoutMs", 30_000);

            Map<String, String> reqHeaders = jsonObjectToMap(call.getObject("headers"));

            JSObject rangeObj = call.getObject("range");
            if (rangeObj != null && rangeObj.has("start")) {
                long start = rangeObj.optLong("start", 0L);
                if (rangeObj.has("end") && !rangeObj.isNull("end")) {
                    long end = rangeObj.optLong("end", 0L);
                    reqHeaders.put("Range", "bytes=" + start + "-" + end);
                } else {
                    reqHeaders.put("Range", "bytes=" + start + "-");
                }
            }

            byte[] reqBodyBytes = null;
            String bodyB64 = call.getString("bodyBase64");
            if (bodyB64 != null && !bodyB64.isEmpty()) {
                reqBodyBytes = Base64.decode(bodyB64, Base64.DEFAULT);
            }

            HttpUrl parsedInitial = HttpUrl.parse(rawUrl.trim());
            if (parsedInitial == null) {
                call.reject("Invalid HTTP URL: " + rawUrl, "invalid-url");
                return;
            }

            String urlUser = !parsedInitial.username().isEmpty() ? parsedInitial.username() : null;
            String urlPass = !parsedInitial.password().isEmpty() ? parsedInitial.password() : "";
            HttpUrl cleanInitialUrl = urlUser != null
                ? parsedInitial.newBuilder().username("").password("").build()
                : parsedInitial;

            String authUser = urlUser;
            String authPass = urlPass;
            JSObject authObj = call.getObject("auth");
            if (authUser == null && authObj != null && authObj.has("username")) {
                authUser = authObj.optString("username", "");
                authPass = authObj.optString("password", "");
            }

            OkHttpClient client = timeoutMs != 30_000
                ? okHttp.newBuilder()
                    .readTimeout(Math.max(1_000, timeoutMs), TimeUnit.MILLISECONDS)
                    .build()
                : okHttp;

            try {
                JSArray fullChain = new JSArray();
                ExecutedHttp first = executeRedirectChain(
                    client,
                    cleanInitialUrl,
                    method,
                    reqHeaders,
                    reqBodyBytes,
                    maxRedirects,
                    maxBodyBytes,
                    fullChain
                );

                ExecutedHttp result = first;

                // Basic Auth retry on 401: ISO-8859-1 first, then UTF-8 (`BasicAuthorizationInterceptor` port)
                if (first.status == 401) {
                    String explicitAuth = findHeaderIgnoreCase(reqHeaders, "Authorization");
                    HttpUrl retryTarget = HttpUrl.parse(first.finalUrl);
                    if (retryTarget == null) retryTarget = cleanInitialUrl;

                    if (explicitAuth != null && !first.finalUrl.equals(cleanInitialUrl.toString())) {
                        Map<String, String> reattached = new HashMap<>(reqHeaders);
                        reattached.put("Authorization", explicitAuth);
                        result = executeRedirectChain(
                            client,
                            retryTarget,
                            method,
                            reattached,
                            reqBodyBytes,
                            maxRedirects,
                            maxBodyBytes,
                            fullChain
                        );
                    } else if (authUser != null) {
                        String isoHeader = Credentials.basic(authUser, authPass, StandardCharsets.ISO_8859_1);
                        String utf8Header = Credentials.basic(authUser, authPass, StandardCharsets.UTF_8);

                        Map<String, String> isoHeaders = new HashMap<>(reqHeaders);
                        isoHeaders.put("Authorization", isoHeader);
                        result = executeRedirectChain(
                            client,
                            retryTarget,
                            method,
                            isoHeaders,
                            reqBodyBytes,
                            maxRedirects,
                            maxBodyBytes,
                            fullChain
                        );

                        if (result.status == 401 && !utf8Header.equals(isoHeader)) {
                            HttpUrl utf8Target = HttpUrl.parse(result.finalUrl);
                            if (utf8Target == null) utf8Target = retryTarget;
                            Map<String, String> utf8Headers = new HashMap<>(reqHeaders);
                            utf8Headers.put("Authorization", utf8Header);
                            result = executeRedirectChain(
                                client,
                                utf8Target,
                                method,
                                utf8Headers,
                                reqBodyBytes,
                                maxRedirects,
                                maxBodyBytes,
                                fullChain
                            );
                        }
                    }
                }

                JSObject respHeaders = new JSObject();
                for (int i = 0; i < result.headers.size(); i++) {
                    respHeaders.put(
                        result.headers.name(i).toLowerCase(Locale.US),
                        result.headers.value(i)
                    );
                }

                JSObject out = new JSObject();
                out.put("status", result.status);
                out.put("headers", respHeaders);
                out.put("finalUrl", result.finalUrl);
                out.put("chain", fullChain);
                out.put("bodyBase64", Base64.encodeToString(result.body, Base64.NO_WRAP));
                call.resolve(out);
            } catch (BodyTooLargeException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (Exception e) {
                call.reject(
                    e.getMessage() != null ? e.getMessage() : "HTTP request failed",
                    "network",
                    e
                );
            }
        });
    }

    private static final class BodyTooLargeException extends IOException {
        BodyTooLargeException(String message) {
            super(message);
        }
    }

    private ExecutedHttp executeRedirectChain(
        OkHttpClient client,
        HttpUrl startUrl,
        String initialMethod,
        Map<String, String> baseHeaders,
        @Nullable byte[] initialBody,
        int maxRedirects,
        int maxBodyBytes,
        JSArray chainSink
    ) throws IOException {
        HttpUrl currentUrl = startUrl;
        String currentMethod = initialMethod;
        byte[] currentBody = initialBody;
        Map<String, String> currentHeaders = new HashMap<>(baseHeaders);

        for (int hop = 0; hop <= Math.max(0, maxRedirects); hop++) {
            Request.Builder rb = new Request.Builder().url(currentUrl);
            for (Map.Entry<String, String> entry : currentHeaders.entrySet()) {
                rb.header(entry.getKey(), entry.getValue());
            }

            RequestBody okBody = null;
            if (!"GET".equals(currentMethod) && !"HEAD".equals(currentMethod)) {
                String ct = findHeaderIgnoreCase(currentHeaders, "Content-Type");
                MediaType mt = ct != null ? MediaType.parse(ct) : null;
                okBody = RequestBody.create(currentBody != null ? currentBody : new byte[0], mt);
            }
            rb.method(currentMethod, okBody);

            try (Response resp = client.newCall(rb.build()).execute()) {
                int code = resp.code();
                String location = resp.header("Location");
                boolean isRedirect =
                    (code == 301 || code == 302 || code == 303 || code == 307 || code == 308)
                        && location != null
                        && !location.trim().isEmpty();

                if (isRedirect && hop < maxRedirects) {
                    HttpUrl nextUrl = currentUrl.resolve(location.trim());
                    if (nextUrl == null) {
                        throw new IOException("Invalid redirect Location: " + location);
                    }

                    JSObject hopObj = new JSObject();
                    hopObj.put("status", code);
                    hopObj.put("url", currentUrl.toString());
                    hopObj.put("location", nextUrl.toString());
                    chainSink.put(hopObj);

                    // Strip Authorization on cross-host redirects; 401 retry re-attaches when authorized
                    if (!sameOriginHostPort(currentUrl, nextUrl)) {
                        removeHeaderIgnoreCase(currentHeaders, "Authorization");
                    }

                    if (code == 303 || ((code == 301 || code == 302) && "POST".equals(currentMethod))) {
                        currentMethod = "GET";
                        currentBody = null;
                        removeHeaderIgnoreCase(currentHeaders, "Content-Length");
                        removeHeaderIgnoreCase(currentHeaders, "Content-Type");
                    }

                    currentUrl = nextUrl;
                    continue;
                }

                byte[] bodyBytes = "HEAD".equals(currentMethod)
                    ? new byte[0]
                    : readBoundedBody(resp.body(), maxBodyBytes);
                return new ExecutedHttp(
                    code,
                    resp.headers(),
                    currentUrl.toString(),
                    chainSink,
                    bodyBytes
                );
            }
        }

        throw new IOException("Maximum redirects (" + maxRedirects + ") exceeded");
    }

    private static byte[] readBoundedBody(@Nullable ResponseBody body, int maxBytes) throws IOException {
        if (body == null) return new byte[0];
        long declared = body.contentLength();
        if (declared > maxBytes) {
            throw new BodyTooLargeException(
                "Response content-length (" + declared + ") exceeds maxBodyBytes (" + maxBytes + ")"
            );
        }
        try (InputStream in = body.byteStream();
             ByteArrayOutputStream out = new ByteArrayOutputStream(
                 declared > 0 ? (int) Math.min(declared, 65_536) : 8_192
             )) {
            byte[] buf = new byte[8_192];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > maxBytes) {
                    throw new BodyTooLargeException(
                        "Response body exceeds maxBodyBytes (" + maxBytes + ")"
                    );
                }
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    @PluginMethod
    public void httpToFile(PluginCall call) {
        String startKey = call.getString("episodeKey");
        if (startKey != null) {
            // Cleared synchronously (plugin thread) so a later `cancelDownload` is never lost.
            cancelledDownloadKeys.remove(startKey);
        }
        ioPool.execute(() -> {
            String episodeKey = call.getString("episodeKey");
            String rawUrl = call.getString("url");
            String destPath = call.getString("destPath");
            if (episodeKey == null || rawUrl == null || destPath == null) {
                call.reject("episodeKey, url, and destPath are required", "invalid-argument");
                return;
            }

            File filesDir = getContext().getFilesDir();
            File finalFile = resolveSafeChild(filesDir, destPath);
            if (finalFile == null) {
                call.reject("Invalid destPath outside filesDir", "invalid-argument");
                return;
            }
            File parent = finalFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                call.reject("Unable to create downloads directory", "internal");
                return;
            }
            File partFile = new File(finalFile.getAbsolutePath() + ".part");
            activeDownloadPartFiles.put(episodeKey, partFile);
            long existingBytes = partFile.exists() ? partFile.length() : 0L;
            long resumeFrom = safeLong(call, "resumeFrom", existingBytes);

            Map<String, String> headers = jsonObjectToMap(call.getObject("headers"));
            JSObject authObj = call.getObject("auth");
            String authUser = authObj != null && authObj.has("username")
                ? authObj.optString("username", "")
                : null;
            String authPass = authObj != null ? authObj.optString("password", "") : "";

            try {
                Response resp = openDownloadStream(rawUrl, headers, authUser, authPass, resumeFrom, episodeKey);
                try {
                    int code = resp.code();
                    if (code < 200 || code >= 300) {
                        call.reject("Download failed with HTTP " + code, "network");
                        return;
                    }
                    ResponseBody body = resp.body();
                    if (body == null) {
                        call.reject("Download response has empty body", "network");
                        return;
                    }

                    boolean appending = code == 206 && resumeFrom > 0L;
                    long contentLen = body.contentLength();
                    long totalBytes = contentLen > 0
                        ? (appending ? resumeFrom + contentLen : contentLen)
                        : -1L;

                    long written = appending ? resumeFrom : 0L;
                    long lastEmitMs = 0L;

                    try (InputStream in = body.byteStream();
                         RandomAccessFile raf = new RandomAccessFile(partFile, "rw")) {
                        if (appending) {
                            raf.seek(resumeFrom);
                        } else {
                            raf.setLength(0L);
                        }
                        byte[] buf = new byte[16_384];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            if (cancelledDownloadKeys.contains(episodeKey)) {
                                throw new IOException("Canceled");
                            }
                            raf.write(buf, 0, n);
                            written += n;
                            long now = System.currentTimeMillis();
                            if (now - lastEmitMs >= DOWNLOAD_PROGRESS_THROTTLE_MS) {
                                lastEmitMs = now;
                                JSObject prog = new JSObject();
                                prog.put("episodeKey", episodeKey);
                                prog.put("bytesDownloaded", written);
                                if (totalBytes > 0) prog.put("totalBytes", totalBytes);
                                notifyListeners("download-progress", prog);
                            }
                        }
                        raf.getFD().sync();
                    }

                    if (cancelledDownloadKeys.contains(episodeKey)) {
                        throw new IOException("Canceled");
                    }
                    if (finalFile.exists() && !finalFile.delete()) {
                        throw new IOException("Unable to replace existing file " + finalFile);
                    }
                    if (!partFile.renameTo(finalFile)) {
                        throw new IOException("Unable to rename .part file to " + finalFile);
                    }

                    JSObject res = new JSObject();
                    res.put("path", finalFile.getAbsolutePath());
                    res.put("size", finalFile.length());
                    String ct = resp.header("Content-Type");
                    if (ct != null) res.put("mime", ct);
                    call.resolve(res);
                } finally {
                    resp.close();
                }
            } catch (Exception e) {
                if (cancelledDownloadKeys.contains(episodeKey)) {
                    //noinspection ResultOfMethodCallIgnored
                    partFile.delete();
                    call.reject("Download cancelled", "cancelled", e);
                } else {
                    call.reject(
                        e.getMessage() != null ? e.getMessage() : "Episode download failed",
                        "network",
                        e
                    );
                }
            } finally {
                activeDownloadCalls.remove(episodeKey);
                activeDownloadPartFiles.remove(episodeKey, partFile);
            }
        });
    }

    private Response openDownloadStream(
        String rawUrl,
        Map<String, String> baseHeaders,
        @Nullable String authUser,
        String authPass,
        long resumeFrom,
        String episodeKey
    ) throws IOException {
        HttpUrl startUrl = HttpUrl.parse(rawUrl);
        if (startUrl == null) {
            throw new IOException("Invalid download URL: " + rawUrl);
        }

        Charset[] charsets = authUser != null
            ? new Charset[] { null, StandardCharsets.ISO_8859_1, StandardCharsets.UTF_8 }
            : new Charset[] { null };

        Response lastResp = null;
        HttpUrl targetUrl = startUrl;

        for (Charset cs : charsets) {
            if (lastResp != null) {
                lastResp.close();
            }
            String authHeader = cs != null && authUser != null
                ? Credentials.basic(authUser, authPass, cs)
                : null;

            HttpUrl cur = targetUrl;
            for (int hop = 0; hop <= DEFAULT_MAX_REDIRECTS; hop++) {
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

                Call netCall = okHttp.newCall(rb.build());
                activeDownloadCalls.put(episodeKey, netCall);
                Response resp = netCall.execute();
                int code = resp.code();
                String loc = resp.header("Location");
                if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308)
                    && loc != null
                    && hop < DEFAULT_MAX_REDIRECTS) {
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

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String episodeKey = call.getString("episodeKey");
        if (episodeKey != null) {
            cancelledDownloadKeys.add(episodeKey);
            Call active = activeDownloadCalls.remove(episodeKey);
            if (active != null) {
                active.cancel();
            }
            File partFile = activeDownloadPartFiles.remove(episodeKey);
            if (partFile != null && partFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                partFile.delete();
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void deleteLocalFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.resolve();
            return;
        }
        ioPool.execute(() -> {
            File target = resolveAllowedLocalFile(path);
            if (target != null && target.exists()) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void readLocalFileRange(PluginCall call) {
        ioPool.execute(() -> {
            String path = call.getString("path");
            long start = safeLong(call, "start", 0L);
            int length = safeInt(call, "length", 262_144);
            if (path == null || length < 0) {
                call.reject("Invalid path or length", "invalid-argument");
                return;
            }
            File file = resolveAllowedLocalFile(path);
            if (file == null || !file.exists()) {
                call.reject("Local file not found: " + path, "not-found");
                return;
            }
            try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                long fileLen = raf.length();
                if (start >= fileLen || length == 0) {
                    JSObject empty = new JSObject();
                    empty.put("base64", "");
                    call.resolve(empty);
                    return;
                }
                int toRead = (int) Math.min((long) length, fileLen - start);
                byte[] buf = new byte[toRead];
                raf.seek(start);
                int offset = 0;
                while (offset < toRead) {
                    int n = raf.read(buf, offset, toRead - offset);
                    if (n < 0) break;
                    offset += n;
                }
                byte[] actual = offset == toRead ? buf : java.util.Arrays.copyOf(buf, offset);
                JSObject res = new JSObject();
                res.put("base64", Base64.encodeToString(actual, Base64.NO_WRAP));
                call.resolve(res);
            } catch (IOException e) {
                call.reject("Failed to read local file slice: " + e.getMessage(), "internal", e);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Storage Access Framework (`saf.*`)
    // -------------------------------------------------------------------------

    @PluginMethod
    public void safPick(PluginCall call) {
        String mode = call.getString("mode", "open");
        String mime = call.getString("mime", "*/*");
        String suggestedName = call.getString("suggestedName", "minipod-sync-v1.json");

        Intent intent;
        if ("tree".equals(mode)) {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            );
        } else if ("create".equals(mode)) {
            intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime != null ? mime : "application/json");
            intent.putExtra(Intent.EXTRA_TITLE, suggestedName);
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            );
        } else {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mime != null ? mime : "application/json");
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            );
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String initialUri = call.getString("initialUri");
            boolean preferGoogleDrive = Boolean.TRUE.equals(call.getBoolean("preferGoogleDrive", false));
            if (initialUri != null && !initialUri.isEmpty()) {
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initialUri));
            } else if (preferGoogleDrive) {
                intent.putExtra(
                    DocumentsContract.EXTRA_INITIAL_URI,
                    Uri.parse("content://com.google.android.apps.docs.storage/root")
                );
            }
        }

        startActivityForResult(call, intent, "onSafPickResult");
    }

    @ActivityCallback
    private void onSafPickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri uri = data.getData();
        int takeFlags = data.getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (takeFlags == 0) {
            takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (SecurityException ignored) {
            // Some one-shot providers don't support persistable grants; proceed with session grant
        }

        String mode = call.getString("mode", "open");
        String displayName = resolveSafDisplayName(uri, "tree".equals(mode));

        JSObject out = new JSObject();
        out.put("cancelled", false);
        out.put("uri", uri.toString());
        out.put("displayName", displayName);
        call.resolve(out);
    }

    @PluginMethod
    public void safStat(PluginCall call) {
        ioPool.execute(() -> {
            String rawUri = call.getString("uri");
            if (rawUri == null || rawUri.isEmpty()) {
                call.reject("uri is required", "invalid-argument");
                return;
            }
            Uri uri = Uri.parse(rawUri);
            try {
                String[] projection = new String[] {
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                    OpenableColumns.DISPLAY_NAME
                };
                try (Cursor cursor = getContext().getContentResolver()
                    .query(uri, projection, null, null, null)) {
                    JSObject res = new JSObject();
                    if (cursor == null || !cursor.moveToFirst()) {
                        res.put("exists", false);
                        call.resolve(res);
                        return;
                    }
                    int sizeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                    int mtimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                    int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);

                    res.put("exists", true);
                    res.put("size", sizeIdx >= 0 && !cursor.isNull(sizeIdx) ? cursor.getLong(sizeIdx) : 0L);
                    res.put("mtimeMs", mtimeIdx >= 0 && !cursor.isNull(mtimeIdx) ? cursor.getLong(mtimeIdx) : 0L);
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                        res.put("displayName", cursor.getString(nameIdx));
                    }
                    call.resolve(res);
                }
            } catch (SecurityException se) {
                call.reject("SecurityException: " + se.getMessage(), "sync-auth", se);
            } catch (Exception e) {
                JSObject res = new JSObject();
                res.put("exists", false);
                call.resolve(res);
            }
        });
    }

    @PluginMethod
    public void safRead(PluginCall call) {
        ioPool.execute(() -> {
            String rawUri = call.getString("uri");
            if (rawUri == null || rawUri.isEmpty()) {
                call.reject("uri is required", "invalid-argument");
                return;
            }
            Uri uri = Uri.parse(rawUri);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    call.reject("FileNotFoundException: stream null for " + rawUri, "not-found");
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream(16_384);
                byte[] buf = new byte[8_192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
                JSObject res = new JSObject();
                res.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                call.resolve(res);
            } catch (SecurityException se) {
                call.reject("SecurityException: " + se.getMessage(), "sync-auth", se);
            } catch (Exception e) {
                call.reject("SAF read failed: " + e.getMessage(), "network", e);
            }
        });
    }

    @PluginMethod
    public void safReadRange(PluginCall call) {
        ioPool.execute(() -> {
            String rawUri = call.getString("uri");
            long start = safeLong(call, "start", 0L);
            int length = safeInt(call, "length", 262_144);
            if (rawUri == null || rawUri.isEmpty() || length < 0) {
                call.reject("Invalid SAF readRange arguments", "invalid-argument");
                return;
            }
            Uri uri = Uri.parse(rawUri);
            ContentResolver resolver = getContext().getContentResolver();

            try {
                byte[] slice = readSafSlice(resolver, uri, Math.max(0L, start), length);
                JSObject res = new JSObject();
                res.put("base64", Base64.encodeToString(slice, Base64.NO_WRAP));
                call.resolve(res);
            } catch (SecurityException se) {
                call.reject("SecurityException: " + se.getMessage(), "sync-auth", se);
            } catch (Exception e) {
                call.reject("SAF readRange failed: " + e.getMessage(), "network", e);
            }
        });
    }

    private static byte[] readSafSlice(
        ContentResolver resolver,
        Uri uri,
        long start,
        int length
    ) throws IOException {
        if (length == 0) return new byte[0];
        try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
            if (pfd != null && pfd.getStatSize() >= 0) {
                try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                     FileChannel channel = fis.getChannel()) {
                    long total = channel.size();
                    if (start >= total) return new byte[0];
                    int toRead = (int) Math.min((long) length, total - start);
                    ByteBuffer buf = ByteBuffer.allocate(toRead);
                    channel.position(start);
                    while (buf.hasRemaining()) {
                        int n = channel.read(buf);
                        if (n < 0) break;
                    }
                    int readBytes = buf.position();
                    return readBytes == toRead ? buf.array() : java.util.Arrays.copyOf(buf.array(), readBytes);
                }
            }
        } catch (IOException ignored) {
            // Fall through to stream skip for virtual DocumentsProviders
        }

        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return new byte[0];
            long remainingSkip = start;
            while (remainingSkip > 0) {
                long skipped = in.skip(remainingSkip);
                if (skipped <= 0) {
                    if (in.read() < 0) return new byte[0];
                    remainingSkip -= 1;
                } else {
                    remainingSkip -= skipped;
                }
            }
            byte[] buf = new byte[length];
            int offset = 0;
            while (offset < length) {
                int n = in.read(buf, offset, length - offset);
                if (n < 0) break;
                offset += n;
            }
            return offset == length ? buf : java.util.Arrays.copyOf(buf, offset);
        }
    }

    /**
     * Truncating full-file SAF write (`ARCHITECTURE.md §8.2`) compatible with both local
     * `ExternalStorageProvider` and cloud `DocumentsProvider`s (Google Drive, OneDrive, Nextcloud).
     */
    @PluginMethod
    public void safWrite(PluginCall call) {
        ioPool.execute(() -> {
            String rawUri = call.getString("uri");
            String base64 = call.getString("base64", "");
            if (rawUri == null || rawUri.isEmpty()) {
                call.reject("uri is required", "invalid-argument");
                return;
            }
            byte[] bytes = Base64.decode(base64 != null ? base64 : "", Base64.DEFAULT);
            Uri uri = Uri.parse(rawUri);

            try {
                writeSafBytes(getContext().getContentResolver(), uri, bytes);
                call.resolve();
            } catch (SecurityException se) {
                call.reject("SecurityException: " + se.getMessage(), "sync-auth", se);
            } catch (FileNotFoundException fnfe) {
                call.reject("FileNotFoundException: " + fnfe.getMessage(), "sync-auth", fnfe);
            } catch (Exception e) {
                call.reject("SAF write failed: " + e.getMessage(), "network", e);
            }
        });
    }

    private static void writeSafBytes(
        ContentResolver resolver,
        Uri uri,
        byte[] bytes
    ) throws IOException {
        OutputStream openedStream = null;
        IOException lastOpenErr = null;
        String[] modes = new String[] { "wt", "rwt", "w", null };
        for (String mode : modes) {
            try {
                openedStream = mode != null
                    ? resolver.openOutputStream(uri, mode)
                    : resolver.openOutputStream(uri);
                if (openedStream != null) {
                    break;
                }
            } catch (SecurityException se) {
                throw se;
            } catch (IllegalArgumentException | FileNotFoundException e) {
                lastOpenErr = new IOException(e.getMessage(), e);
            }
        }

        if (openedStream != null) {
            try (OutputStream out = openedStream) {
                if (out instanceof FileOutputStream) {
                    try {
                        FileChannel ch = ((FileOutputStream) out).getChannel();
                        ch.position(0L);
                        ch.truncate(0L);
                    } catch (Exception ignored) {
                        // Cloud DocumentsProviders may back FileOutputStream with a non-seekable pipe
                    }
                }
                out.write(bytes);
                out.flush();
                if (out instanceof FileOutputStream) {
                    try {
                        FileOutputStream fos = (FileOutputStream) out;
                        fos.getChannel().truncate(bytes.length);
                        fos.getChannel().force(true);
                        fos.getFD().sync();
                    } catch (Exception ignored) {
                        // Cloud DocumentsProviders commit on close() and may not support truncate/fsync
                    }
                }
            }
            return;
        }

        try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "rw")) {
            if (pfd == null) {
                if (lastOpenErr != null) throw lastOpenErr;
                throw new FileNotFoundException("openOutputStream and openFileDescriptor returned null");
            }
            try (FileOutputStream fos = new FileOutputStream(pfd.getFileDescriptor());
                 FileChannel channel = fos.getChannel()) {
                try {
                    channel.position(0L);
                } catch (Exception ignored) {
                }
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                try {
                    channel.truncate(bytes.length);
                    channel.force(true);
                    pfd.getFileDescriptor().sync();
                } catch (Exception ignored) {
                }
            }
        }
    }

    @PluginMethod
    public void safListTree(PluginCall call) {
        ioPool.execute(() -> {
            String rawTreeUri = call.getString("treeUri");
            if (rawTreeUri == null || rawTreeUri.isEmpty()) {
                call.reject("treeUri is required", "invalid-argument");
                return;
            }
            try {
                Uri treeUri = Uri.parse(rawTreeUri);
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
                if (root == null || !root.exists()) {
                    call.reject("SAF folder does not exist or permission was revoked", "not-found");
                    return;
                }

                JSArray entries = new JSArray();
                for (DocumentFile child : root.listFiles()) {
                    String name = child.getName();
                    if (name == null) continue;
                    JSObject item = new JSObject();
                    item.put("uri", child.getUri().toString());
                    item.put("name", name);
                    item.put("mime", child.getType() != null ? child.getType() : "");
                    item.put("size", child.length());
                    item.put("mtimeMs", child.lastModified());
                    item.put("isDirectory", child.isDirectory());
                    entries.put(item);
                }

                JSObject res = new JSObject();
                res.put("entries", entries);
                call.resolve(res);
            } catch (SecurityException se) {
                call.reject("SecurityException: " + se.getMessage(), "sync-auth", se);
            } catch (Exception e) {
                call.reject("safListTree failed: " + e.getMessage(), "not-found", e);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Media3 PlaybackService Controls (`media.*`)
    // -------------------------------------------------------------------------

    @PluginMethod
    public void mediaLoad(PluginCall call) {
        PlaybackService.TrackSpec spec = parseTrackSpec(call.getData(), true);
        if (spec == null) {
            call.reject("Invalid mediaLoad payload", "invalid-argument");
            return;
        }
        PlaybackService.execute(getContext(), true, svc -> {
            JSObject state = svc.loadTrack(spec);
            call.resolve(state);
        });
    }

    @PluginMethod
    public void mediaSetQueue(PluginCall call) {
        JSArray arr = call.getArray("items");
        List<PlaybackService.TrackSpec> specs = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject raw = arr.optJSONObject(i);
                if (raw != null) {
                    PlaybackService.TrackSpec spec = parseTrackSpec(raw, false);
                    if (spec != null) {
                        specs.add(spec);
                    }
                }
            }
        }
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.setQueueTracks(specs);
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaPlay(PluginCall call) {
        PlaybackService.execute(getContext(), true, svc -> {
            svc.play();
            call.resolve(svc.buildStateObject());
        });
    }

    @PluginMethod
    public void mediaPause(PluginCall call) {
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaSeekTo(PluginCall call) {
        long pos = safeLong(call, "positionMs", 0L);
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.seekToMs(pos);
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaSetSpeed(PluginCall call) {
        Double sp = call.getDouble("speed", 1.0);
        float speed = sp != null ? sp.floatValue() : 1.0f;
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.setSpeed(speed);
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaSetSleepTimer(PluginCall call) {
        String mode = call.getString("mode", "off");
        if (mode == null) mode = "off";
        int minutes = safeInt(call, "minutes", 0);
        long chapterEndMs = safeLong(call, "chapterEndMs", 0L);
        final String resolvedMode = mode;
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.setSleepTimer(resolvedMode, minutes, chapterEndMs);
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaStop(PluginCall call) {
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            call.resolve();
            return;
        }
        PlaybackService.execute(getContext(), false, s -> {
            s.stopPlayback();
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaGetState(PluginCall call) {
        PlaybackService svc = PlaybackService.peekInstance();
        if (svc == null) {
            // Service was stopped while paused in the background: report the saved paused
            // episode/position instead of wiping the UI back to 0:00.
            JSObject saved = PlaybackService.readSavedIdleState(getContext());
            if (saved != null) {
                call.resolve(saved);
                return;
            }
            JSObject idle = new JSObject();
            idle.put("playing", false);
            idle.put("buffering", false);
            idle.put("positionMs", 0);
            idle.put("speed", 1.0);
            call.resolve(idle);
            return;
        }
        PlaybackService.execute(getContext(), false, s -> call.resolve(s.buildStateObject()));
    }

    @PluginMethod
    public void mediaReadJournal(PluginCall call) {
        ioPool.execute(() -> call.resolve(PlaybackService.readJournal(getContext())));
    }

    @PluginMethod
    public void mediaClearJournal(PluginCall call) {
        long upTo = safeLong(call, "upToWallMs", System.currentTimeMillis());
        ioPool.execute(() -> {
            PlaybackService.clearJournal(getContext(), upTo);
            call.resolve();
        });
    }

    @PluginMethod
    public void mediaAckFlush(PluginCall call) {
        PlaybackService.ackFlushStatic();
        call.resolve();
    }

    // -------------------------------------------------------------------------
    // Google Sign-In (`auth.*`) for Google Drive Sync
    // -------------------------------------------------------------------------

    @Nullable
    private String getSavedGoogleAccountEmail() {
        try {
            SharedPreferences prefs =
                getContext().getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE);
            String saved = prefs.getString(AUTH_PREFS_ACCOUNT_EMAIL, null);
            return saved != null && !saved.trim().isEmpty() ? saved.trim() : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void saveGoogleAccountEmail(@Nullable String email) {
        if (email == null || email.trim().isEmpty()) return;
        try {
            getContext()
                .getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(AUTH_PREFS_ACCOUNT_EMAIL, email.trim())
                .apply();
        } catch (Exception ignored) {
            // ignore
        }
    }

    private static List<String> extractOAuthScopes(PluginCall call) {
        JSArray scopesArr = call.getArray("scopes");
        List<String> scopes = new ArrayList<>();
        if (scopesArr != null) {
            for (int i = 0; i < scopesArr.length(); i++) {
                String s = scopesArr.optString(i, "");
                if (!s.isEmpty()) scopes.add(s);
            }
        }
        if (scopes.isEmpty()) {
            scopes.add("https://www.googleapis.com/auth/drive.appdata");
        }
        return scopes;
    }

    @SuppressWarnings("deprecation")
    private void launchGoogleAccountChooser(
        PluginCall call,
        @Nullable GoogleSignInClient fallbackSignInClient
    ) {
        try {
            Intent chooseIntent = AccountManager.newChooseAccountIntent(
                null,
                null,
                new String[] { "com.google" },
                null,
                null,
                null,
                null
            );
            startActivityForResult(call, chooseIntent, "onGoogleAccountPickedResult");
        } catch (ActivityNotFoundException e) {
            if (fallbackSignInClient != null) {
                startActivityForResult(call, fallbackSignInClient.getSignInIntent(), "onGoogleSignInResult");
            } else {
                launchGoogleDriveSafFallback(call);
            }
        } catch (Exception e) {
            launchGoogleDriveSafFallback(call);
        }
    }

    @PluginMethod
    public void authStatus(PluginCall call) {
        int code = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(getContext());
        JSObject res = new JSObject();
        res.put("available", code == ConnectionResult.SUCCESS);
        call.resolve(res);
    }

    @PluginMethod
    public void authGoogleSignIn(PluginCall call) {
        int gmsStatus = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(getContext());
        if (gmsStatus != ConnectionResult.SUCCESS) {
            JSObject unsupported = new JSObject();
            unsupported.put("supported", false);
            call.resolve(unsupported);
            return;
        }

        List<String> scopes = extractOAuthScopes(call);
        String rawHint = call.getString("accountHint");
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        String effectiveHint = (rawHint != null && !rawHint.trim().isEmpty())
            ? rawHint.trim()
            : (!interactive ? getSavedGoogleAccountEmail() : null);

        if (effectiveHint != null && !effectiveHint.isEmpty()) {
            Account hintedAccount = new Account(effectiveHint, "com.google");
            pendingConsentAccount = hintedAccount;
            ioPool.execute(() -> resolveAccessTokenForAccount(call, hintedAccount, scopes));
            return;
        }

        GoogleSignInOptions.Builder gsoBuilder =
            new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestEmail();
        for (String s : scopes) {
            gsoBuilder.requestScopes(new Scope(s));
        }

        GoogleSignInClient signInClient = GoogleSignIn.getClient(getContext(), gsoBuilder.build());
        ioPool.execute(() -> {
            try {
                GoogleSignInAccount account = Tasks.await(signInClient.silentSignIn());
                if (account != null && account.getAccount() != null) {
                    saveGoogleAccountEmail(account.getAccount().name);
                    pendingConsentAccount = account.getAccount();
                    resolveAccessTokenForAccount(call, account.getAccount(), scopes);
                    return;
                }
                resolveAccessTokenForAccount(call, account, scopes);
            } catch (Exception silentErr) {
                String savedEmail = getSavedGoogleAccountEmail();
                if (!interactive && savedEmail != null && !savedEmail.isEmpty()) {
                    Account savedAccount = new Account(savedEmail, "com.google");
                    pendingConsentAccount = savedAccount;
                    resolveAccessTokenForAccount(call, savedAccount, scopes);
                    return;
                }
                Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Sign-in required in foreground", "sync-auth", silentErr);
                    return;
                }
                activity.runOnUiThread(() -> launchGoogleAccountChooser(call, signInClient));
            }
        });
    }

    @ActivityCallback
    private void onGoogleAccountPickedResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Google Sign-In cancelled", "cancelled");
            return;
        }
        String accountName = data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
        String accountType = data.getStringExtra(AccountManager.KEY_ACCOUNT_TYPE);
        if (accountName == null || accountName.trim().isEmpty()) {
            call.reject("No Google account selected", "sync-auth");
            return;
        }
        String cleanEmail = accountName.trim();
        String cleanType = (accountType != null && !accountType.trim().isEmpty())
            ? accountType.trim()
            : "com.google";
        saveGoogleAccountEmail(cleanEmail);
        Account account = new Account(cleanEmail, cleanType);
        pendingConsentAccount = account;
        List<String> scopes = extractOAuthScopes(call);
        ioPool.execute(() -> resolveAccessTokenForAccount(call, account, scopes));
    }

    @ActivityCallback
    private void onGoogleSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null) {
            if (result.getResultCode() == Activity.RESULT_CANCELED) {
                call.reject("Google Sign-In cancelled", "cancelled");
            } else {
                Activity activity = getActivity();
                if (activity != null) {
                    activity.runOnUiThread(() -> launchGoogleDriveSafFallback(call));
                } else {
                    call.reject("Google Sign-In failed", "sync-auth");
                }
            }
            return;
        }

        List<String> scopes = extractOAuthScopes(call);

        ioPool.execute(() -> {
            try {
                GoogleSignInAccount account =
                    GoogleSignIn.getSignedInAccountFromIntent(data).getResult(ApiException.class);
                resolveAccessTokenForAccount(call, account, scopes);
            } catch (ApiException e) {
                int statusCode = e.getStatusCode();
                if (statusCode == 12501 || statusCode == 16) {
                    call.reject("Google Sign-In cancelled", "cancelled", e);
                    return;
                }
                if (statusCode == 10 || statusCode == 12500) {
                    Activity activity = getActivity();
                    if (activity != null) {
                        activity.runOnUiThread(() -> launchGoogleAccountChooser(call, null));
                        return;
                    }
                }
                call.reject("Google Sign-In failed (code " + statusCode + "): " + e.getMessage(), "sync-auth", e);
            } catch (Exception e) {
                if (result.getResultCode() == Activity.RESULT_CANCELED) {
                    call.reject("Google Sign-In cancelled", "cancelled", e);
                    return;
                }
                call.reject("Google Sign-In failed: " + e.getMessage(), "sync-auth", e);
            }
        });
    }

    private void launchGoogleDriveSafFallback(PluginCall call) {
        String safMode = call.getString("safMode", "create");
        boolean isOpen = "open".equalsIgnoreCase(safMode);
        Intent intent = new Intent(isOpen ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        if (!isOpen) {
            intent.putExtra(Intent.EXTRA_TITLE, "minipod-sync-v1.json");
        }
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(
                DocumentsContract.EXTRA_INITIAL_URI,
                Uri.parse("content://com.google.android.apps.docs.storage/root")
            );
        }
        startActivityForResult(call, intent, "onGoogleDriveSafFallbackResult");
    }

    @ActivityCallback
    private void onGoogleDriveSafFallbackResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Google Drive file selection cancelled", "cancelled");
            return;
        }

        Uri uri = data.getData();
        int takeFlags = data.getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (takeFlags == 0) {
            takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (SecurityException ignored) {
            // Proceed with session grant if provider does not support persistable URI permissions
        }

        String displayName = resolveSafDisplayName(uri, false);
        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("safUri", uri.toString());
        out.put("displayName", displayName);
        call.resolve(out);
    }

    private void resolveAccessTokenForAccount(
        PluginCall call,
        @Nullable GoogleSignInAccount account,
        List<String> scopes
    ) {
        Account androidAccount = account != null ? account.getAccount() : null;
        if (androidAccount == null
            && account != null
            && account.getEmail() != null
            && !account.getEmail().trim().isEmpty()) {
            androidAccount = new Account(account.getEmail().trim(), "com.google");
        }
        if (androidAccount == null) {
            call.reject("Signed-in Google account has no Android Account handle", "sync-auth");
            return;
        }
        resolveAccessTokenForAccount(call, androidAccount, scopes);
    }

    private void resolveAccessTokenForAccount(
        PluginCall call,
        Account androidAccount,
        List<String> scopes
    ) {
        pendingConsentAccount = androidAccount;
        boolean forceRefresh = Boolean.TRUE.equals(call.getBoolean("forceRefresh", false));
        String oauthScope = "oauth2:" + String.join(" ", scopes);
        try {
            if (forceRefresh) {
                String prevToken = GoogleAuthUtil.getToken(getContext(), androidAccount, oauthScope);
                GoogleAuthUtil.clearToken(getContext(), prevToken);
            }
            String token = GoogleAuthUtil.getToken(getContext(), androidAccount, oauthScope);
            saveGoogleAccountEmail(androidAccount.name);
            JSObject out = new JSObject();
            out.put("supported", true);
            out.put("accessToken", token);
            out.put("expiresAt", System.currentTimeMillis() + 50L * 60_000L);
            if (androidAccount.name != null && !androidAccount.name.isEmpty()) {
                out.put("accountEmail", androidAccount.name);
            }
            call.resolve(out);
        } catch (UserRecoverableAuthException recoverable) {
            Activity activity = getActivity();
            Intent recoverIntent = recoverable.getIntent();
            if (activity != null && recoverIntent != null) {
                activity.runOnUiThread(() ->
                    startActivityForResult(call, recoverIntent, "onGoogleConsentResult")
                );
            } else {
                call.reject("User consent required for Google Drive", "sync-auth", recoverable);
            }
        } catch (GoogleAuthException | SecurityException authErr) {
            Activity activity = getActivity();
            if (activity != null) {
                activity.runOnUiThread(() -> launchGoogleDriveSafFallback(call));
                return;
            }
            call.reject("Failed to obtain Google OAuth token: " + authErr.getMessage(), "sync-auth", authErr);
        } catch (Exception e) {
            call.reject("Failed to obtain Google OAuth token: " + e.getMessage(), "sync-auth", e);
        }
    }

    @ActivityCallback
    private void onGoogleConsentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Google Drive consent denied", "sync-auth");
            return;
        }
        Account account = pendingConsentAccount;
        if (account == null) {
            String savedEmail = getSavedGoogleAccountEmail();
            if (savedEmail != null) {
                account = new Account(savedEmail, "com.google");
            }
        }
        if (account != null) {
            final Account targetAccount = account;
            final List<String> scopes = extractOAuthScopes(call);
            ioPool.execute(() -> resolveAccessTokenForAccount(call, targetAccount, scopes));
            return;
        }
        authGoogleSignIn(call);
    }

    // -------------------------------------------------------------------------
    // Native In-App APK Auto-Download & Installer (`downloadAndInstallApk`)
    // -------------------------------------------------------------------------

    /**
     * Streams a GitHub Release APK into `<cacheDir>/updates/minipod-<version>.apk` via `.tmp`
     * atomic rename, manually following up to 5 cross-host redirects (`github.com` ->
     * `objects.githubusercontent.com`) while rejecting `https -> http` downgrades, verifying
     * ZIP magic (`PK\x03\x04`) and `PackageManager.getPackageArchiveInfo` (`dev.minipod.app`
     * + `versionCode`), emitting `apkDownloadProgress` events, and launching the Android
     * package installer via `FileProvider` (`dev.minipod.app.fileprovider`).
     */
    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        final String rawUrl = call.getString("url", "");
        final String version = call.getString("version", "latest");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("Missing APK download URL", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            File tmpFile = null;
            try {
                File updatesDir = new File(getContext().getCacheDir(), "updates");
                if (!updatesDir.exists() && !updatesDir.mkdirs() && !updatesDir.exists()) {
                    throw new IOException("Cannot create updates cache directory");
                }
                String safeVer = (version != null ? version : "latest")
                    .replaceAll("[^a-zA-Z0-9._-]", "_");
                if (safeVer.isEmpty()) safeVer = "latest";

                File apkFile = new File(updatesDir, "minipod-" + safeVer + ".apk");
                tmpFile = new File(updatesDir, "minipod-" + safeVer + ".apk.tmp");

                URL parsedCurrent = new URL(rawUrl.trim());
                String initialScheme = parsedCurrent.getProtocol();
                if (!"https".equalsIgnoreCase(initialScheme) && !"http".equalsIgnoreCase(initialScheme)) {
                    throw new IllegalArgumentException("Unsupported APK URL scheme: " + initialScheme);
                }

                HttpURLConnection conn = null;
                for (int redirect = 0; ; redirect++) {
                    conn = (HttpURLConnection) parsedCurrent.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15_000);
                    conn.setReadTimeout(60_000);
                    conn.setRequestProperty("User-Agent", "MiniPod-Updater/1.0");
                    conn.setRequestProperty(
                        "Accept",
                        "application/octet-stream, application/vnd.android.package-archive, */*"
                    );
                    conn.setRequestProperty("Accept-Encoding", "identity");

                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        if (redirect >= 5) {
                            conn.disconnect();
                            throw new IOException("Too many redirects (>5) when downloading APK");
                        }
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.trim().isEmpty()) {
                            throw new IOException("Redirect HTTP " + status + " missing Location header");
                        }
                        URL nextUrl = new URL(parsedCurrent, loc.trim());
                        if ("https".equalsIgnoreCase(parsedCurrent.getProtocol())
                            && !"https".equalsIgnoreCase(nextUrl.getProtocol())) {
                            throw new SecurityException(
                                "Refusing HTTPS -> HTTP downgrade redirect when downloading APK"
                            );
                        }
                        parsedCurrent = nextUrl;
                        continue;
                    }

                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        throw new IOException("HTTP " + status + " when downloading APK");
                    }
                    break;
                }

                long totalBytes = conn.getContentLengthLong();
                long downloadedBytes = 0L;
                long lastNotifyMs = 0L;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(tmpFile)) {
                    byte[] buf = new byte[32_768];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        out.write(buf, 0, n);
                        downloadedBytes += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotifyMs >= DOWNLOAD_PROGRESS_THROTTLE_MS
                            || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
                            lastNotifyMs = now;
                            JSObject progress = new JSObject();
                            progress.put("downloadedBytes", downloadedBytes);
                            progress.put("totalBytes", totalBytes);
                            progress.put(
                                "percent",
                                totalBytes > 0
                                    ? Math.min(100, (int) ((downloadedBytes * 100L) / totalBytes))
                                    : -1
                            );
                            notifyListeners("apkDownloadProgress", progress);
                        }
                    }
                    out.flush();
                    out.getFD().sync();
                } finally {
                    conn.disconnect();
                }

                verifyApkArchive(getContext(), tmpFile);

                if (apkFile.exists() && !apkFile.delete()) {
                    throw new IOException("Cannot replace existing cached APK");
                }
                if (!tmpFile.renameTo(apkFile)) {
                    throw new IOException("Failed to finalize downloaded APK via atomic rename");
                }

                boolean launched = launchApkInstaller(getContext(), apkFile);
                JSObject ret = new JSObject();
                ret.put("filePath", apkFile.getAbsolutePath());
                ret.put("sizeBytes", apkFile.length());
                ret.put("installerLaunched", launched);
                ret.put("installed", launched);
                ret.put("needsPermission", !launched);
                call.resolve(ret);
            } catch (Exception e) {
                if (tmpFile != null && tmpFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    tmpFile.delete();
                }
                call.reject("APK download failed: " + e.getMessage(), "update-failed", e);
            }
        });
    }

    /**
     * Launches the Android package installer for an already-downloaded cached APK
     * (e.g. after granting "Install unknown apps").
     */
    @PluginMethod
    public void installApkFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        if (filePath == null || filePath.trim().isEmpty()) {
            call.reject("Missing filePath", "invalid-argument");
            return;
        }
        try {
            File updatesCanonical = new File(getContext().getCacheDir(), "updates").getCanonicalFile();
            File apkFile = new File(filePath).getCanonicalFile();
            String allowedPrefix = updatesCanonical.getPath() + File.separator;
            if (!apkFile.getPath().startsWith(allowedPrefix) || !apkFile.exists()) {
                call.reject("APK file not found in updates cache", "not-found");
                return;
            }
            verifyApkArchive(getContext(), apkFile);
            boolean launched = launchApkInstaller(getContext(), apkFile);
            JSObject ret = new JSObject();
            ret.put("filePath", apkFile.getAbsolutePath());
            ret.put("installerLaunched", launched);
            ret.put("installed", launched);
            ret.put("needsPermission", !launched);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to launch APK installer: " + e.getMessage(), "update-failed", e);
        }
    }

    /**
     * Called from `MainActivity.onResume()` so returning from the "Install unknown apps"
     * settings screen automatically resumes a pending APK install.
     */
    public static void resumePendingApkInstall(Context context) {
        File pending = pendingInstallApkFile;
        if (pending == null || !pending.exists()) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.getPackageManager().canRequestPackageInstalls()) {
            return;
        }
        pendingInstallApkFile = null;
        try {
            startPackageInstallViewIntent(context, pending);
            // v0.1.26: tell the UI the installer was auto-launched so the banner / Settings row
            // switch from "Grant & install" to the re-trigger "Install APK" state.
            MiniPodPlugin plugin = activeInstance;
            if (plugin != null) {
                JSObject ev = new JSObject();
                ev.put("filePath", pending.getAbsolutePath());
                ev.put("installerLaunched", true);
                plugin.notifyListeners("apkInstallResumed", ev);
            }
        } catch (Exception ignored) {
            // User can still tap "Install APK" manually in the UI banner / Settings
        }
    }

    @SuppressWarnings("deprecation")
    private static void verifyApkArchive(Context context, File file) throws Exception {
        if (file.length() < 1024L) {
            throw new IOException("Downloaded file is too small (" + file.length() + " bytes)");
        }
        try (FileInputStream checkIn = new FileInputStream(file)) {
            byte[] magic = new byte[4];
            if (checkIn.read(magic) != 4
                || magic[0] != 0x50
                || magic[1] != 0x4B
                || magic[2] != 0x03
                || magic[3] != 0x04) {
                throw new SecurityException("Downloaded file does not have ZIP/APK magic (PK\\x03\\x04)");
            }
        }

        PackageManager pm = context.getPackageManager();
        PackageInfo archiveInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? pm.getPackageArchiveInfo(file.getAbsolutePath(), PackageManager.PackageInfoFlags.of(0))
            : pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
        if (archiveInfo == null || !"dev.minipod.app".equals(archiveInfo.packageName)) {
            String foundPkg = archiveInfo != null ? archiveInfo.packageName : "null";
            throw new SecurityException(
                "APK packageName mismatch (expected dev.minipod.app, got " + foundPkg + ")"
            );
        }

        PackageInfo installedInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? pm.getPackageInfo(context.getPackageName(), PackageManager.PackageInfoFlags.of(0))
            : pm.getPackageInfo(context.getPackageName(), 0);
        long archiveVersionCode = PackageInfoCompat.getLongVersionCode(archiveInfo);
        long installedVersionCode = PackageInfoCompat.getLongVersionCode(installedInfo);
        if (archiveVersionCode < installedVersionCode) {
            throw new SecurityException(
                "Refusing APK versionCode downgrade (" + archiveVersionCode + " < " + installedVersionCode + ")"
            );
        }
    }

    private static boolean launchApkInstaller(Context context, File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!context.getPackageManager().canRequestPackageInstalls()) {
                pendingInstallApkFile = apkFile;
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(permIntent);
                return false;
            }
        }
        pendingInstallApkFile = null;
        startPackageInstallViewIntent(context, apkFile);
        return true;
    }

    private static void startPackageInstallViewIntent(Context context, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            context,
            "dev.minipod.app.fileprovider",
            apkFile
        );
        Intent installIntent = new Intent(Intent.ACTION_VIEW);
        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(installIntent);
    }

    // -------------------------------------------------------------------------
    // Utility helpers
    // -------------------------------------------------------------------------

    @Nullable
    private static PlaybackService.TrackSpec parseTrackSpec(JSONObject obj, boolean hasSpeed) {
        String episodeKey = obj.optString("episodeKey", "");
        JSONObject source = obj.optJSONObject("source");
        if (episodeKey.isEmpty() || source == null) return null;

        String kind = source.optString("kind", "url");
        String uriOrPath = "file".equals(kind)
            ? source.optString("path", "")
            : source.optString("url", "");
        if (uriOrPath.isEmpty()) return null;

        String mime = source.has("mime") && !source.isNull("mime") ? source.optString("mime") : null;
        Map<String, String> headers = jsonObjectToMap(source.optJSONObject("headers"));
        long startMs = obj.optLong("startMs", 0L);
        float speed = hasSpeed ? (float) obj.optDouble("speed", 1.0) : 1.0f;
        boolean playWhenReady = obj.optBoolean("playWhenReady", false);

        JSONObject meta = obj.optJSONObject("metadata");
        String title = meta != null ? meta.optString("title", "") : "";
        String artist = meta != null && meta.has("artist") && !meta.isNull("artist")
            ? meta.optString("artist")
            : null;
        String album = meta != null && meta.has("album") && !meta.isNull("album")
            ? meta.optString("album")
            : null;
        String artworkUrl = meta != null && meta.has("artworkUrl") && !meta.isNull("artworkUrl")
            ? meta.optString("artworkUrl")
            : null;
        long durationMs = meta != null ? meta.optLong("durationMs", 0L) : 0L;

        return new PlaybackService.TrackSpec(
            episodeKey,
            kind,
            uriOrPath,
            mime,
            headers,
            startMs,
            speed,
            title,
            artist,
            album,
            artworkUrl,
            durationMs,
            playWhenReady
        );
    }

    private String resolveSafDisplayName(Uri uri, boolean isTree) {
        if (isTree) {
            DocumentFile tree = DocumentFile.fromTreeUri(getContext(), uri);
            if (tree != null && tree.getName() != null) {
                return tree.getName();
            }
            return uri.getLastPathSegment() != null ? uri.getLastPathSegment() : uri.toString();
        }
        try (Cursor c = getContext().getContentResolver().query(
            uri,
            new String[] { OpenableColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !c.isNull(idx)) {
                    return c.getString(idx);
                }
            }
        } catch (Exception ignored) {
            // ignore
        }
        return uri.getLastPathSegment() != null ? uri.getLastPathSegment() : uri.toString();
    }

    @Nullable
    private File resolveSafeChild(File baseDir, String relativePath) {
        try {
            File baseCanonical = baseDir.getCanonicalFile();
            File candidate = new File(baseCanonical, relativePath).getCanonicalFile();
            String basePrefix = baseCanonical.getPath() + File.separator;
            if (!candidate.getPath().startsWith(basePrefix)) {
                return null;
            }
            return candidate;
        } catch (IOException e) {
            return null;
        }
    }

    @Nullable
    private File resolveAllowedLocalFile(String pathOrRel) {
        try {
            File filesCanonical = getContext().getFilesDir().getCanonicalFile();
            File candidate = pathOrRel.startsWith("/")
                ? new File(pathOrRel).getCanonicalFile()
                : new File(filesCanonical, pathOrRel).getCanonicalFile();
            String prefix = filesCanonical.getPath() + File.separator;
            if (!candidate.getPath().startsWith(prefix)) {
                return null;
            }
            return candidate;
        } catch (IOException e) {
            return null;
        }
    }

    private static Map<String, String> jsonObjectToMap(@Nullable JSONObject obj) {
        if (obj == null) return new HashMap<>();
        Map<String, String> out = new HashMap<>();
        Iterator<String> it = obj.keys();
        while (it.hasNext()) {
            String k = it.next();
            if (!obj.isNull(k)) {
                out.put(k, obj.optString(k, ""));
            }
        }
        return out;
    }

    @Nullable
    private static String findHeaderIgnoreCase(Map<String, String> headers, String target) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(target)) {
                return e.getValue();
            }
        }
        return null;
    }

    private static void removeHeaderIgnoreCase(Map<String, String> headers, String target) {
        Iterator<String> it = headers.keySet().iterator();
        while (it.hasNext()) {
            if (it.next().equalsIgnoreCase(target)) {
                it.remove();
            }
        }
    }

    private static int safeInt(PluginCall call, String key, int fallback) {
        JSObject data = call.getData();
        if (data == null || !data.has(key) || data.isNull(key)) {
            return fallback;
        }
        Object raw = data.opt(key);
        if (raw instanceof Number) {
            return ((Number) raw).intValue();
        }
        if (raw instanceof String) {
            try {
                return (int) Math.round(Double.parseDouble(((String) raw).trim()));
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return data.optInt(key, fallback);
    }

    private static long safeLong(PluginCall call, String key, long fallback) {
        JSObject data = call.getData();
        if (data == null || !data.has(key) || data.isNull(key)) {
            return fallback;
        }
        Object raw = data.opt(key);
        if (raw instanceof Number) {
            return ((Number) raw).longValue();
        }
        if (raw instanceof String) {
            try {
                return Math.round(Double.parseDouble(((String) raw).trim()));
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return data.optLong(key, fallback);
    }

    private static boolean sameOriginHostPort(HttpUrl a, HttpUrl b) {
        if (!a.host().equalsIgnoreCase(b.host())) return false;
        if (a.port() != b.port()) {
            boolean httpToHttpsDefault =
                "http".equals(a.scheme()) && a.port() == 80
                    && "https".equals(b.scheme()) && b.port() == 443;
            return httpToHttpsDefault;
        }
        return a.scheme().equals(b.scheme())
            || ("http".equals(a.scheme()) && "https".equals(b.scheme()));
    }
}
