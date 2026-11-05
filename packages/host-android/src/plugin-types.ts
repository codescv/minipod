/**
 * TypeScript contract for `MiniPodPlugin.java` (`@CapacitorPlugin(name = "MiniPod")`,
 * `ARCHITECTURE.md §3.2`, `§3.3`).
 *
 * Capacitor dispatches flat `@PluginMethod` names on the Java side (`safPick`,
 * `mediaLoad`, `authGoogleSignIn`, …). `createDefaultMiniPodPlugin()` wraps the
 * flat Capacitor bridge into the structured `saf.*` / `media.*` / `auth.*` surface
 * used across `@minipod/host-android` and mocked directly in unit tests.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  EpisodeKey,
  EpochMs,
  HttpBasicCredentials,
  HttpMethod,
  MediaMetadataLite,
  MediaSource,
  MiniPodErrorShape,
  RedirectHop,
  SleepTimer,
} from '@minipod/core';

export interface MiniPodPluginHttpRequest {
  readonly url: string;
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyBase64?: string;
  readonly range?: { readonly start: number; readonly end?: number };
  readonly auth?: HttpBasicCredentials;
  readonly maxRedirects?: number;
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
}

export interface MiniPodPluginHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly finalUrl: string;
  readonly chain: readonly RedirectHop[];
  readonly bodyBase64?: string;
  readonly bodyText?: string;
}

export interface MiniPodHttpToFileRequest {
  readonly episodeKey: EpisodeKey;
  readonly url: string;
  readonly destPath: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: HttpBasicCredentials;
  readonly resumeFrom?: number;
}

export interface MiniPodHttpToFileResponse {
  readonly path: string;
  readonly size: number;
  readonly mime?: string;
}

/** v0.1.23 Agent Feedback `ACTION_SEND` payload (`MiniPodPlugin.sendFeedbackEmail`). */
export interface NativeFeedbackEmailOptions {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachmentBase64?: string;
  readonly attachmentName?: string;
  readonly attachmentMimeType?: string;
}

export interface SafPickOptions {
  readonly mode: 'open' | 'create' | 'tree';
  readonly mime?: string;
  readonly suggestedName?: string;
  readonly initialUri?: string;
  readonly preferGoogleDrive?: boolean;
}

export interface SafPickResult {
  readonly uri: string;
  readonly displayName: string;
}

export interface SafStatResult {
  readonly exists: boolean;
  readonly size?: number;
  readonly mtimeMs?: EpochMs;
  readonly displayName?: string;
}

export interface SafTreeEntry {
  readonly uri: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly mtimeMs: EpochMs;
  readonly isDirectory: boolean;
}

export interface NativeMediaLoadPayload {
  readonly episodeKey: EpisodeKey;
  readonly source: MediaSource;
  readonly startMs: number;
  readonly speed: number;
  readonly metadata: MediaMetadataLite;
  readonly playWhenReady?: boolean;
}

export interface NativeMediaQueuePayloadItem {
  readonly episodeKey: EpisodeKey;
  readonly source: MediaSource;
  readonly startMs: number;
  readonly metadata: MediaMetadataLite;
}

export interface NativeMediaStatePayload {
  readonly episodeKey?: EpisodeKey;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly speed: number;
  /**
   * Set by `PlaybackService.onPositionDiscontinuity` (DISCONTINUITY_REASON_SEEK /
   * SEEK_ADJUSTMENT): the position changed because of a seek, e.g. the lock-screen Rewind -10 s /
   * Fast-forward +30 s buttons, the System UI seekbar or Bluetooth keys.
   */
  readonly seeked?: boolean;
}

export interface NativeMediaEndedPayload {
  readonly episodeKey: EpisodeKey;
  readonly autoAdvancedTo?: EpisodeKey;
}

export interface NativeMediaErrorPayload {
  readonly episodeKey?: EpisodeKey;
  readonly error: MiniPodErrorShape;
}

