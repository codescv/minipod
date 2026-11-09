package dev.minipod.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.OkHttpClient;

/**
 * Process-wide native episode download engine (outlives the WebView / `MiniPodPlugin` instance).
 *
 * <p>Android 14–17 background reliability: the 3-slot FIFO queue ({@link DownloadQueue}), the
 * automatic Range-resuming retries ({@link RetryingDownload}) and the transfers themselves all run
 * natively, so items 4..N keep downloading while Chromium freezes the WebView's JS. While
 * anything is active or queued, {@link EpisodeDownloadService} holds a `dataSync` foreground
 * service + `PARTIAL_WAKE_LOCK` + `WifiLock` so the Cached Apps Freezer / Doze do not kill the
 * sockets. Terminal results are journaled in {@link DownloadResultStore} until the WebView acks
 * them (`getDownloadSnapshot` / `ackDownloadResults`).
 */
final class EpisodeDownloadManager {

    static final long PROGRESS_THROTTLE_MS = 250L;
    private static final String PREFS = "minipod_downloads";
    private static final String PREFS_RESULTS = "results";

    /** Plugin-side event sink (`download-state` / `download-progress`). */
    interface EventSink {
        void onDownloadEvent(String eventName, JSObject payload);
    }

    /** What to download. */
    static final class Spec {
        final String episodeKey;
        final String url;
        final File finalFile;
        final File partFile;
        final Map<String, String> headers;
        @Nullable final String authUser;
        final String authPass;
        @Nullable final String title;
        final long enclosureSize;

        Spec(
            String episodeKey,
            String url,
            File finalFile,
            Map<String, String> headers,
            @Nullable String authUser,
            String authPass,
            @Nullable String title,
            long enclosureSize
        ) {
            this.episodeKey = episodeKey;
            this.url = url;
            this.finalFile = finalFile;
            this.partFile = new File(finalFile.getAbsolutePath() + ".part");
            this.headers = headers;
            this.authUser = authUser;
            this.authPass = authPass != null ? authPass : "";
            this.title = title;
            this.enclosureSize = enclosureSize;
        }
    }

    @Nullable private static volatile EpisodeDownloadManager instance;

    static EpisodeDownloadManager get(Context context) {
        EpisodeDownloadManager m = instance;
        if (m == null) {
            synchronized (EpisodeDownloadManager.class) {
                m = instance;
                if (m == null) {
                    m = new EpisodeDownloadManager(context.getApplicationContext());
                    instance = m;
                }
            }
        }
        return m;
    }

    @Nullable
    static EpisodeDownloadManager peek() {
        return instance;
    }

    private final Context appContext;
    private final OkHttpClient client = DownloadHttpOpener.createClient();
    private final Set<EventSink> sinks = new CopyOnWriteArraySet<>();
    private final DownloadResultStore results;
    private final DownloadQueue<Spec, DownloadTransfer.Result> queue;
    private final RetryingDownload retrying;
    /** Android 15+ `dataSync` FGS budget exhausted (reset when the app returns to the foreground). */
    private volatile boolean foregroundTimedOut;

    private EpisodeDownloadManager(Context appContext) {
        this.appContext = appContext;
        SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.results = new DownloadResultStore(new DownloadResultStore.Storage() {
            @Override
            public String read() {
                return prefs.getString(PREFS_RESULTS, null);
            }

            @Override
            public void write(String value) {
                prefs.edit().putString(PREFS_RESULTS, value).apply();
            }
        });
        this.retrying = new RetryingDownload(
            new DownloadRetryPolicy(),
            RetryingDownload.TOKEN_SLEEPER,
            this::isNetworkConnected,
            Math::random,
            System::currentTimeMillis,
            RetryingDownload.DEFAULT_OFFLINE_WAIT_MS
        );
        AtomicInteger threadSeq = new AtomicInteger();
        ExecutorService pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "minipod-download-" + threadSeq.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
        this.queue = new DownloadQueue<>(
            DownloadQueue.MAX_CONCURRENT_DOWNLOADS,
            pool,
            this::runJob,
            new QueueListener()
        );
    }

    // ------------------------------------------------------------------ public API

    void addSink(EventSink sink) {
        sinks.add(sink);
    }

    void removeSink(EventSink sink) {
        sinks.remove(sink);
    }

    /** Enqueues (or joins) the download of {@code spec.episodeKey}. */
    void enqueue(Spec spec, DownloadQueue.Waiter<DownloadTransfer.Result> waiter) {
        queue.enqueue(spec.episodeKey, spec, waiter);
    }

    /** No live native task (and no journaled result) for an `attachOnly` re-attach. */
    static final class NotActiveException extends java.io.IOException {
        NotActiveException(String key) {
            super("No native download task for " + key);
        }
    }

