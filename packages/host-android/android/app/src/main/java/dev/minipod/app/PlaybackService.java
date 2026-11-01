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
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
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
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.MediaStyleNotificationHelper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
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

    private static final long STATE_TICK_MS = 1_000L;
    private static final long JOURNAL_CHECKPOINT_MS = 5_000L;
    private static final long SLEEP_TICK_MS = 500L;
    private static final long SLEEP_FADE_WINDOW_MS = 60_000L;
    private static final long FLUSH_WAKE_LOCK_TIMEOUT_MS = 15_000L;
    private static final long SEEK_BACK_MS = 10_000L;
    private static final long SEEK_FORWARD_MS = 30_000L;

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
    private MediaSession mediaSession;
    private PowerManager.WakeLock flushWakeLock;
    private boolean foregroundStarted = false;

    @Nullable private String activeEpisodeKey;
    @Nullable private TrackSpec activeTrackSpec;
    /** Spec of playlist item 0 (set by `loadTrack` / restore); queued items follow it. */
    @Nullable private TrackSpec primaryTrackSpec;
    private final List<TrackSpec> queuedSpecs = new ArrayList<>();
    private long lastKnownDurationMs = 0L;
    private long lastKnownPositionMs = 0L;
    private long lastJournalWriteElapsedMs = 0L;

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
            if (cur != null
                && spec.episodeKey.equals(cur.optString("episodeKey"))
                && cur.optLong("wallMs", 0L) >= lastWallMs) {
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
        foregroundStarted = false;

        ensureNotificationChannel();

        DefaultMediaNotificationProvider notificationProvider =
            new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(NOTIFICATION_CHANNEL_ID)
                .setNotificationId(NOTIFICATION_ID)
                .build();
        setMediaNotificationProvider(notificationProvider);

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

        PendingIntent sessionActivityPendingIntent = createSessionActivityPendingIntent();
        mediaSession = new MediaSession.Builder(this, player)
            .setSessionActivity(sessionActivityPendingIntent)
            .build();
        addSession(mediaSession);

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

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (!foregroundStarted || player == null || !player.isPlaying()) {
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
                foregroundStarted = true;
            } catch (Exception ignored) {
                // Guard against background foreground-service restrictions if any
            }
        }
        super.onStartCommand(intent, flags, startId);
        return START_STICKY;
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        writeCurrentCheckpoint();
        if (player != null
            && player.getMediaItemCount() > 0
            && (player.isPlaying() || player.getPlayWhenReady())
            && player.getPlaybackState() != Player.STATE_ENDED
            && player.getPlaybackState() != Player.STATE_IDLE) {
            // Keep playing in the background when the user exits or swipes away the Activity.
            return;
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        MAIN_HANDLER.removeCallbacks(tickRunnable);
        MAIN_HANDLER.removeCallbacks(sleepTimerRunnable);
        writeCurrentCheckpoint();
        releaseFlushWakeLockInternal();
        foregroundStarted = false;

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
                    "Podcasts Playback",
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setShowBadge(false);
                channel.setDescription("Podcasts background playback");
                nm.createNotificationChannel(channel);
            }
        }
    }

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
        clearLastTrack(null);
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
        if (player != null && player.getMediaItemCount() > 0) {
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

    // -------------------------------------------------------------------------
    // Internal helpers & `Player.Listener`
    // -------------------------------------------------------------------------

    private final Player.Listener playerListener = new Player.Listener() {
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
        public void onPlaybackStateChanged(int playbackState) {
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

    private void emitCurrentState() {
        if (player != null && player.getMediaItemCount() > 0) {
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
        if (player.getMediaItemCount() > 0) {
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

                SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                SharedPreferences.Editor editor = prefs.edit().putString(KEY_CURRENT, cur.toString());
                if (activeTrackSpec != null
                    && activeEpisodeKey.equals(activeTrackSpec.episodeKey)
                    && player.getPlaybackState() != Player.STATE_ENDED) {
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

        TrackSpec spec = activeTrackSpec;
        long resumePosMs = lastKnownPositionMs;
        long savedDurMs = 0L;
        float savedSpeed = spec != null ? spec.speed : 1.0f;
        if (spec == null) {
            synchronized (JOURNAL_LOCK) {
                SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject lastJson = parseJson(prefs.getString(KEY_LAST_TRACK, null));
                spec = parseTrackSpecJson(lastJson != null ? lastJson.toString() : null);
                if (spec == null) return false;
                resumePosMs = spec.startMs;
                savedSpeed = spec.speed;
                if (lastJson != null) {
                    resumePosMs = Math.max(resumePosMs, lastJson.optLong("positionMs", 0L));
                }
                long lastWallMs = lastJson != null ? lastJson.optLong("wallMs", 0L) : 0L;
                JSONObject cur = parseJson(prefs.getString(KEY_CURRENT, null));
                if (cur != null
                    && spec.episodeKey.equals(cur.optString("episodeKey"))
                    && cur.optLong("wallMs", 0L) >= lastWallMs) {
                    long p = cur.optLong("positionMs", -1L);
                    if (p >= 0L) resumePosMs = p;
                    savedDurMs = cur.optLong("durationMs", 0L);
                }
            }
        }

        activeTrackSpec = spec;
        primaryTrackSpec = spec;
        activeEpisodeKey = spec.episodeKey;
        long durMs = savedDurMs > 0L ? savedDurMs : spec.durationMs;
        lastKnownDurationMs = Math.max(0L, durMs);
        if (durMs > 0L) {
            durationHintByEpisodeKey.put(spec.episodeKey, durMs);
        }
        resumePosMs = Math.max(0L, resumePosMs);
        lastKnownPositionMs = resumePosMs;

        if (player.getMediaItemCount() == 0) {
            applyWakeModeFor(spec);
            float clampedSpeed = Math.max(0.5f, Math.min(3.0f, savedSpeed));
            player.setPlaybackParameters(new PlaybackParameters(clampedSpeed));
            player.setMediaItem(toMediaItem(spec), resumePosMs);
            if (prepareNow) {
                player.prepare();
            }
        }
        return true;
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
        JSONObject o = new JSONObject();
        o.put("episodeKey", spec.episodeKey);
        o.put("sourceKind", spec.sourceKind);
        o.put("uriOrPath", spec.uriOrPath);
        if (spec.mime != null) o.put("mime", spec.mime);
        JSONObject headers = new JSONObject();
        for (Map.Entry<String, String> e : spec.headers.entrySet()) {
            headers.put(e.getKey(), e.getValue());
        }
        o.put("headers", headers);
        o.put("startMs", Math.max(0L, positionMs));
        o.put("positionMs", Math.max(0L, positionMs));
        o.put("speed", (double) speed);
        o.put("title", spec.title);
        if (spec.artist != null) o.put("artist", spec.artist);
        if (spec.album != null) o.put("album", spec.album);
        if (spec.artworkUrl != null) o.put("artworkUrl", spec.artworkUrl);
        o.put("durationMs", durationMs > 0L ? durationMs : spec.durationMs);
        o.put("wallMs", System.currentTimeMillis());
        return o;
    }

    @Nullable
    private static TrackSpec parseTrackSpecJson(@Nullable String json) {
        JSONObject o = parseJson(json);
        if (o == null) return null;
        String episodeKey = o.optString("episodeKey", "");
        String uriOrPath = o.optString("uriOrPath", "");
        if (episodeKey.isEmpty() || uriOrPath.isEmpty()) return null;
        Map<String, String> headers = new HashMap<>();
        JSONObject h = o.optJSONObject("headers");
        if (h != null) {
            JSONArray names = h.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String k = names.optString(i);
                    headers.put(k, h.optString(k));
                }
            }
        }
        long pos = Math.max(o.optLong("startMs", 0L), o.optLong("positionMs", 0L));
        return new TrackSpec(
            episodeKey,
            o.optString("sourceKind", "url"),
            uriOrPath,
            o.has("mime") && !o.isNull("mime") ? o.optString("mime") : null,
            headers,
            pos,
            (float) o.optDouble("speed", 1.0),
            o.optString("title", ""),
            o.has("artist") && !o.isNull("artist") ? o.optString("artist") : null,
            o.has("album") && !o.isNull("album") ? o.optString("album") : null,
            o.has("artworkUrl") && !o.isNull("artworkUrl") ? o.optString("artworkUrl") : null,
            o.optLong("durationMs", 0L),
            false
        );
    }

    @Nullable
    private static JSONObject parseJson(@Nullable String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            return new JSONObject(json);
        } catch (JSONException ignored) {
            return null;
        }
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