export interface NativeSleepTimerPayload {
  readonly mode: 'off' | 'minutes' | 'endOfEpisode' | 'endOfChapter';
  readonly remainingMs?: number;
  readonly minutes?: number;
  readonly chapterEndMs?: number;
}

export interface NativeJournalCheckpoint {
  readonly episodeKey: EpisodeKey;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly wallMs: EpochMs;
  /**
   * The checkpointed position is the result of an explicit seek with no playback since (e.g. a
   * paused lock-screen Rewind -10 s to 0:00). Only then may reconciliation adopt `positionMs: 0`.
   */
  readonly seeked?: boolean;
}

export interface NativeJournalCompletedEntry {
  readonly episodeKey: EpisodeKey;
  readonly durationMs?: number;
  readonly endedWallMs: EpochMs;
}

export interface NativeJournalSnapshot {
  readonly current?: NativeJournalCheckpoint | null;
  readonly completed: readonly NativeJournalCompletedEntry[];
}

export interface DownloadProgressPayload {
  readonly episodeKey: EpisodeKey;
  readonly bytesDownloaded: number;
  readonly totalBytes?: number;
}

export interface DeepLinkPayload {
  readonly action: 'view' | 'send';
  readonly uri?: string;
  readonly mimeType?: string;
  readonly text?: string;
}

export interface GoogleSignInOptions {
  readonly scopes: readonly string[];
  readonly accountHint?: string;
  readonly forceRefresh?: boolean;
  readonly interactive?: boolean;
  readonly safMode?: 'create' | 'open';
}

export interface GoogleSignInResult {
  readonly supported: boolean;
  readonly accessToken?: string;
  readonly expiresAt?: EpochMs;
  readonly accountEmail?: string;
  readonly safUri?: string;
  readonly displayName?: string;
}

export interface ApkDownloadProgressPayload {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export interface ApkInstallResult {
  readonly filePath: string;
  readonly sizeBytes?: number;
  readonly installerLaunched: boolean;
  readonly installed?: boolean;
  readonly needsPermission?: boolean;
}

export interface MiniPodEventMap {
  readonly 'media-state': NativeMediaStatePayload;
  readonly 'media-ended': NativeMediaEndedPayload;
  readonly 'media-error': NativeMediaErrorPayload;
  readonly 'sleep-timer-state': NativeSleepTimerPayload;
  readonly 'download-progress': DownloadProgressPayload;
  readonly 'deep-link': DeepLinkPayload;
  readonly apkDownloadProgress: ApkDownloadProgressPayload;
}

/**
 * Structured plugin API consumed by TypeScript modules in `@minipod/host-android`.
 */
export interface MiniPodPlugin {
  http(req: MiniPodPluginHttpRequest): Promise<MiniPodPluginHttpResponse>;
  httpToFile(req: MiniPodHttpToFileRequest): Promise<MiniPodHttpToFileResponse>;
  cancelDownload(opts: { readonly episodeKey: EpisodeKey }): Promise<void>;
  deleteLocalFile(opts: { readonly path: string }): Promise<void>;
  readLocalFileRange(opts: {
    readonly path: string;
    readonly start: number;
    readonly length: number;
  }): Promise<{ readonly base64: string }>;

  readonly saf: {
    pick(opts: SafPickOptions): Promise<SafPickResult | null>;
    stat(opts: { readonly uri: string }): Promise<SafStatResult>;
    read(opts: { readonly uri: string }): Promise<{ readonly base64: string }>;
    readRange(opts: {
      readonly uri: string;
      readonly start: number;
      readonly length: number;
    }): Promise<{ readonly base64: string }>;
    write(opts: { readonly uri: string; readonly base64: string }): Promise<void>;
    listTree(opts: { readonly treeUri: string }): Promise<{ readonly entries: readonly SafTreeEntry[] }>;
  };