    /**
     * Re-attach only (never starts a transfer): joins the live task, or settles immediately from
     * the journaled terminal result, or fails with {@link NotActiveException}.
     */
    void attach(String episodeKey, DownloadQueue.Waiter<DownloadTransfer.Result> waiter) {
        if (queue.attach(episodeKey, waiter)) return;
        for (DownloadResultStore.Entry e : results.list()) {
            if (!e.episodeKey.equals(episodeKey)) continue;
            if ("DONE".equals(e.state) && e.path != null && new File(e.path).exists()) {
                waiter.onSuccess(new DownloadTransfer.Result(e.size, e.mime));
                return;
            }
            if ("FAILED".equals(e.state)) {
                waiter.onFailure(new java.io.IOException(
                    e.errorMessage != null ? e.errorMessage : "Episode download failed"), false);
                return;
            }
        }
        waiter.onFailure(new NotActiveException(episodeKey), false);
    }

    /** Stops a queued / running download, deletes its `.part` and forgets any terminal result. */
    void cancel(String episodeKey) {
        results.remove(episodeKey);
        DownloadQueue.Job<Spec, DownloadTransfer.Result> job = queue.get(episodeKey);
        queue.cancel(episodeKey);
        if (job != null && job.state() == DownloadQueue.State.QUEUED) {
            deleteQuietly(job.spec().partFile);
        }
    }

    void cancelAll() {
        List<String> keys = queue.cancelAll();
        for (String k : keys) results.remove(k);
    }

    void ack(List<String> keys) {
        results.ack(keys);
    }

    /** Called when the app returns to the foreground: Android resets the `dataSync` FGS budget. */
    void onAppForeground() {
        foregroundTimedOut = false;
        EpisodeDownloadService.sync(appContext, true);
    }

    void onForegroundServiceTimeout() {
        foregroundTimedOut = true;
    }

    boolean isForegroundTimedOut() {
        return foregroundTimedOut;
    }

    int runningCount() {
        return queue.runningCount();
    }

    int queuedCount() {
        return queue.queuedCount();
    }

    boolean isIdle() {
        return queue.isIdle();
    }

    List<DownloadQueue.Job<Spec, DownloadTransfer.Result>> activeJobs() {
        return queue.snapshot();
    }

    /** `{ entries: [...active QUEUED/RUNNING, ...unacked DONE/FAILED] }` for the WebView. */
    JSObject snapshot() {
        JSArray entries = new JSArray();
        Set<String> activeKeys = new java.util.HashSet<>();
        long now = System.currentTimeMillis();
        for (DownloadQueue.Job<Spec, DownloadTransfer.Result> job : queue.snapshot()) {
            if (job.token.isCancelled()) continue;
            activeKeys.add(job.key);
            JSObject o = new JSObject();
            o.put("episodeKey", job.key);
            o.put("state", job.state() == DownloadQueue.State.RUNNING ? "RUNNING" : "QUEUED");
            long bytes = job.bytesDownloaded;
            if (bytes <= 0L) {
                File part = job.spec().partFile;
                bytes = part.exists() ? part.length() : 0L;
            }
            o.put("bytesDownloaded", bytes);
            if (job.totalBytes > 0L) o.put("totalBytes", job.totalBytes);
            o.put("updatedWallMs", now);
            entries.put(o);
        }
        for (DownloadResultStore.Entry e : results.list()) {
            if (activeKeys.contains(e.episodeKey)) continue;
            if ("DONE".equals(e.state) && (e.path == null || !new File(e.path).exists())) {
                // File vanished (user cleared storage): nothing to adopt.
                continue;
            }
            try {
                entries.put(JSObject.fromJSONObject(e.toJson()));
            } catch (org.json.JSONException ignored) {
                // skip corrupt record
            }
        }
        JSObject out = new JSObject();
        out.put("entries", entries);
        out.put("maxConcurrent", queue.maxConcurrent());
        return out;
    }

    /** Aggregated notification data: [running, queued, percent(-1 = indeterminate)]. */
    int[] notificationCounts() {
        List<DownloadQueue.Job<Spec, DownloadTransfer.Result>> jobs = queue.snapshot();
        int running = 0;
        int queued = 0;
        List<long[]> sizes = new ArrayList<>();
        for (DownloadQueue.Job<Spec, DownloadTransfer.Result> j : jobs) {
            if (j.state() == DownloadQueue.State.RUNNING) {
                running++;
                long total = j.totalBytes > 0L ? j.totalBytes : j.spec().enclosureSize;
                sizes.add(new long[] { j.bytesDownloaded, total });
            } else {
                queued++;
            }
        }
        long[] bytes = new long[sizes.size()];
        long[] totals = new long[sizes.size()];
        for (int i = 0; i < sizes.size(); i++) {
            bytes[i] = sizes.get(i)[0];
            totals[i] = sizes.get(i)[1];
        }
        return new int[] { running, queued, DownloadForegroundPolicy.aggregatePercent(bytes, totals) };
    }

