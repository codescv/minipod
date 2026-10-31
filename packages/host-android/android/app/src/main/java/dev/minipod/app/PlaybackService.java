package dev.minipod.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
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
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
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
    private long lastKnownDurationMs = 0L;
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

        AudioAttributes audioAttrs = new AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .setUsage(C.USAGE_MEDIA)
            .build();

        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(resolvingFactory))
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
                    getString(R.string.app_name),
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setShowBadge(false);
                channel.setDescription("Podcast background playback");
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildBootstrapForegroundNotification() {
        ensureNotificationChannel();
        CharSequence title = getString(R.string.app_name);
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
        lastKnownDurationMs = spec.durationMs > 0 ? spec.durationMs : 0L;
        if (spec.durationMs > 0) {
            durationHintByEpisodeKey.put(spec.episodeKey, spec.durationMs);
        }

        MediaItem item = toMediaItem(spec);
        float clampedSpeed = Math.max(0.5f, Math.min(3.0f, spec.speed));
        player.setPlaybackParameters(new PlaybackParameters(clampedSpeed));
        player.setVolume(1.0f);
        player.setMediaItem(item, spec.startMs);
        player.prepare();
        player.setPlayWhenReady(spec.playWhenReady);

        JSObject state = buildStateObject();
        emitStateObject(state);
        return state;
    }

    public void setQueueTracks(List<TrackSpec> items) {
        startMsByEpisodeKey.clear();
        List<MediaItem> nextItems = new ArrayList<>(items.size());
        for (TrackSpec spec : items) {
            if (spec.episodeKey.equals(activeEpisodeKey)) {
                continue;
            }
            startMsByEpisodeKey.put(spec.episodeKey, spec.startMs);
            if (spec.durationMs > 0) {
                durationHintByEpisodeKey.put(spec.episodeKey, spec.durationMs);
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
        if (player.getPlaybackState() == Player.STATE_IDLE && player.getMediaItemCount() > 0) {
            player.prepare();
        }
        if (player.getPlaybackState() == Player.STATE_ENDED) {
            player.seekTo(0L);
        }
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
        player.seekTo(clamped);
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
        lastKnownDurationMs = 0L;
        emitCurrentState();
    }

    public JSObject buildStateObject() {
        JSObject obj = new JSObject();
        if (activeEpisodeKey != null) {
            obj.put("episodeKey", activeEpisodeKey);
        }
        boolean playing = player != null && player.isPlaying();
        boolean buffering = player != null && player.getPlaybackState() == Player.STATE_BUFFERING;
        long posMs = player != null ? Math.max(0L, player.getCurrentPosition()) : 0L;
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
                lastKnownDurationMs = durationHintByEpisodeKey.getOrDefault(nextKey, 0L);
                emitCurrentState();
            }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            writeCurrentCheckpoint();
            acquireFlushWakeLock();

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
        long posMs = Math.max(0L, player.getCurrentPosition());
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
                prefs.edit().putString(KEY_CURRENT, cur.toString()).apply();
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
                editor.apply();
            } catch (JSONException ignored) {
                // ignore
            }
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