  readonly media: {
    load(payload: NativeMediaLoadPayload): Promise<NativeMediaStatePayload>;
    setQueue(opts: { readonly items: readonly NativeMediaQueuePayloadItem[] }): Promise<void>;
    /** Resolves with the native state after `play()` (older natives resolve `void`). */
    play(): Promise<NativeMediaStatePayload | void>;
    pause(): Promise<void>;
    seekTo(opts: { readonly positionMs: number }): Promise<void>;
    setSpeed(opts: { readonly speed: number }): Promise<void>;
    setSleepTimer(timer: SleepTimer): Promise<void>;
    stop(): Promise<void>;
    getState(): Promise<NativeMediaStatePayload>;
    readJournal(): Promise<NativeJournalSnapshot>;
    clearJournal(opts: { readonly upToWallMs: EpochMs }): Promise<void>;
    ackFlush(): Promise<void>;
  };

  readonly auth: {
    isGoogleSignInAvailable(): Promise<{ readonly available: boolean }>;
    googleSignIn(opts: GoogleSignInOptions): Promise<GoogleSignInResult>;
  };

  openExternal(opts: { readonly url: string }): Promise<void>;
  /** v0.1.23: `ACTION_SEND` Agent Feedback email with optional FileProvider image attachment. */
  sendFeedbackEmail?(opts: NativeFeedbackEmailOptions): Promise<void>;
  getLaunchIntent(): Promise<DeepLinkPayload | null>;

  downloadAndInstallApk?(opts: {
    readonly url: string;
    readonly version: string;
  }): Promise<ApkInstallResult>;
  installApkFile?(opts: { readonly filePath: string }): Promise<ApkInstallResult>;