    /** Title of the first running episode (notification text), or null. */
    @Nullable
    String firstRunningTitle() {
        for (DownloadQueue.Job<Spec, DownloadTransfer.Result> j : queue.snapshot()) {
            if (j.state() == DownloadQueue.State.RUNNING && j.spec().title != null
                && !j.spec().title.trim().isEmpty()) {
                return j.spec().title;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ internals

    private DownloadTransfer.Result runJob(DownloadQueue.Job<Spec, DownloadTransfer.Result> job)
        throws Exception {
        Spec spec = job.spec();
        File parent = spec.finalFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
            throw new DownloadTransfer.DownloadFileException("Unable to create downloads directory", null);
        }
        DownloadHttpOpener opener = new DownloadHttpOpener(
            client, spec.url, spec.headers, spec.authUser, spec.authPass, job.token
        );
        try {
            return retrying.run(
                opener,
                spec.partFile,
                spec.finalFile,
                job.token,
                (done, total) -> {
                    job.bytesDownloaded = done;
                    if (total > 0L) job.totalBytes = total;
                    JSObject prog = new JSObject();
                    prog.put("episodeKey", job.key);
                    prog.put("bytesDownloaded", done);
                    if (total > 0L) prog.put("totalBytes", total);
                    emit("download-progress", prog);
                    EpisodeDownloadService.refreshIfRunning();
                },
                PROGRESS_THROTTLE_MS,
                System::currentTimeMillis,
                (nextAttempt, delayMs, cause) -> {
                    JSObject extra = new JSObject();
                    extra.put("attempt", nextAttempt);
                    extra.put("retryInMs", delayMs);
                    extra.put("bytesDownloaded", job.bytesDownloaded);
                    if (job.totalBytes > 0L) extra.put("totalBytes", job.totalBytes);
                    emitState(job.key, "RUNNING", extra);
                }
            );
        } finally {
            job.token.clearActiveAbort();
        }
    }

    private final class QueueListener implements DownloadQueue.Listener<Spec, DownloadTransfer.Result> {
        @Override
        public void onQueued(DownloadQueue.Job<Spec, DownloadTransfer.Result> job) {
            results.remove(job.key);
            File part = job.spec().partFile;
            long partial = part.exists() ? part.length() : 0L;
            job.bytesDownloaded = partial;
            JSObject extra = new JSObject();
            extra.put("bytesDownloaded", partial);
            emitState(job.key, "QUEUED", extra);
            // User-initiated enqueue (app in the foreground): the moment to promote the FGS.
            EpisodeDownloadService.sync(appContext, true);
        }

        @Override
        public void onStarted(DownloadQueue.Job<Spec, DownloadTransfer.Result> job) {
            JSObject extra = new JSObject();
            extra.put("attempt", 1);
            extra.put("bytesDownloaded", job.bytesDownloaded);
            emitState(job.key, "RUNNING", extra);
        }

        @Override
        public void onFinished(
            DownloadQueue.Job<Spec, DownloadTransfer.Result> job,
            @Nullable DownloadTransfer.Result result,
            @Nullable Throwable error,
            boolean cancelled
        ) {
            Spec spec = job.spec();
            long now = System.currentTimeMillis();
            if (cancelled) {
                deleteQuietly(spec.partFile);
                if (result != null) {
                    // Stopped right as it finished: discard the fresh file too.
                    deleteQuietly(spec.finalFile);
                }
                results.remove(job.key);
                emitState(job.key, "NONE", null);
                return;
            }
            if (error == null && result != null) {
                results.put(DownloadResultStore.Entry.done(
                    job.key, spec.finalFile.getAbsolutePath(), result.size, result.contentType, now
                ));
                JSObject extra = new JSObject();
                extra.put("path", spec.finalFile.getAbsolutePath());
                extra.put("size", result.size);
                if (result.contentType != null) extra.put("mime", result.contentType);
                emitState(job.key, "DONE", extra);
                return;
            }
            String message = error != null && error.getMessage() != null
                ? error.getMessage()
                : "Episode download failed";
            results.put(DownloadResultStore.Entry.failed(job.key, "network", message, now));
            JSObject err = new JSObject();
            err.put("code", "network");
            err.put("message", message);
            JSObject extra = new JSObject();
            extra.put("error", err);
            emitState(job.key, "FAILED", extra);
        }

        @Override
        public void onCountsChanged(int running, int queued) {
            EpisodeDownloadService.sync(appContext, false);
        }
    }

    private void emitState(String episodeKey, String state, @Nullable JSObject extra) {
        JSObject o = extra != null ? extra : new JSObject();
        o.put("episodeKey", episodeKey);
        o.put("state", state);
        emit("download-state", o);
    }

    private void emit(String eventName, JSObject payload) {
        for (EventSink sink : sinks) {
            try {
                sink.onDownloadEvent(eventName, payload);
            } catch (RuntimeException ignored) {
                // a detached WebView bridge must not break the download thread
            }
        }
    }

    private boolean isNetworkConnected() {
        try {
            ConnectivityManager cm =
                (ConnectivityManager) appContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network active = cm.getActiveNetwork();
            if (active == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            return caps == null || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (RuntimeException e) {
            // e.g. missing ACCESS_NETWORK_STATE on an exotic ROM: just retry
            return true;
        }
    }

    private static void deleteQuietly(@Nullable File f) {
        if (f != null && f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
