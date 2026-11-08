package dev.minipod.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.KeyEvent;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.MediaStyleNotificationHelper;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Background Media3 `MediaSessionService` + `ExoPlayer` for MiniPod (`ARCHITECTURE.md §3.3`).
 *
 * Guarantees screen-off playback independence when the Capacitor WebView is throttled or killed:
 *   1. Autonomous marathon queue auto-advance via `setQueue` (`ExoPlayer` playlist items).
 *   2. Native sleep timer (`off`, `minutes`, `endOfEpisode`, `endOfChapter`) with 60 s linear volume fade.
 *   3. Persistent 5 s checkpoint + append-only `completed[]` journal in `minipod_playback.xml`.
 *   4. Bounded 15 s `PARTIAL_WAKE_LOCK` (`MiniPod:SyncFlush`) on pause/stop/ended, released early on `ackFlush()`.
 *   5. Lock-screen / notification / System UI controls: Rewind -10 s | Play/Pause | Fast-forward
 *      +30 s (`LockScreenControls`, `LockScreenSessionPlayer`, `LockScreenNotificationProvider`),
 *      with every session seek checkpointed and emitted (`media-state` + `seeked: true`).
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaSessionService {
    public static final String PREFS_NAME = "minipod_playback";
    public static final String NOTIFICATION_CHANNEL_ID = "minipod_playback";
    public static final int NOTIFICATION_ID = 1001;
    private static final String KEY_CURRENT = "current";
    private static final String KEY_COMPLETED = "completed";
    /** Full `TrackSpec` (+ latest `positionMs`) of the active episode so a restarted service can resume. */
    private static final String KEY_LAST_TRACK = "lastTrack";
    /**
     * Remaining native queue (`setQueueTracks` items) so a headless restart (headset / Bluetooth
     * Play via `MediaButtonReceiver`, System UI resumption) keeps marathon auto-advance (bc737679).
     */
    static final String KEY_LAST_QUEUE = "lastQueue";
    private static final long PAUSED_FOREGROUND_GRACE_MS = PlaybackForegroundPolicy.PAUSED_FOREGROUND_GRACE_MS;

    private static final long STATE_TICK_MS = 1_000L;
    private static final long JOURNAL_CHECKPOINT_MS = 5_000L;
    private static final long SLEEP_TICK_MS = 500L;
    private static final long SLEEP_FADE_WINDOW_MS = 60_000L;
    private static final long FLUSH_WAKE_LOCK_TIMEOUT_MS = 15_000L;
    private static final long SEEK_BACK_MS = LockScreenControls.SEEK_BACK_MS;
    private static final long SEEK_FORWARD_MS = LockScreenControls.SEEK_FORWARD_MS;

    private static final Object JOURNAL_LOCK = new Object();
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final List<ServiceAction> PENDING_ACTIONS = new ArrayList<>();
    private static final Set<ServiceEventListener> LISTENERS = new CopyOnWriteArraySet<>();

    private static volatile PlaybackService instance;

    public interface ServiceAction {
        void run(PlaybackService service);
    }

    public interface ServiceEventListener {
        void onMediaState(JSObject state);
        void onMediaEnded(JSObject ended);
        void onMediaError(JSObject error);
        void onSleepTimerState(JSObject sleepState);
    }

    public static final class TrackSpec {
        public final String episodeKey;
        public final String sourceKind; // "url" | "file"
        public final String uriOrPath;
        @Nullable public final String mime;
        public final Map<String, String> headers;
        public final long startMs;
        public final float speed;
        public final String title;
        @Nullable public final String artist;
        @Nullable public final String album;
        @Nullable public final String artworkUrl;
        public final long durationMs;
        public final boolean playWhenReady;

        public TrackSpec(
            String episodeKey,
            String sourceKind,
            String uriOrPath,
            @Nullable String mime,
            Map<String, String> headers,
            long startMs,
            float speed,
            String title,
            @Nullable String artist,
            @Nullable String album,
            @Nullable String artworkUrl,
            long durationMs,
            boolean playWhenReady
        ) {
            this.episodeKey = episodeKey;
            this.sourceKind = sourceKind;
            this.uriOrPath = uriOrPath;
            this.mime = mime;
            this.headers = headers != null ? new HashMap<>(headers) : Collections.emptyMap();
            this.startMs = Math.max(0L, startMs);
            this.speed = speed;
            this.title = title != null ? title : "";
            this.artist = artist;
            this.album = album;
            this.artworkUrl = artworkUrl;
            this.durationMs = durationMs;
            this.playWhenReady = playWhenReady;
        }
    }

    private final Map<String, Map<String, String>> headersByUri = new ConcurrentHashMap<>();
    private final Map<String, Long> startMsByEpisodeKey = new ConcurrentHashMap<>();
    private final Map<String, Long> durationHintByEpisodeKey = new ConcurrentHashMap<>();

    private ExoPlayer player;
    /** Session-facing wrapper of {@link #player} (lock screen / System UI / Bluetooth seeks). */
    private LockScreenSessionPlayer sessionPlayer;
    private ImmutableList<CommandButton> lockScreenLayout = ImmutableList.of();
    private MediaSession mediaSession;
    private PowerManager.WakeLock flushWakeLock;
    /**
     * `SystemClock.elapsedRealtime()` when playback last ran (`playWhenReady && READY/BUFFERING`),
     * `0` = not in this service instance. Drives the paused-notification foreground grace window.
     */
    private long lastActivePlaybackElapsedMs = 0L;
    private boolean wasActivelyPlaying = false;
    /** `onStartCommand` posted the placeholder; {@link #settleAfterStartCommand()} hands it back to Media3. */
    private boolean bootstrapForegroundPending = false;
    /** Set while re-posting the notification after Android denied a foreground (re)start. */
    private boolean foregroundStartDenied = false;

    @Nullable private String activeEpisodeKey;
    @Nullable private TrackSpec activeTrackSpec;
    /** Spec of playlist item 0 (set by `loadTrack` / restore); queued items follow it. */
    @Nullable private TrackSpec primaryTrackSpec;
    private final List<TrackSpec> queuedSpecs = new ArrayList<>();
    private long lastKnownDurationMs = 0L;
    private long lastKnownPositionMs = 0L;
    private long lastJournalWriteElapsedMs = 0L;
    /**
     * True while the active position comes from an explicit seek (lock screen / notification /
     * System UI / Bluetooth / in-app) with no playback progress since. Checkpoints then carry
     * `seeked: true`, so a deliberate rewind to 0:00 is distinguishable from a transient idle 0
     * (journal reconciliation and `mediaGetState`).
     */
    private boolean positionFromSeek = false;

    // Sleep timer state (main thread only)
    private String sleepMode = "off"; // "off" | "minutes" | "endOfEpisode" | "endOfChapter"
    private int sleepMinutes = 0;
    private long sleepDeadlineElapsedMs = 0L;
    private long sleepChapterEndMs = 0L;
    private long lastSleepEmitElapsedMs = 0L;

    private final Runnable tickRunnable = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            if (player.isPlaying()) {
                // Playback advanced since any explicit seek.
                positionFromSeek = false;
                emitCurrentState();
                long nowElapsed = SystemClock.elapsedRealtime();
                if (nowElapsed - lastJournalWriteElapsedMs >= JOURNAL_CHECKPOINT_MS) {
                    writeCurrentCheckpoint();
                }
                MAIN_HANDLER.postDelayed(this, STATE_TICK_MS);
            }
        }
    };

    private final Runnable sleepTimerRunnable = new Runnable() {
        @Override
        public void run() {
            if (player == null || "off".equals(sleepMode)) {
                return;
            }
            long remainingMs = computeSleepRemainingMs();
            if (remainingMs <= 0L) {
                expireSleepTimer();
                return;
            }

            if (remainingMs <= SLEEP_FADE_WINDOW_MS) {
                float vol = Math.max(0f, Math.min(1f, (float) remainingMs / (float) SLEEP_FADE_WINDOW_MS));
                player.setVolume(vol);
            } else if (player.getVolume() < 1.0f) {
                player.setVolume(1.0f);
            }

            long nowElapsed = SystemClock.elapsedRealtime();
            if (nowElapsed - lastSleepEmitElapsedMs >= 1_000L) {
                lastSleepEmitElapsedMs = nowElapsed;
                emitSleepTimerState(remainingMs);
            }

            MAIN_HANDLER.postDelayed(this, SLEEP_TICK_MS);
        }
    };

    private final Runnable releaseWakeLockRunnable = this::releaseFlushWakeLockInternal;

    /** Paused grace window over: let Media3 detach the paused notification from the foreground. */
    private final Runnable pausedForegroundExpiryRunnable = this::refreshMediaNotification;

    /**
     * Runs after `onStartCommand` (and therefore after Media3's posted media-button dispatch and
     * the drained `execute()` actions): stop when nothing is loaded, otherwise hand the
     * notification back to Media3 so the placeholder never lingers.
     */
    private final Runnable settleAfterStartRunnable = this::settleAfterStartCommand;

    // -------------------------------------------------------------------------
    // Static bridge methods called by `MiniPodPlugin`
    // -------------------------------------------------------------------------

    public static void addEventListener(ServiceEventListener listener) {
        LISTENERS.add(listener);
    }

    public static void removeEventListener(ServiceEventListener listener) {
        LISTENERS.remove(listener);
    }

    public static void execute(Context context, boolean startServiceIfNeeded, ServiceAction action) {
        final Context appCtx = context.getApplicationContext();
        MAIN_HANDLER.post(() -> {
            PlaybackService svc = instance;
            if (svc != null && svc.player != null) {
                action.run(svc);
                return;
            }
            if (!startServiceIfNeeded) {
                return;
            }
            PENDING_ACTIONS.add(action);
            Intent intent = new Intent(appCtx, PlaybackService.class);
            try {
                ContextCompat.startForegroundService(appCtx, intent);
            } catch (Exception ignored) {
                appCtx.startService(intent);
            }
        });
    }

    @Nullable
    public static PlaybackService peekInstance() {
        return instance;
    }

    public static void ackFlushStatic() {
        MAIN_HANDLER.post(() -> {
            PlaybackService svc = instance;
            if (svc != null) {
                svc.releaseFlushWakeLockInternal();
            }
        });
    }

    public static JSObject readJournal(Context context) {
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSObject out = new JSObject();

            String currentJson = prefs.getString(KEY_CURRENT, null);
            if (currentJson != null && !currentJson.isEmpty()) {
                try {
                    out.put("current", new JSObject(currentJson));
                } catch (JSONException ignored) {
                    out.put("current", JSONObject.NULL);
                }
            } else {
                out.put("current", JSONObject.NULL);
            }

            JSArray completedArr = new JSArray();
            String completedJson = prefs.getString(KEY_COMPLETED, null);
            if (completedJson != null && !completedJson.isEmpty()) {
                try {
                    JSONArray parsed = new JSONArray(completedJson);
                    for (int i = 0; i < parsed.length(); i++) {
                        JSONObject item = parsed.optJSONObject(i);
                        if (item != null) {
                            completedArr.put(JSObject.fromJSONObject(item));
                        }
                    }
                } catch (JSONException ignored) {
                    // ignore corrupt journal list
                }
            }
            out.put("completed", completedArr);
            return out;
        }
    }

    /**
     * Saved idle state (`episodeKey`, `positionMs`, `durationMs`, `speed`) from `KEY_LAST_TRACK` /
     * `KEY_CURRENT`, used by `mediaGetState()` when the service is not running so the UI never
     * resets to `0:00` after Android stopped a paused background `PlaybackService`.
     */
    @Nullable
    public static JSObject readSavedIdleState(Context context) {
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String lastStr = prefs.getString(KEY_LAST_TRACK, null);
            TrackSpec spec = parseTrackSpecJson(lastStr);
            if (spec == null) return null;
            JSONObject lastJson = parseJson(lastStr);
            long lastWallMs = lastJson != null ? lastJson.optLong("wallMs", 0L) : 0L;
            long posMs = spec.startMs;
            long durMs = spec.durationMs;
            JSONObject cur = parseJson(prefs.getString(KEY_CURRENT, null));
            boolean curSameEpisode = cur != null && spec.episodeKey.equals(cur.optString("episodeKey"));
            if (curSameEpisode && cur.optLong("wallMs", 0L) >= lastWallMs) {
                posMs = Math.max(0L, cur.optLong("positionMs", posMs));
                long d = cur.optLong("durationMs", 0L);
                if (d > 0L) durMs = d;
            }
            JSObject out = new JSObject();
            out.put("episodeKey", spec.episodeKey);
            out.put("playing", false);
            out.put("buffering", false);
            out.put("positionMs", posMs);
            if (durMs > 0L) {
                out.put("durationMs", durMs);
            }
            out.put("speed", (double) spec.speed);
            if (posMs == 0L && curSameEpisode && cur.optBoolean("seeked", false)) {
                // Deliberate paused rewind to 0:00 (e.g. lock-screen -10 s) before Android stopped
                // the service: the UI must show 0:00, not keep the older position.
                out.put("seeked", true);
            }
            return out;
        }
    }

    public static void clearJournal(Context context, long upToWallMs) {
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();

            String currentJson = prefs.getString(KEY_CURRENT, null);
            if (currentJson != null) {
                try {
                    JSONObject cur = new JSONObject(currentJson);
                    long wallMs = cur.optLong("wallMs", 0L);
                    if (wallMs <= upToWallMs) {
                        editor.remove(KEY_CURRENT);
                    }
                } catch (JSONException ignored) {
                    editor.remove(KEY_CURRENT);
                }
            }

            String completedJson = prefs.getString(KEY_COMPLETED, null);
            if (completedJson != null) {
                try {
                    JSONArray arr = new JSONArray(completedJson);
                    JSONArray kept = new JSONArray();
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item != null && item.optLong("endedWallMs", 0L) > upToWallMs) {
                            kept.put(item);
                        }
                    }
                    if (kept.length() == 0) {
                        editor.remove(KEY_COMPLETED);
                    } else {
                        editor.putString(KEY_COMPLETED, kept.toString());
                    }
                } catch (JSONException ignored) {
                    editor.remove(KEY_COMPLETED);
                }
            }

            editor.apply();
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        lastActivePlaybackElapsedMs = 0L;
        wasActivelyPlaying = false;

        ensureNotificationChannel();

        // Rewind -10 s | Play/Pause | Fast-forward +30 s in the `MediaStyle` notification
        // (expanded + collapsed compact view) — see `LockScreenNotificationProvider`; late artwork
        // updates keep the paused grace window foreground (`GraceAwareNotificationProvider`).
        setMediaNotificationProvider(
            new GraceAwareNotificationProvider(
                new LockScreenNotificationProvider(this, NOTIFICATION_ID, NOTIFICATION_CHANNEL_ID),
                this::interceptAsyncNotificationUpdate
            )
        );

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            flushWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MiniPod:SyncFlush");
            flushWakeLock.setReferenceCounted(false);
        }

        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(30_000);

        DefaultDataSource.Factory baseDataSourceFactory =
            new DefaultDataSource.Factory(this, httpFactory);

        ResolvingDataSource.Factory resolvingFactory = new ResolvingDataSource.Factory(
            baseDataSourceFactory,
            dataSpec -> {
                String uriStr = dataSpec.uri.toString();
                Map<String, String> extraHeaders = headersByUri.get(uriStr);
                if (extraHeaders != null && !extraHeaders.isEmpty()) {
                    return dataSpec.withAdditionalHeaders(extraHeaders);
                }
                return dataSpec;
            }
        );

        DefaultExtractorsFactory extractorsFactory = new DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)
            .setConstantBitrateSeekingAlwaysEnabled(true);

        AudioAttributes audioAttrs = new AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .setUsage(C.USAGE_MEDIA)
            .build();

        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(resolvingFactory, extractorsFactory))
            .setAudioAttributes(audioAttrs, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(SEEK_BACK_MS)
            .setSeekForwardIncrementMs(SEEK_FORWARD_MS)
            .build();

        player.addListener(playerListener);

        // The session (lock screen, notification, System UI, Bluetooth, Wear/Auto) drives a
        // `ForwardingPlayer` so its seeks also work on a paused / idle / restored-unprepared track.
        // The in-app bridge and `playerListener` keep using `player` directly.
        sessionPlayer = new LockScreenSessionPlayer(player, sessionPlayerHost);
        lockScreenLayout = LockScreenControls.buildCustomLayout(this);

        PendingIntent sessionActivityPendingIntent = createSessionActivityPendingIntent();
        mediaSession = new MediaSession.Builder(this, sessionPlayer)
            .setSessionActivity(sessionActivityPendingIntent)
            .setCallback(sessionCallback)
            .setCustomLayout(lockScreenLayout)
            .setSessionExtras(LockScreenControls.buildSessionExtras())
            .build();
        addSession(mediaSession);

        // Android 12+ refused a (re)promotion (`ForegroundServiceStartNotAllowedException`, caught
        // by Media3): still post an up-to-date, non-foreground notification instead of leaving a
        // stale one (e.g. a Pause button on a paused player).
        setListener(new MediaSessionService.Listener() {
            @Override
            public void onForegroundServiceStartNotAllowedException() {
                MAIN_HANDLER.post(() -> {
                    foregroundStartDenied = true;
                    try {
                        refreshMediaNotification();
                    } finally {
                        foregroundStartDenied = false;
                    }
                });
            }
        });

        // Restore the last paused track (without preparing) so a fresh service started by
        // `mediaPlay` / `mediaSeekTo` after Android killed it in the background can resume.
        restoreLastTrackIfNeeded(false);

        if (!PENDING_ACTIONS.isEmpty()) {
            List<ServiceAction> drained = new ArrayList<>(PENDING_ACTIONS);
            PENDING_ACTIONS.clear();
            for (ServiceAction action : drained) {
                action.run(this);
            }
        }
    }

    /**
     * Start requests come from `execute()` (`startForegroundService`), from Media3's own
     * `MediaNotificationManager.startForeground` (`startSelfIntent`), and — when the process was
     * dead or the service stopped — from `androidx.media3.session.MediaButtonReceiver`
     * (`ACTION_MEDIA_BUTTON`, headset / Bluetooth Play). Every `startForegroundService` must be
     * answered with `startForeground` (Android 12+ `ForegroundServiceDidNotStartInTimeException`),
     * so a placeholder is posted — but only while Media3 is not already foreground with its real
     * `MediaStyle` notification (never overwrite it while playing). `super.onStartCommand` then
     * routes media-button intents to the session (`onMediaButtonEvent`), and
     * {@link #settleAfterStartCommand()} runs right after that dispatch.
     */
    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (PlaybackForegroundPolicy.shouldPostBootstrapForeground(intent != null, isPlaybackOngoing())) {
            bootstrapForegroundPending = startBootstrapForeground() || bootstrapForegroundPending;
        }
        super.onStartCommand(intent, flags, startId);
        if (intent != null) {
            MAIN_HANDLER.removeCallbacks(settleAfterStartRunnable);
            MAIN_HANDLER.post(settleAfterStartRunnable);
        }
        return START_STICKY;
    }

    /** Returns true when the placeholder foreground notification was posted. */
    private boolean startBootstrapForeground() {
        try {
            Notification notification = buildBootstrapForegroundNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            return true;
        } catch (Exception ignored) {
            // e.g. `ForegroundServiceStartNotAllowedException` for a plain `startService` fallback
            return false;
        }
    }

    private void settleAfterStartCommand() {
        boolean bootstrapPosted = bootstrapForegroundPending;
        bootstrapForegroundPending = false;
        if (player == null || mediaSession == null) return;
        if (PlaybackForegroundPolicy.shouldStopAfterStart(player.getMediaItemCount())) {
            // Nothing loaded and nothing restorable (e.g. a headset press after the queue was
            // stopped): no orphan placeholder notification / foreground service.
            try {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            } catch (Exception ignored) {
                // ignore
            }
            stopSelf();
            return;
        }
        if (bootstrapPosted
            && !PlaybackForegroundPolicy.isActivelyPlaying(player.getPlayWhenReady(), player.getPlaybackState())) {
            // Paused / idle: Media3 replaces the placeholder with its paused notification (kept in
            // the foreground during the grace window) or removes it (`STATE_IDLE`). While playing,
            // Media3's own player events already promote it. Only after *our* placeholder: Media3's
            // own `startSelfIntent` never posts one, so this cannot loop.
            refreshMediaNotification();
        }
    }

    /** Re-evaluates Media3's notification + foreground state (see {@link #onUpdateNotification}). */
    private void refreshMediaNotification() {
        if (mediaSession == null || !isSessionAdded(mediaSession)) return;
        try {
            onUpdateNotification(mediaSession, false);
        } catch (RuntimeException ignored) {
            // e.g. `ForegroundServiceStartNotAllowedException` on Android 12+: keep running
        }
    }

    /**
     * Keeps the media notification in the foreground for {@link #PAUSED_FOREGROUND_GRACE_MS}
     * after playback last ran (paused in-app / from the notification / by a headset, audio focus
     * loss, `AudioBecomingNoisy` when earbuds disconnect, or an ended episode). Media3 1.5.1 would
     * otherwise `stopForeground(DETACH)` immediately and Android stops the unbound background
     * service about a minute later, cancelling the notification and the headset Play route.
     */
    @Override
    public void onUpdateNotification(MediaSession session, boolean startInForegroundRequired) {
        boolean keep = !foregroundStartDenied && shouldKeepForegroundNow();
        super.onUpdateNotification(session, startInForegroundRequired || keep);
    }

    private boolean shouldKeepForegroundNow() {
        return player != null && PlaybackForegroundPolicy.shouldKeepForeground(
            player.getMediaItemCount(),
            player.getPlaybackState(),
            player.getPlayWhenReady(),
            lastActivePlaybackElapsedMs,
            SystemClock.elapsedRealtime(),
            PAUSED_FOREGROUND_GRACE_MS
        );
    }

    /**
     * {@link GraceAwareNotificationProvider} hook: a late artwork update would detach the paused
     * notification from the foreground inside the grace window; re-post it through
     * {@link #onUpdateNotification} instead (synchronous: the artwork is cached now).
     */
    private boolean interceptAsyncNotificationUpdate() {
        if (player == null || mediaSession == null) return false;
        if (!PlaybackForegroundPolicy.shouldInterceptAsyncNotificationUpdate(
            isPlaybackOngoing(),
            PlaybackForegroundPolicy.isActivelyPlaying(player.getPlayWhenReady(), player.getPlaybackState()),
            shouldKeepForegroundNow(),
            foregroundStartDenied)) {
            return false;
        }
        refreshMediaNotification();
        return true;
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        writeCurrentCheckpoint();
        if (player != null && PlaybackForegroundPolicy.shouldKeepServiceOnTaskRemoved(
            player.getMediaItemCount(),
            player.getPlaybackState(),
            player.getPlayWhenReady(),
            lastActivePlaybackElapsedMs,
            SystemClock.elapsedRealtime(),
            PAUSED_FOREGROUND_GRACE_MS)) {
            // Keep playing (or keep the paused notification + headset Play) when the user swipes
            // the Activity away; the paused grace window still demotes it later.
            return;
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        MAIN_HANDLER.removeCallbacks(tickRunnable);
        MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
        MAIN_HANDLER.removeCallbacks(pausedForegroundExpiryRunnable);
        MAIN_HANDLER.removeCallbacks(settleAfterStartRunnable);
        writeCurrentCheckpoint();
        releaseFlushWakeLockInternal();

        if (mediaSession != null) {
            removeSession(mediaSession);
            mediaSession.release();
            mediaSession = null;
        }
        if (player != null) {
            player.removeListener(playerListener);
            player.release();
            player = null;
        }
        sessionPlayer = null;
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    private PendingIntent createSessionActivityPendingIntent() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setAction(Intent.ACTION_MAIN);
        launchIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, launchIntent, flags);
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel channel = new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    getString(R.string.playback_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setShowBadge(false);
                channel.setDescription("Podcasts background playback");
                nm.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Minimal placeholder for the mandatory `startForeground` until Media3 posts its own
     * notification with the same id. It intentionally adds <b>no</b> actions, so it can never
     * flash track-skip (prev/next) buttons: on Android 13+ System UI renders the transport row from
     * the session's `PlaybackState`, which carries Rewind -10 s | Play/Pause | Fast-forward +30 s
     * as soon as Media3's notification controller connects (`addSession` in `onCreate` connects it
     * right away; `sessionCallback.onConnect` grants it the custom commands minus track-skip), and
     * on older versions `LockScreenNotificationProvider` replaces it with the same three buttons.
     */
    private Notification buildBootstrapForegroundNotification() {
        ensureNotificationChannel();
        CharSequence appLabel = getString(R.string.app_name);
        CharSequence title = (appLabel != null && appLabel.length() > 0) ? appLabel : "Podcasts";
        CharSequence subtitle = null;
        if (player != null && player.getCurrentMediaItem() != null) {
            MediaMetadata meta = player.getCurrentMediaItem().mediaMetadata;
            if (meta.title != null && meta.title.length() > 0) {
                title = meta.title;
            }
            if (meta.artist != null && meta.artist.length() > 0) {
                subtitle = meta.artist;
            } else if (meta.albumTitle != null && meta.albumTitle.length() > 0) {
                subtitle = meta.albumTitle;
            }
        }
        int smallIcon = getApplicationInfo().icon != 0
            ? getApplicationInfo().icon
            : android.R.drawable.ic_media_play;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(smallIcon)
            .setContentTitle(title)
            .setContentIntent(createSessionActivityPendingIntent())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOngoing(player != null && (player.isPlaying() || player.getPlayWhenReady()));
        if (subtitle != null) {
            builder.setContentText(subtitle);
        }
        if (mediaSession != null) {
            builder.setStyle(new MediaStyleNotificationHelper.MediaStyle(mediaSession));
        }
        return builder.build();
    }

    // -------------------------------------------------------------------------
    // Player commands (Main Thread)
    // -------------------------------------------------------------------------

    public JSObject loadTrack(TrackSpec spec) {
        MAIN_HANDLER.removeCallbacks(tickRunnable);

        if (activeEpisodeKey != null && !activeEpisodeKey.equals(spec.episodeKey)) {
            writeCurrentCheckpoint();
        }

        activeEpisodeKey = spec.episodeKey;
        activeTrackSpec = spec;
        primaryTrackSpec = spec;
        positionFromSeek = false;
        lastKnownPositionMs = spec.startMs;
        lastKnownDurationMs = spec.durationMs > 0 ? spec.durationMs : 0L;
        if (spec.durationMs > 0) {
            durationHintByEpisodeKey.put(spec.episodeKey, spec.durationMs);
        }

        // Local files only need a CPU wake lock; remote streams also need a WifiLock.
        applyWakeModeFor(spec);

        MediaItem item = toMediaItem(spec);
        float clampedSpeed = Math.max(0.5f, Math.min(3.0f, spec.speed));
        player.setPlaybackParameters(new PlaybackParameters(clampedSpeed));
        player.setVolume(1.0f);
        player.setMediaItem(item, spec.startMs);
        player.prepare();
        player.setPlayWhenReady(spec.playWhenReady);
        persistLastTrack(spec.startMs);

        JSObject state = buildStateObject();
        emitStateObject(state);
        return state;
    }

    public void setQueueTracks(List<TrackSpec> items) {
        startMsByEpisodeKey.clear();
        queuedSpecs.clear();
        queuedSpecs.addAll(items);
        persistQueue(items);
        // Offline (e.g. Airplane Mode): never hand remote URLs to ExoPlayer. It would pre-buffer
        // the next playlist item right after a local file is fully buffered, fail with a network
        // `PlaybackException` and drop the *whole* player (incl. the playing local file) to IDLE.
        boolean online = isNetworkConnected();
        List<MediaItem> nextItems = new ArrayList<>(items.size());
        for (TrackSpec spec : items) {
            if (spec.episodeKey.equals(activeEpisodeKey)) {
                continue;
            }
            startMsByEpisodeKey.put(spec.episodeKey, spec.startMs);
            if (spec.durationMs > 0) {
                durationHintByEpisodeKey.put(spec.episodeKey, spec.durationMs);
            }
            if (!online && !"file".equals(spec.sourceKind)) {
                continue;
            }
            nextItems.add(toMediaItem(spec));
        }

        if (player.getMediaItemCount() == 0) {
            return;
        }
        int currentIndex = player.getCurrentMediaItemIndex();
        int removeFrom = currentIndex + 1;
        if (removeFrom <= player.getMediaItemCount()) {
            player.replaceMediaItems(removeFrom, player.getMediaItemCount(), nextItems);
        }
    }

    public void play() {
        if (player.getMediaItemCount() == 0 || activeEpisodeKey == null) {
            restoreLastTrackIfNeeded(true);
        }
        if (player.getMediaItemCount() == 0) {
            emitCurrentState();
            return;
        }
        if (player.getPlaybackState() == Player.STATE_IDLE) {
            // Recover from a previous error (e.g. offline preload failure) at the paused position.
            long currentPos = Math.max(0L, player.getCurrentPosition());
            long targetPos = Math.max(currentPos, lastKnownPositionMs);
            if (targetPos > 0L && Math.abs(currentPos - targetPos) > 500L) {
                player.seekTo(targetPos);
            }
            player.prepare();
        }
        if (player.getPlaybackState() == Player.STATE_ENDED) {
            player.seekTo(0L);
            lastKnownPositionMs = 0L;
        }
        player.setVolume(1.0f);
        player.play();
        scheduleTicks();
        emitCurrentState();
    }

    public void pause() {
        player.pause();
        writeCurrentCheckpoint();
        acquireFlushWakeLock();
        emitCurrentState();
    }

    public void seekToMs(long positionMs) {
        long clamped = Math.max(0L, positionMs);
        if (player.getMediaItemCount() == 0 || activeEpisodeKey == null) {
            restoreLastTrackIfNeeded(true);
        }
        if (player.getMediaItemCount() == 0) {
            emitCurrentState();
            return;
        }
        if (player.getPlaybackState() == Player.STATE_IDLE) {
            player.prepare();
        }
        player.seekTo(clamped);
        lastKnownPositionMs = clamped;
        if (player.isPlaying()) {
            scheduleTicks();
        }
        writeCurrentCheckpoint();
        emitCurrentState();
    }

    public void setSpeed(float speed) {
        float clamped = Math.max(0.5f, Math.min(3.0f, speed));
        player.setPlaybackParameters(new PlaybackParameters(clamped));
        emitCurrentState();
    }

    public void setSleepTimer(String mode, int minutes, long chapterEndMs) {
        MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
        sleepMode = mode != null ? mode : "off";
        sleepMinutes = Math.max(0, minutes);
        sleepChapterEndMs = Math.max(0L, chapterEndMs);

        if ("off".equals(sleepMode)) {
            sleepDeadlineElapsedMs = 0L;
            if (player != null) {
                player.setVolume(1.0f);
            }
            emitSleepTimerState(0L);
            return;
        }

        if ("minutes".equals(sleepMode)) {
            long durMs = Math.max(1L, sleepMinutes) * 60_000L;
            sleepDeadlineElapsedMs = SystemClock.elapsedRealtime() + durMs;
            emitSleepTimerState(durMs);
        } else {
            sleepDeadlineElapsedMs = 0L;
            emitSleepTimerState(computeSleepRemainingMs());
        }

        MAIN_HANDLER.postDelayed(sleepTimerRunnable, SLEEP_TICK_MS);
    }

    public void stopPlayback() {
        MAIN_HANDLER.removeCallbacks(tickRunnable);
        MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
        writeCurrentCheckpoint();
        acquireFlushWakeLock();
        sleepMode = "off";
        player.setVolume(1.0f);
        player.stop();
        player.clearMediaItems();
        activeEpisodeKey = null;
        activeTrackSpec = null;
        primaryTrackSpec = null;
        queuedSpecs.clear();
        lastKnownDurationMs = 0L;
        lastKnownPositionMs = 0L;
        positionFromSeek = false;
        clearLastTrack(null);
        clearPersistedQueue();
        emitCurrentState();
    }

    public JSObject buildStateObject() {
        JSObject obj = new JSObject();
        if (activeEpisodeKey != null) {
            obj.put("episodeKey", activeEpisodeKey);
        }
        boolean playing = player != null && player.isPlaying();
        boolean buffering = player != null && player.getPlaybackState() == Player.STATE_BUFFERING;
        long posMs;
        if (player != null && player.getPlaybackState() == Player.STATE_ENDED) {
            // Finished episode: report 0 (never the end position) so a trailing `media-state` after
            // `media-ended` can't look like a mid-track pause that overwrites PLAYED with IN_PROGRESS.
            posMs = 0L;
        } else if (player != null && player.getMediaItemCount() > 0) {
            posMs = Math.max(0L, player.getCurrentPosition());
        } else {
            // Empty player (fresh service / restore failed): keep the last known position instead of 0.
            posMs = activeEpisodeKey != null ? lastKnownPositionMs : 0L;
        }
        long durMs = resolveCurrentDurationMs();
        float speed = player != null ? player.getPlaybackParameters().speed : 1.0f;

        obj.put("playing", playing);
        obj.put("buffering", buffering);
        obj.put("positionMs", posMs);
        if (durMs > 0L) {
            obj.put("durationMs", durMs);
        }
        obj.put("speed", speed);
        return obj;
    }

    /**
     * {@link #buildStateObject()} for `mediaGetState` queries (e.g. `syncStateFromNative()` on app
     * foreground): also flags a paused position that is the result of an explicit seek to 0:00
     * (`seeked: true`), so a lock-screen rewind made while the WebView was frozen is not mistaken
     * for a transient idle 0 by the UI.
     */
    public JSObject buildStateObjectForQuery() {
        JSObject obj = buildStateObject();
        if (positionFromSeek
            && activeEpisodeKey != null
            && player != null
            && player.getPlaybackState() != Player.STATE_ENDED
            && obj.optLong("positionMs", -1L) == 0L) {
            obj.put("seeked", true);
        }
        return obj;
    }

    // -------------------------------------------------------------------------
    // Lock-screen / System UI / Bluetooth session controls
    // -------------------------------------------------------------------------

    private final LockScreenSessionPlayer.Host sessionPlayerHost = new LockScreenSessionPlayer.Host() {
        @Override
        public boolean ensureTrackLoaded() {
            if (player == null) return false;
            if (player.getMediaItemCount() == 0 || activeEpisodeKey == null) {
                restoreLastTrackIfNeeded(true);
            }
            return player.getMediaItemCount() > 0;
        }

        @Override
        public boolean canRestoreTrack() {
            if (activeTrackSpec != null) return true;
            synchronized (JOURNAL_LOCK) {
                return getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .contains(KEY_LAST_TRACK);
            }
        }

        @Override
        public long lastKnownPositionMs() {
            return lastKnownPositionMs;
        }

        @Override
        public long durationHintMs() {
            return resolveCurrentDurationMs();
        }

        @Override
        public void onSessionPlay() {
            // Same side effects as the in-app `play()` (headset / Bluetooth / System UI resume,
            // possibly with no WebView running at all).
            if (player == null) return;
            player.setVolume(1.0f);
            scheduleTicks();
            emitCurrentState();
        }
    };

    private final MediaSession.Callback sessionCallback = new MediaSession.Callback() {
        @Override
        public MediaSession.ConnectionResult onConnect(
            MediaSession session,
            MediaSession.ControllerInfo controller
        ) {
            MediaSession.ConnectionResult.AcceptedResultBuilder result =
                new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(
                        LockScreenControls.withSeekSessionCommands(
                            MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS));
            if (session.isMediaNotificationController(controller)) {
                // Media3 1.5.1 applies these to the platform session (`PlaybackState` actions read
                // by Android 13+ System UI): without SKIP_TO_PREVIOUS / SKIP_TO_NEXT, System UI puts
                // custom action #1 (-10 s) left and #2 (+30 s) right of Play/Pause.
                result
                    .setAvailablePlayerCommands(
                        LockScreenControls.withoutTrackSkipCommands(
                            MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS))
                    .setCustomLayout(lockScreenLayout);
            }
            return result.build();
        }

        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            MediaSession session,
            MediaSession.ControllerInfo controller,
            SessionCommand customCommand,
            Bundle args
        ) {
            long deltaMs = LockScreenControls.deltaForAction(customCommand.customAction);
            if (deltaMs != 0L && sessionPlayer != null) {
                sessionPlayer.seekBy(deltaMs);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            return Futures.immediateFuture(new SessionResult(SessionError.ERROR_NOT_SUPPORTED));
        }

        @Override
        public boolean onMediaButtonEvent(
            MediaSession session,
            MediaSession.ControllerInfo controller,
            Intent intent
        ) {
            KeyEvent keyEvent = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_KEY_EVENT, KeyEvent.class);
            if (keyEvent == null) return false;
            if (sessionPlayer != null
                && sessionPlayer.handlePlayPauseKey(keyEvent.getKeyCode(), keyEvent.getRepeatCount())) {
                // Headset / Bluetooth / TWS Play-Pause (bc737679): resumes in every state (paused,
                // idle after an error or restored unprepared, empty-but-restorable, ended).
                return true;
            }
            long deltaMs = LockScreenControls.deltaForMediaKey(keyEvent.getKeyCode());
            if (deltaMs == 0L) return false;
            // Long-press auto-repeat would fire a seek storm: seek once per press.
            if (keyEvent.getRepeatCount() == 0 && sessionPlayer != null) {
                sessionPlayer.seekBy(deltaMs);
            }
            return true;
        }

        /**
         * Media3 calls this for a Play request (System UI resumption card, AVRCP / controller Play,
         * Bluetooth after process death) when the player has no current item. Restores the last
         * episode at its exact checkpoint with speed, auth headers, duration hints and the
         * remaining queue; Media3 then sets the items, prepares and plays.
         */
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            MediaSession session,
            MediaSession.ControllerInfo controller
        ) {
            MediaSession.MediaItemsWithStartPosition items = preparePlaybackResumption();
            if (items == null) {
                return Futures.immediateFailedFuture(
                    new IllegalStateException("No MiniPod episode to resume"));
            }
            return Futures.immediateFuture(items);
        }
    };

    /**
     * Lock-screen / notification / Bluetooth seeks (and seekbar scrubs) reach ExoPlayer through the
     * session without passing `seekToMs()`: checkpoint + emit them immediately so the in-app
     * player, `minipod_playback.xml` (`KEY_CURRENT` + `KEY_LAST_TRACK`) and IndexedDB stay in sync.
     */
    private void onSeekDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition) {
        if (player == null || activeEpisodeKey == null) return;
        // Cross-item seeks are owned by `onMediaItemTransition` (delivered after this callback,
        // while `activeEpisodeKey` still names the previous item).
        if (oldPosition.mediaItemIndex != newPosition.mediaItemIndex) return;
        if (player.getPlaybackState() == Player.STATE_ENDED) return;

        lastKnownPositionMs = Math.max(0L, newPosition.positionMs);
        positionFromSeek = true;
        writeCurrentCheckpoint();
        if (player.isPlaying()) {
            scheduleTicks();
        } else {
            // Paused: keep the CPU up briefly so a hidden WebView can flush the new position.
            acquireFlushWakeLock();
        }
        JSObject state = buildStateObject();
        state.put("seeked", true);
        emitStateObject(state);
    }

    // -------------------------------------------------------------------------
    // Internal helpers & `Player.Listener`
    // -------------------------------------------------------------------------

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onPositionDiscontinuity(
            Player.PositionInfo oldPosition,
            Player.PositionInfo newPosition,
            int reason
        ) {
            if (LockScreenControls.isSeekDiscontinuity(reason)) {
                onSeekDiscontinuity(oldPosition, newPosition);
            }
        }

        @Override
        public void onTimelineChanged(Timeline timeline, int reason) {
            if (player == null) return;
            long d = player.getDuration();
            if (d != C.TIME_UNSET && d > 0L && d != lastKnownDurationMs) {
                lastKnownDurationMs = d;
                if (activeEpisodeKey != null) {
                    durationHintByEpisodeKey.put(activeEpisodeKey, d);
                }
                emitCurrentState();
            }
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            if (isPlaying) {
                scheduleTicks();
            } else {
                MAIN_HANDLER.removeCallbacks(tickRunnable);
                if (player != null && player.getPlaybackState() != Player.STATE_ENDED) {
                    writeCurrentCheckpoint();
                    acquireFlushWakeLock();
                }
            }
            emitCurrentState();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            updateForegroundGrace();
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            updateForegroundGrace();
            if (playbackState == Player.STATE_READY) {
                long d = player.getDuration();
                if (d != C.TIME_UNSET && d > 0L) {
                    lastKnownDurationMs = d;
                    if (activeEpisodeKey != null) {
                        durationHintByEpisodeKey.put(activeEpisodeKey, d);
                    }
                }
                emitCurrentState();
            } else if (playbackState == Player.STATE_ENDED) {
                String finishedKey = activeEpisodeKey;
                long dur = resolveCurrentDurationMs();
                // Completed: the resume point is the start, not the end position.
                lastKnownPositionMs = 0L;
                MAIN_HANDLER.removeCallbacks(tickRunnable);
                MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
                player.setVolume(1.0f);
                if (!"off".equals(sleepMode)) {
                    sleepMode = "off";
                    emitSleepTimerState(0L);
                }

                if (finishedKey != null) {
                    appendCompletedJournal(finishedKey, dur);
                    acquireFlushWakeLock();

                    JSObject endedObj = new JSObject();
                    endedObj.put("episodeKey", finishedKey);
                    for (ServiceEventListener l : LISTENERS) {
                        l.onMediaEnded(endedObj);
                    }
                }
                emitCurrentState();
            } else {
                emitCurrentState();
            }
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
            if (mediaItem == null) return;
            String nextKey = mediaItem.mediaId;
            String prevKey = activeEpisodeKey;
            if (nextKey != null && !nextKey.equals(prevKey)) {
                // A different episode: an explicit seek on the previous one no longer applies.
                positionFromSeek = false;
            }

            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && prevKey != null && !prevKey.equals(nextKey)) {
                long prevDur = durationHintByEpisodeKey.getOrDefault(prevKey, lastKnownDurationMs);
                appendCompletedJournal(prevKey, prevDur);

                // If sleep timer was set to `endOfEpisode`, suppress auto-advance and pause cleanly!
                if ("endOfEpisode".equals(sleepMode)) {
                    MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
                    sleepMode = "off";
                    player.pause();
                    player.setVolume(1.0f);
                    activeEpisodeKey = nextKey;
                    adoptQueuedSpec(nextKey);
                    Long resumeStart = startMsByEpisodeKey.get(nextKey);
                    if (resumeStart != null && resumeStart > 0L) {
                        player.seekTo(resumeStart);
                    }
                    writeCurrentCheckpoint();
                    acquireFlushWakeLock();
                    emitSleepTimerState(0L);

                    JSObject endedObj = new JSObject();
                    endedObj.put("episodeKey", prevKey);
                    for (ServiceEventListener l : LISTENERS) {
                        l.onMediaEnded(endedObj);
                    }
                    emitCurrentState();
                    return;
                }

                // Autonomous marathon auto-advance to `nextKey`!
                activeEpisodeKey = nextKey;
                adoptQueuedSpec(nextKey);
                lastKnownDurationMs = durationHintByEpisodeKey.getOrDefault(nextKey, 0L);
                Long resumeStart = startMsByEpisodeKey.get(nextKey);
                if (resumeStart != null && resumeStart > 0L) {
                    player.seekTo(resumeStart);
                }
                writeCurrentCheckpoint();

                JSObject endedObj = new JSObject();
                endedObj.put("episodeKey", prevKey);
                endedObj.put("autoAdvancedTo", nextKey);
                for (ServiceEventListener l : LISTENERS) {
                    l.onMediaEnded(endedObj);
                }
                emitCurrentState();
            } else if (nextKey != null && !nextKey.isEmpty()) {
                activeEpisodeKey = nextKey;
                adoptQueuedSpec(nextKey);
                lastKnownDurationMs = durationHintByEpisodeKey.getOrDefault(nextKey, 0L);
                emitCurrentState();
            }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            writeCurrentCheckpoint();
            acquireFlushWakeLock();

            // A later (remote) playlist item failed while pre-buffering/transitioning after a local
            // file: drop the trailing items so the local item is not poisoned by the network error.
            TrackSpec primary = primaryTrackSpec;
            if (primary != null
                && "file".equals(primary.sourceKind)
                && player != null
                && player.getCurrentMediaItemIndex() > 0
                && player.getMediaItemCount() > 1) {
                try {
                    player.removeMediaItems(1, player.getMediaItemCount());
                    activeEpisodeKey = primary.episodeKey;
                    activeTrackSpec = primary;
                    applyWakeModeFor(primary);
                } catch (Exception ignored) {
                    // ignore
                }
            }

            JSObject errShape = new JSObject();
            errShape.put("code", "network");
            errShape.put(
                "message",
                error.getMessage() != null ? error.getMessage() : "ExoPlayer playback error"
            );

            JSObject payload = new JSObject();
            if (activeEpisodeKey != null) {
                payload.put("episodeKey", activeEpisodeKey);
            }
            payload.put("error", errShape);
            for (ServiceEventListener l : LISTENERS) {
                l.onMediaError(payload);
            }
            emitCurrentState();
        }
    };

    private MediaItem toMediaItem(TrackSpec spec) {
        Uri uri;
        if ("file".equals(spec.sourceKind)) {
            if (spec.uriOrPath.startsWith("content://") || spec.uriOrPath.startsWith("file://")) {
                uri = Uri.parse(spec.uriOrPath);
            } else {
                uri = Uri.fromFile(new File(spec.uriOrPath));
            }
        } else {
            uri = Uri.parse(spec.uriOrPath);
            if (!spec.headers.isEmpty()) {
                headersByUri.put(uri.toString(), spec.headers);
            }
        }

        MediaMetadata.Builder meta = new MediaMetadata.Builder().setTitle(spec.title);
        if (spec.durationMs > 0L) {
            // Lets System UI show the lock-screen seekbar range before ExoPlayer is prepared.
            meta.setDurationMs(spec.durationMs);
        }
        if (spec.artist != null && !spec.artist.isEmpty()) {
            meta.setArtist(spec.artist);
        }
        if (spec.album != null && !spec.album.isEmpty()) {
            meta.setAlbumTitle(spec.album);
        }
        if (spec.artworkUrl != null && !spec.artworkUrl.isEmpty() && !spec.artworkUrl.startsWith("data:")) {
            try {
                meta.setArtworkUri(Uri.parse(spec.artworkUrl));
            } catch (Exception ignored) {
                // ignore malformed artwork URL
            }
        }

        MediaItem.Builder builder = new MediaItem.Builder()
            .setMediaId(spec.episodeKey)
            .setUri(uri)
            .setMediaMetadata(meta.build());

        if (spec.mime != null && !spec.mime.isEmpty()) {
            builder.setMimeType(spec.mime);
        }
        return builder.build();
    }

    private long resolveCurrentDurationMs() {
        if (player != null) {
            long d = player.getDuration();
            if (d != C.TIME_UNSET && d > 0L) {
                lastKnownDurationMs = d;
                return d;
            }
        }
        if (activeEpisodeKey != null) {
            Long hinted = durationHintByEpisodeKey.get(activeEpisodeKey);
            if (hinted != null && hinted > 0L) {
                return hinted;
            }
        }
        return lastKnownDurationMs;
    }

    private long computeSleepRemainingMs() {
        if (player == null) return 0L;
        float speed = Math.max(0.5f, player.getPlaybackParameters().speed);
        switch (sleepMode) {
            case "minutes":
                return Math.max(0L, sleepDeadlineElapsedMs - SystemClock.elapsedRealtime());
            case "endOfEpisode": {
                long dur = resolveCurrentDurationMs();
                if (dur <= 0L) return Long.MAX_VALUE / 2;
                long mediaRem = Math.max(0L, dur - Math.max(0L, player.getCurrentPosition()));
                return (long) (mediaRem / speed);
            }
            case "endOfChapter": {
                long pos = Math.max(0L, player.getCurrentPosition());
                if (sleepChapterEndMs <= pos) return 0L;
                return (long) ((sleepChapterEndMs - pos) / speed);
            }
            default:
                return 0L;
        }
    }

    private void expireSleepTimer() {
        MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
        sleepMode = "off";
        if (player != null) {
            player.pause();
            player.setVolume(1.0f);
        }
        writeCurrentCheckpoint();
        acquireFlushWakeLock();
        emitSleepTimerState(0L);
        emitCurrentState();
    }

    private void scheduleTicks() {
        MAIN_HANDLER.removeCallbacks(tickRunnable);
        MAIN_HANDLER.postDelayed(tickRunnable, STATE_TICK_MS);
    }

    /**
     * Tracks when playback last ran and (re)arms the paused-notification grace expiry. Called from
     * `playerListener` (registered on ExoPlayer before the session's listener, so it runs before
     * Media3 refreshes the notification for the same change).
     */
    private void updateForegroundGrace() {
        if (player == null) return;
        boolean active =
            PlaybackForegroundPolicy.isActivelyPlaying(player.getPlayWhenReady(), player.getPlaybackState());
        long now = SystemClock.elapsedRealtime();
        if (active) {
            lastActivePlaybackElapsedMs = now;
            MAIN_HANDLER.removeCallbacks(pausedForegroundExpiryRunnable);
        } else if (wasActivelyPlaying) {
            lastActivePlaybackElapsedMs = now;
            MAIN_HANDLER.removeCallbacks(pausedForegroundExpiryRunnable);
            MAIN_HANDLER.postDelayed(pausedForegroundExpiryRunnable, PAUSED_FOREGROUND_GRACE_MS + 1_000L);
        }
        wasActivelyPlaying = active;
    }

    private void emitCurrentState() {
        if (player != null && player.getPlaybackState() == Player.STATE_ENDED) {
            lastKnownPositionMs = 0L;
        } else if (player != null && player.getMediaItemCount() > 0) {
            long pos = Math.max(0L, player.getCurrentPosition());
            if (pos > 0L || player.getPlaybackState() != Player.STATE_IDLE) {
                lastKnownPositionMs = pos;
            }
        }
        emitStateObject(buildStateObject());
    }

    private void emitStateObject(JSObject state) {
        for (ServiceEventListener l : LISTENERS) {
            l.onMediaState(state);
        }
    }

    private void emitSleepTimerState(long remainingMs) {
        JSObject payload = new JSObject();
        payload.put("mode", sleepMode);
        if ("minutes".equals(sleepMode)) {
            payload.put("minutes", sleepMinutes);
        } else if ("endOfChapter".equals(sleepMode)) {
            payload.put("chapterEndMs", sleepChapterEndMs);
        }
        if (!"off".equals(sleepMode) && remainingMs < Long.MAX_VALUE / 4) {
            payload.put("remainingMs", Math.max(0L, remainingMs));
        }
        for (ServiceEventListener l : LISTENERS) {
            l.onSleepTimerState(payload);
        }
    }

    private void writeCurrentCheckpoint() {
        if (activeEpisodeKey == null || player == null) return;
        long posMs;
        if (player.getPlaybackState() == Player.STATE_ENDED) {
            // A finished episode is journaled in `KEY_COMPLETED` (and `KEY_CURRENT` /
            // `KEY_LAST_TRACK` for it were removed): never (re)write a `positionMs: 0` checkpoint
            // for it from `onTaskRemoved` / `onDestroy` / pause paths.
            lastKnownPositionMs = 0L;
            return;
        } else if (player.getMediaItemCount() > 0) {
            posMs = Math.max(0L, player.getCurrentPosition());
            if (posMs == 0L && player.getPlaybackState() == Player.STATE_IDLE && lastKnownPositionMs > 0L) {
                posMs = lastKnownPositionMs;
            }
        } else {
            posMs = lastKnownPositionMs;
        }
        lastKnownPositionMs = posMs;
        long durMs = resolveCurrentDurationMs();
        long wallMs = System.currentTimeMillis();
        lastJournalWriteElapsedMs = SystemClock.elapsedRealtime();

        synchronized (JOURNAL_LOCK) {
            try {
                JSONObject cur = new JSONObject();
                cur.put("episodeKey", activeEpisodeKey);
                cur.put("positionMs", posMs);
                if (durMs > 0L) {
                    cur.put("durationMs", durMs);
                }
                cur.put("wallMs", wallMs);
                if (positionFromSeek) {
                    // Deliberate seek (e.g. lock-screen -10 s to 0:00): lets the WebView journal
                    // reconciliation accept `positionMs: 0` instead of ignoring it as an idle reset.
                    cur.put("seeked", true);
                }

                SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                SharedPreferences.Editor editor = prefs.edit().putString(KEY_CURRENT, cur.toString());
                if (activeTrackSpec != null
                    && activeEpisodeKey.equals(activeTrackSpec.episodeKey)) {
                    float speed = player.getPlaybackParameters().speed;
                    editor.putString(
                        KEY_LAST_TRACK,
                        trackSpecToJson(activeTrackSpec, posMs, durMs, speed).toString()
                    );
                }
                editor.apply();
            } catch (JSONException ignored) {
                // ignore
            }
        }
    }

    private void appendCompletedJournal(String episodeKey, long durationMs) {
        long nowWallMs = System.currentTimeMillis();
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray completedArr = new JSONArray();
            String existing = prefs.getString(KEY_COMPLETED, null);
            if (existing != null && !existing.isEmpty()) {
                try {
                    completedArr = new JSONArray(existing);
                } catch (JSONException ignored) {
                    completedArr = new JSONArray();
                }
            }

            try {
                JSONObject entry = new JSONObject();
                entry.put("episodeKey", episodeKey);
                if (durationMs > 0L) {
                    entry.put("durationMs", durationMs);
                }
                entry.put("endedWallMs", nowWallMs);
                completedArr.put(entry);

                SharedPreferences.Editor editor = prefs.edit();
                editor.putString(KEY_COMPLETED, completedArr.toString());

                // Remove `current` if it still points to the finished episode
                String curStr = prefs.getString(KEY_CURRENT, null);
                if (curStr != null) {
                    JSONObject cur = new JSONObject(curStr);
                    if (episodeKey.equals(cur.optString("episodeKey"))) {
                        editor.remove(KEY_CURRENT);
                    }
                }
                JSONObject last = parseJson(prefs.getString(KEY_LAST_TRACK, null));
                if (last != null && episodeKey.equals(last.optString("episodeKey"))) {
                    editor.remove(KEY_LAST_TRACK);
                }
                editor.apply();
            } catch (JSONException ignored) {
                // ignore
            }
        }
    }

    /** Updates `activeTrackSpec` when ExoPlayer advances to a queued item (keeps restore data accurate). */
    private void adoptQueuedSpec(String episodeKey) {
        if (activeTrackSpec != null && activeTrackSpec.episodeKey.equals(episodeKey)) return;
        if (primaryTrackSpec != null && primaryTrackSpec.episodeKey.equals(episodeKey)) {
            activeTrackSpec = primaryTrackSpec;
            applyWakeModeFor(primaryTrackSpec);
            return;
        }
        for (TrackSpec spec : queuedSpecs) {
            if (spec.episodeKey.equals(episodeKey)) {
                activeTrackSpec = spec;
                applyWakeModeFor(spec);
                return;
            }
        }
    }

    private void applyWakeModeFor(TrackSpec spec) {
        if (player == null) return;
        try {
            player.setWakeMode("file".equals(spec.sourceKind) ? C.WAKE_MODE_LOCAL : C.WAKE_MODE_NETWORK);
        } catch (Exception ignored) {
            // ignore
        }
    }

    private boolean isNetworkConnected() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network network = cm.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception ignored) {
            return true;
        }
    }

    /**
     * Re-loads the last active track into an empty player (fresh service after Android stopped it
     * while paused in the background, or after `STATE_IDLE` lost the media item) at the last
     * checkpointed position. Returns true if a track was restored.
     */
    private boolean restoreLastTrackIfNeeded(boolean prepareNow) {
        if (player == null) return false;
        if (player.getMediaItemCount() > 0 && activeEpisodeKey != null) return false;

        PlaybackResumption.Plan plan = resolveResumptionPlan();
        if (plan == null) return false;
        List<MediaItem> items = applyResumptionPlan(plan);

        if (player.getMediaItemCount() == 0) {
            // Active episode + remaining queue (marathon auto-advance keeps working headless).
            player.setMediaItems(items, 0, plan.positionMs);
            if (prepareNow) {
                player.prepare();
            }
        }
        return true;
    }

    /**
     * `MediaSession.Callback.onPlaybackResumption` payload: restores the service state (active
     * episode, checkpoint, speed, wake mode, auth headers, duration hints, queue) and returns the
     * items for Media3 to set, prepare and play. `null` when there is nothing to resume.
     */
    @Nullable
    private MediaSession.MediaItemsWithStartPosition preparePlaybackResumption() {
        if (player == null) return null;
        PlaybackResumption.Plan plan = resolveResumptionPlan();
        if (plan == null) return null;
        List<MediaItem> items = applyResumptionPlan(plan);
        return new MediaSession.MediaItemsWithStartPosition(items, 0, plan.positionMs);
    }

    /**
     * In-memory episode (the player lost its items) or, for a fresh service / after process
     * death, `lastTrack` + `current` checkpoint + `lastQueue` from `minipod_playback.xml`.
     */
    @Nullable
    private PlaybackResumption.Plan resolveResumptionPlan() {
        boolean online = isNetworkConnected();
        TrackSpec spec = activeTrackSpec;
        if (spec != null) {
            List<TrackSpec> upcoming = PlaybackResumption.upcomingAfter(
                new ArrayList<>(queuedSpecs), spec.episodeKey, Collections.emptySet(), online);
            Long hinted = durationHintByEpisodeKey.get(spec.episodeKey);
            long durMs = hinted != null && hinted > 0L ? hinted : spec.durationMs;
            float speed = player != null ? player.getPlaybackParameters().speed : spec.speed;
            return new PlaybackResumption.Plan(
                spec, lastKnownPositionMs, durMs, PlaybackResumption.clampSpeed(speed), upcoming);
        }
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return PlaybackResumption.resolve(
                prefs.getString(KEY_LAST_TRACK, null),
                prefs.getString(KEY_CURRENT, null),
                prefs.getString(KEY_LAST_QUEUE, null),
                prefs.getString(KEY_COMPLETED, null),
                online
            );
        }
    }

    /** Applies a resume plan to the service state and returns its playlist (item 0 = active). */
    private List<MediaItem> applyResumptionPlan(PlaybackResumption.Plan plan) {
        TrackSpec spec = plan.spec;
        activeTrackSpec = spec;
        primaryTrackSpec = spec;
        activeEpisodeKey = spec.episodeKey;
        positionFromSeek = false;
        lastKnownDurationMs = plan.durationMs;
        if (plan.durationMs > 0L) {
            durationHintByEpisodeKey.put(spec.episodeKey, plan.durationMs);
        }
        lastKnownPositionMs = plan.positionMs;

        queuedSpecs.clear();
        queuedSpecs.addAll(plan.upcoming);
        startMsByEpisodeKey.clear();
        List<MediaItem> items = new ArrayList<>(1 + plan.upcoming.size());
        items.add(toMediaItem(spec)); // also registers auth headers for the active URL
        for (TrackSpec next : plan.upcoming) {
            startMsByEpisodeKey.put(next.episodeKey, next.startMs);
            if (next.durationMs > 0L) {
                durationHintByEpisodeKey.put(next.episodeKey, next.durationMs);
            }
            items.add(toMediaItem(next));
        }

        if (player != null) {
            applyWakeModeFor(spec);
            player.setPlaybackParameters(new PlaybackParameters(PlaybackResumption.clampSpeed(plan.speed)));
        }
        return items;
    }

    private void persistQueue(List<TrackSpec> items) {
        persistQueue(getApplicationContext(), items);
    }

    /**
     * Persists the upcoming native queue (`lastQueue`). Also called by `MiniPodPlugin.mediaSetQueue`
     * while the service is not running, so a later headless resume never uses a stale queue.
     */
    public static void persistQueue(Context context, List<TrackSpec> items) {
        synchronized (JOURNAL_LOCK) {
            try {
                SharedPreferences.Editor editor = context.getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit();
                if (items.isEmpty()) {
                    editor.remove(KEY_LAST_QUEUE);
                } else {
                    editor.putString(KEY_LAST_QUEUE, PlaybackResumption.queueToJson(items));
                }
                editor.apply();
            } catch (JSONException ignored) {
                // ignore
            }
        }
    }

    /**
     * `mediaStop` while the service is not running: forget the resumable episode + queue (the
     * user stopped playback), exactly like `stopPlayback()` does, so a later headset / Bluetooth
     * Play press does not resurrect it. The `current` checkpoint is kept for journal reconcile.
     */
    public static void clearResumeState(Context context) {
        synchronized (JOURNAL_LOCK) {
            context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_LAST_TRACK)
                .remove(KEY_LAST_QUEUE)
                .apply();
        }
    }

    private void clearPersistedQueue() {
        synchronized (JOURNAL_LOCK) {
            getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_LAST_QUEUE)
                .apply();
        }
    }

    private void persistLastTrack(long positionMs) {
        if (activeTrackSpec == null || player == null) return;
        synchronized (JOURNAL_LOCK) {
            try {
                JSONObject json = trackSpecToJson(
                    activeTrackSpec,
                    positionMs,
                    resolveCurrentDurationMs(),
                    player.getPlaybackParameters().speed
                );
                getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_LAST_TRACK, json.toString())
                    .apply();
            } catch (JSONException ignored) {
                // ignore
            }
        }
    }

    private void clearLastTrack(@Nullable String onlyIfEpisodeKey) {
        synchronized (JOURNAL_LOCK) {
            SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            if (onlyIfEpisodeKey != null) {
                JSONObject last = parseJson(prefs.getString(KEY_LAST_TRACK, null));
                if (last == null || !onlyIfEpisodeKey.equals(last.optString("episodeKey"))) return;
            }
            prefs.edit().remove(KEY_LAST_TRACK).apply();
        }
    }

    private static JSONObject trackSpecToJson(TrackSpec spec, long positionMs, long durationMs, float speed)
        throws JSONException {
        return PlaybackResumption.trackSpecToJson(spec, positionMs, durationMs, speed, System.currentTimeMillis());
    }

    @Nullable
    private static TrackSpec parseTrackSpecJson(@Nullable String json) {
        return PlaybackResumption.parseTrackSpecJson(json);
    }

    @Nullable
    private static JSONObject parseJson(@Nullable String json) {
        return PlaybackResumption.parseJson(json);
    }

    private void acquireFlushWakeLock() {
        if (flushWakeLock == null) return;
        MAIN_HANDLER.removeCallbacks(releaseWakeLockRunnable);
        try {
            flushWakeLock.acquire(FLUSH_WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception ignored) {
            // ignore wake-lock security errors
        }
        MAIN_HANDLER.postDelayed(releaseWakeLockRunnable, FLUSH_WAKE_LOCK_TIMEOUT_MS);
    }

    private void releaseFlushWakeLockInternal() {
        MAIN_HANDLER.removeCallbacks(releaseWakeLockRunnable);
        if (flushWakeLock != null && flushWakeLock.isHeld()) {
            try {
                flushWakeLock.release();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }
}