  addListener<K extends keyof MiniPodEventMap>(
    eventName: K,
    listener: (payload: MiniPodEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Flat Capacitor native bridge matching `@PluginMethod` methods in `MiniPodPlugin.java`.
 */
export interface MiniPodNativeBridge {
  http(req: MiniPodPluginHttpRequest): Promise<MiniPodPluginHttpResponse>;
  httpToFile(req: MiniPodHttpToFileRequest): Promise<MiniPodHttpToFileResponse>;
  cancelDownload(opts: { episodeKey: EpisodeKey }): Promise<void>;
  deleteLocalFile(opts: { path: string }): Promise<void>;
  readLocalFileRange(opts: { path: string; start: number; length: number }): Promise<{ base64: string }>;

  safPick(opts: SafPickOptions): Promise<{ cancelled?: boolean; uri?: string; displayName?: string }>;
  safStat(opts: { uri: string }): Promise<SafStatResult>;
  safRead(opts: { uri: string }): Promise<{ base64: string }>;
  safReadRange(opts: { uri: string; start: number; length: number }): Promise<{ base64: string }>;
  safWrite(opts: { uri: string; base64: string }): Promise<void>;
  safListTree(opts: { treeUri: string }): Promise<{ entries: SafTreeEntry[] }>;

  mediaLoad(payload: NativeMediaLoadPayload): Promise<NativeMediaStatePayload>;
  mediaSetQueue(opts: { items: readonly NativeMediaQueuePayloadItem[] }): Promise<void>;
  mediaPlay(): Promise<NativeMediaStatePayload | void>;
  mediaPause(): Promise<void>;
  mediaSeekTo(opts: { positionMs: number }): Promise<void>;
  mediaSetSpeed(opts: { speed: number }): Promise<void>;
  mediaSetSleepTimer(opts: {
    mode: SleepTimer['mode'];
    minutes?: number;
    chapterEndMs?: number;
  }): Promise<void>;
  mediaStop(): Promise<void>;
  mediaGetState(): Promise<NativeMediaStatePayload>;
  mediaReadJournal(): Promise<NativeJournalSnapshot>;
  mediaClearJournal(opts: { upToWallMs: EpochMs }): Promise<void>;
  mediaAckFlush(): Promise<void>;

  authStatus(): Promise<{ available: boolean }>;
  authGoogleSignIn(opts: GoogleSignInOptions): Promise<GoogleSignInResult>;

  openExternal(opts: { url: string }): Promise<void>;
  sendFeedbackEmail(opts: NativeFeedbackEmailOptions): Promise<void>;
  getLaunchIntent(): Promise<{ hasIntent: boolean; action?: 'view' | 'send'; uri?: string; mimeType?: string; text?: string }>;
  downloadAndInstallApk(opts: { url: string; version: string }): Promise<ApkInstallResult>;
  installApkFile(opts: { filePath: string }): Promise<ApkInstallResult>;

  addListener<K extends keyof MiniPodEventMap>(
    eventName: K,
    listenerFunc: (payload: MiniPodEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
}

const RawMiniPodBridge = registerPlugin<MiniPodNativeBridge>('MiniPod');

export function wrapNativeBridge(bridge: MiniPodNativeBridge): MiniPodPlugin {
  return {
    http: (req) => bridge.http(req),
    httpToFile: (req) => bridge.httpToFile(req),
    cancelDownload: (opts) => bridge.cancelDownload(opts),
    deleteLocalFile: (opts) => bridge.deleteLocalFile(opts),
    readLocalFileRange: (opts) => bridge.readLocalFileRange(opts),

    saf: {
      async pick(opts) {
        const res = await bridge.safPick(opts);
        if (res.cancelled || !res.uri) return null;
        return {
          uri: res.uri,
          displayName: res.displayName ?? res.uri,
        };
      },
      stat: (opts) => bridge.safStat(opts),
      read: (opts) => bridge.safRead(opts),
      readRange: (opts) => bridge.safReadRange(opts),
      write: (opts) => bridge.safWrite(opts),
      listTree: (opts) => bridge.safListTree(opts),
    },

    media: {
      load: (payload) => bridge.mediaLoad(payload),
      setQueue: (opts) => bridge.mediaSetQueue(opts),
      play: () => bridge.mediaPlay(),
      pause: () => bridge.mediaPause(),
      seekTo: (opts) => bridge.mediaSeekTo(opts),
      setSpeed: (opts) => bridge.mediaSetSpeed(opts),
      setSleepTimer(timer) {
        switch (timer.mode) {
          case 'off':
          case 'endOfEpisode':
            return bridge.mediaSetSleepTimer({ mode: timer.mode });
          case 'minutes':
            return bridge.mediaSetSleepTimer({ mode: 'minutes', minutes: timer.minutes });
          case 'endOfChapter':
            return bridge.mediaSetSleepTimer({ mode: 'endOfChapter', chapterEndMs: timer.chapterEndMs });
        }
      },
      stop: () => bridge.mediaStop(),
      getState: () => bridge.mediaGetState(),
      readJournal: () => bridge.mediaReadJournal(),
      clearJournal: (opts) => bridge.mediaClearJournal(opts),
      ackFlush: () => bridge.mediaAckFlush(),
    },

    auth: {
      isGoogleSignInAvailable: () => bridge.authStatus(),
      googleSignIn: (opts) => bridge.authGoogleSignIn(opts),
    },

    openExternal: (opts) => bridge.openExternal(opts),
    sendFeedbackEmail: (opts) => bridge.sendFeedbackEmail(opts),
    downloadAndInstallApk: (opts) => bridge.downloadAndInstallApk(opts),
    installApkFile: (opts) => bridge.installApkFile(opts),
    async getLaunchIntent() {
      const res = await bridge.getLaunchIntent();
      if (!res.hasIntent || !res.action) return null;
      return {
        action: res.action,
        ...(res.uri !== undefined ? { uri: res.uri } : {}),
        ...(res.mimeType !== undefined ? { mimeType: res.mimeType } : {}),
        ...(res.text !== undefined ? { text: res.text } : {}),
      };
    },

    addListener: (eventName, listener) => bridge.addListener(eventName, listener),
  };
}

export function createDefaultMiniPodPlugin(): MiniPodPlugin {
  return wrapNativeBridge(RawMiniPodBridge);
}
