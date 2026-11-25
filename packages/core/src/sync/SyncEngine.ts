import { MiniPodError } from '../errors';
import type {
  ApplyDecisions,
  CloudFileProvider,
  DeviceId,
  EpochMs,
  EpisodeKey,
  HlcMs,
  LocalSyncSnapshot,
  MiniPodErrorShape,
  SyncDevice,
  SyncDocument,
  SyncReason,
  SyncState,
  SyncStatus,
  SyncStore,
} from '../types';
import { SYNC_SCHEMA_ID, SYNC_SCHEMA_VERSION } from '../types';
import { gcSyncDocument } from './gc';
import type { HybridLogicalClock } from './hlc';
import { mergeSyncDocuments } from './merge';
import {
  computeEntityMapsHlcMax,
  entityMapsEqual,
  parseSyncDocument,
  serializeSyncDocument,
} from './schema';

const MAX_CONFLICT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const DEVICE_HEARTBEAT_MS = 24 * 60 * 60_000;

export interface SyncEngineDeps {
  readonly store: SyncStore;
  readonly provider: CloudFileProvider | null;
  readonly hlc: HybridLogicalClock;
  readonly backgroundSync: boolean;
  readonly now?: () => EpochMs;
  readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
  readonly onStatusChanged?: (status: SyncStatus) => void;
  readonly onDecisions?: (decisions: ApplyDecisions) => void | Promise<void>;
  /**
   * Optional hook invoked when the remote sync document fails schema/JSON parsing (§9.3)
   * so file-capable hosts can archive `minipod-sync-v1.json.corrupt-<ts>` without overwriting.
   */
  readonly onCorruptRemote?: (bytes: Uint8Array, error: MiniPodError) => void | Promise<void>;
}

export interface SyncRunResult {
  readonly status: SyncStatus;
  readonly pulled: boolean;
  readonly uploaded: boolean;
  readonly skipped: boolean;
}

function countDirty(snap: LocalSyncSnapshot): number {
  return (
    snap.dirty.subscriptions.size +
    snap.dirty.queue.size +
    snap.dirty.progress.size
  );
}

function hasDirtyBelowFloors(
  snap: LocalSyncSnapshot,
  floors: { readonly subscriptions: HlcMs; readonly queue: HlcMs; readonly progress: HlcMs },
): boolean {
  for (const key of snap.dirty.subscriptions) {
    const sub = snap.maps.subscriptions.items[key];
    if (sub && sub.updatedAt <= floors.subscriptions) return true;
  }
  for (const key of snap.dirty.queue) {
    const q = snap.maps.queue.items[key];
    if (q && q.updatedAt <= floors.queue) return true;
  }
  for (const key of snap.dirty.progress) {
    const p = snap.maps.progress.items[key];
    if (p && p.updatedAt <= floors.progress) return true;
  }
  return false;
}

function shouldNotifyDecisions(decisions: ApplyDecisions): boolean {
  return (
    decisions.resumeHints.length > 0 ||
    decisions.feedsToRefresh.length > 0 ||
    Boolean(
      decisions.changed?.subscriptions ||
        decisions.changed?.queue ||
        decisions.changed?.progress,
    )
  );
}

function buildLocalSyncDocument(
  snap: LocalSyncSnapshot,
  state: SyncState,
  hlcCurrent: HlcMs,
  lastSeenAt: EpochMs,
): SyncDocument {
  const deviceName = state.deviceName || snap.device.name;
  const deviceEntry: SyncDevice = {
    name: deviceName,
    app: snap.device.app,
    lastSeenAt,
  };
  // Preserve known remote devices so 304 + dirty uploads never wipe other devices' GC watermarks (SYNC-P0-04).
  const devices: Record<DeviceId, SyncDevice> = {
    ...(state.remoteDevices ?? {}),
    [state.deviceId]: deviceEntry,
  };
  const entityHlc = computeEntityMapsHlcMax(snap.maps);
  const hlcMax = Math.max(hlcCurrent, state.hlcLast, entityHlc);

  return {
    schema: SYNC_SCHEMA_ID,
    schemaVersion: SYNC_SCHEMA_VERSION,
    rev: state.remoteRev,
    writtenAt: state.lastPushAt ?? 0,
    writtenBy: state.deviceId,
    hlcMax,
    devices,
    subscriptions: snap.maps.subscriptions,
    queue: snap.maps.queue,
    progress: snap.maps.progress,
  };
}

function extractProviderFileId(provider: CloudFileProvider): string | null {
  const candidate = provider as unknown as {
    getFileId?: () => string | null;
    getGistId?: () => string | undefined;
  };
  if (typeof candidate.getFileId === 'function') {
    return candidate.getFileId();
  }
  if (typeof candidate.getGistId === 'function') {
    return candidate.getGistId() ?? null;
  }
  return null;
}

function computeDriveFingerprintPatch(
  provider: CloudFileProvider,
  providerFileId: string | null,
): Partial<SyncState> {
  if (
    providerFileId &&
    (provider.id === 'drive-appdata' || provider.id === 'drive-file')
  ) {
    return { lastRemoteFingerprint: `${provider.id}:${providerFileId}` };
  }
  return {};
}

/**
 * Builds a `Partial<SyncState>` that clears `lastError` and `backoffUntil` across both
 * object-spread (`'lastError' in patch`) and SQL column-patch `SyncStore` implementations
 * while respecting `exactOptionalPropertyTypes`.
 */
function clearErrorAndBackoffPatch(base: Partial<SyncState>): Partial<SyncState> {
  return Object.assign({}, base, {
    lastError: undefined,
    backoffUntil: 0,
  }) as unknown as Partial<SyncState>;
}

/**
 * State-based CRDT cloud sync engine (ARCHITECTURE.md §7.6, §9.1, §9.3).
 *
 * Serializes all runs through a single promise-chain mutex with `rerun` coalescing,
 * enforces entity-map-only upload comparison to prevent idle device ping-pong,
 * retries write preconditions up to 3 times before exponential backoff, and enters
 * `'needs-attention'` without overwriting on auth or schema errors.
 */
export class SyncEngine {
  private readonly store: SyncStore;
  private provider: CloudFileProvider | null;
  private readonly hlc: HybridLogicalClock;
  private readonly backgroundSync: boolean;
  private readonly now: () => EpochMs;
  private readonly getCurrentEpisodeKey?: () => EpisodeKey | undefined;
  private readonly onStatusChanged?: (status: SyncStatus) => void;
  private readonly onDecisions?: (decisions: ApplyDecisions) => void | Promise<void>;
  private readonly onCorruptRemote?: (bytes: Uint8Array, error: MiniPodError) => void | Promise<void>;

  private syncing = false;
  private providerEpoch = 0;
  private activeAbort: AbortController | null = null;
  private activeCycle: Promise<SyncRunResult> | null = null;
  private rerunRequested = false;
  private rerunBypassBackoff = false;
  private rerunReason: SyncReason = 'manual';
  private rerunSignal: AbortSignal | undefined;
  private rerunOnCycleStart: (() => void) | undefined;

  private consecutiveFailures = 0;
  private needsAttention = false;
  private errorClearedSinceLoad = false;

  constructor(deps: SyncEngineDeps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.hlc = deps.hlc;
    this.backgroundSync = deps.backgroundSync;
    this.now = deps.now ?? Date.now;
    if (deps.getCurrentEpisodeKey !== undefined) {
      this.getCurrentEpisodeKey = deps.getCurrentEpisodeKey;
    }
    if (deps.onStatusChanged !== undefined) {
      this.onStatusChanged = deps.onStatusChanged;
    }
    if (deps.onDecisions !== undefined) {
      this.onDecisions = deps.onDecisions;
    }
    if (deps.onCorruptRemote !== undefined) {
      this.onCorruptRemote = deps.onCorruptRemote;
    }
  }

  getProvider(): CloudFileProvider | null {
    return this.provider;
  }

  setProvider(provider: CloudFileProvider | null): void {
    this.providerEpoch += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.rerunRequested = false;
    this.rerunBypassBackoff = false;
    this.rerunSignal = undefined;
    this.rerunOnCycleStart = undefined;

    this.provider = provider;
    this.consecutiveFailures = 0;
    this.needsAttention = false;
    this.errorClearedSinceLoad = provider !== null;
  }

  /**
   * Waits for any in-flight sync cycle to finish unwinding (used by `configure`, `disconnect`,
   * and `dispose` so stale cycles never mutate freshly configured state or a closing DB).
   */
  async drainActiveCycle(): Promise<void> {
    while (this.activeCycle) {
      const current = this.activeCycle;
      try {
        await current;
      } catch {
        // Ignore errors from aborted/draining cycle
      }
      if (this.activeCycle === current) {
        break;
      }
    }
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  async getDirtyCount(): Promise<number> {
    if (this.store.getDirtyCount) {
      return this.store.getDirtyCount();
    }
    const snap = await this.store.loadLocalDoc();
    return countDirty(snap);
  }

  async getStatus(): Promise<SyncStatus> {
    const [state, dirtyCount] = await Promise.all([
      this.store.getSyncState(),
      this.getDirtyCount(),
    ]);
    return this.computeStatus(state, dirtyCount);
  }

  private computeStatus(state: SyncState, dirtyCount: number): SyncStatus {
    const provider = this.provider;
    if (!provider) {
      return {
        enabled: false,
        phase: 'off',
        dirtyCount,
        backgroundSync: this.backgroundSync,
      };
    }

    const nowMs = this.now();
    const effectiveError: MiniPodErrorShape | undefined = this.errorClearedSinceLoad
      ? undefined
      : state.lastError;
    const effectiveBackoff =
      !this.errorClearedSinceLoad &&
      state.backoffUntil !== undefined &&
      state.backoffUntil > nowMs
        ? state.backoffUntil
        : undefined;

    const isNonRetryableError =
      this.needsAttention ||
      (effectiveError !== undefined &&
        (effectiveError.code === 'sync-auth' || effectiveError.code === 'sync-schema'));

    let phase: SyncStatus['phase'];
    if (this.syncing) {
      phase = 'syncing';
    } else if (isNonRetryableError) {
      phase = 'needs-attention';
    } else if (effectiveBackoff !== undefined) {
      phase = 'backoff';
    } else {
      phase = 'idle';
    }

    const hasSynced =
      state.remoteRev > 0 || state.lastPullAt !== undefined || state.lastPushAt !== undefined;

    return {
      enabled: true,
      provider: provider.id,
      phase,
      dirtyCount,
      backgroundSync: this.backgroundSync,
      ...(state.lastPullAt !== undefined ? { lastPullAt: state.lastPullAt } : {}),
      ...(state.lastPushAt !== undefined ? { lastPushAt: state.lastPushAt } : {}),
      ...(hasSynced ? { remoteRev: state.remoteRev } : {}),
      ...(effectiveError !== undefined ? { lastError: effectiveError } : {}),
      ...(effectiveBackoff !== undefined ? { backoffUntil: effectiveBackoff } : {}),
    };
  }

  private emitStatus(status: SyncStatus): void {
    this.onStatusChanged?.(status);
  }

  /**
   * Executes a serialized sync cycle, coalescing concurrent callers via a `rerun` flag (§9.1).
   */
  async run(
    reason: SyncReason,
    options?: { readonly signal?: AbortSignal; readonly onCycleStart?: () => void },
  ): Promise<SyncRunResult> {
    const bypass = reason === 'manual' || reason === 'configured';
    if (this.activeCycle) {
      this.rerunRequested = true;
      this.rerunReason = reason;
      if (bypass) {
        this.rerunBypassBackoff = true;
      }
      this.rerunSignal = options?.signal;
      if (options?.onCycleStart) {
        this.rerunOnCycleStart = options.onCycleStart;
      }
      return this.activeCycle;
    }

    const cyclePromise = this.runLoop(reason, bypass, options);
    this.activeCycle = cyclePromise;
    return await cyclePromise;
  }

  private async runLoop(
    initialReason: SyncReason,
    initialBypass: boolean,
    options?: { readonly signal?: AbortSignal; readonly onCycleStart?: () => void },
  ): Promise<SyncRunResult> {
    let reason = initialReason;
    let bypass = initialBypass;
    let signal = options?.signal;
    let onCycleStart = options?.onCycleStart;
    let lastResult: SyncRunResult | undefined;

    try {
      // Loop while a mid-cycle caller set `rerunRequested`
      for (;;) {
        this.rerunRequested = false;
        this.rerunBypassBackoff = false;
        this.rerunSignal = undefined;
        this.rerunOnCycleStart = undefined;

        onCycleStart?.();
        lastResult = await this.executeSingleCycle(reason, bypass, signal);

        const nextSignal = this.rerunSignal as AbortSignal | undefined;
        if (!this.rerunRequested || nextSignal?.aborted) {
          // Clear `activeCycle` synchronously before resolving so callers queued in the
          // microtask gap start a fresh cycle rather than attaching to an already-ending one (SYNC-P2-02).
          this.activeCycle = null;
          return lastResult;
        }
        reason = this.rerunReason;
        bypass = this.rerunBypassBackoff;
        signal = nextSignal;
        onCycleStart = (this.rerunOnCycleStart as (() => void) | undefined) ?? options?.onCycleStart;
      }
    } finally {
      this.activeCycle = null;
    }
  }

  private async executeSingleCycle(
    reason: SyncReason,
    bypassBackoff: boolean,
    signal?: AbortSignal,
  ): Promise<SyncRunResult> {
    const epoch = this.providerEpoch;
    const isStale = (): boolean => epoch !== this.providerEpoch;

    const provider = this.provider;
    if (!provider) {
      const status = await this.getStatus();
      return { status, pulled: false, uploaded: false, skipped: true };
    }

    const cycleAbort = new AbortController();
    this.activeAbort = cycleAbort;
    const onExternalAbort = () => cycleAbort.abort();
    if (signal) {
      if (signal.aborted) {
        cycleAbort.abort();
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let pulled = false;
    let uploaded = false;

    const returnStale = async (): Promise<SyncRunResult> => {
      const status = await this.getStatus();
      return { status, pulled, uploaded, skipped: true };
    };

    try {
      const initialState = await this.store.getSyncState();
      if (isStale()) return await returnStale();

      // Restore persisted local HLC without +5m forward-skew clamping (SYNC-P2-01).
      if (initialState.hlcLast > this.hlc.current()) {
        this.hlc.restore(initialState.hlcLast);
      }

      const nowMs = this.now();
      const initialSnap = await this.store.loadLocalDoc();
      if (isStale()) return await returnStale();
      const initialDirty = countDirty(initialSnap);

      // Respect needs-attention and exponential backoff for automatic triggers (§9.3)
      if (!bypassBackoff) {
        const effectiveError = this.errorClearedSinceLoad ? undefined : initialState.lastError;
        const inNeedsAttention =
          this.needsAttention ||
          (effectiveError !== undefined &&
            (effectiveError.code === 'sync-auth' || effectiveError.code === 'sync-schema'));
        if (inNeedsAttention) {
          const status = this.computeStatus(initialState, initialDirty);
          return { status, pulled: false, uploaded: false, skipped: true };
        }

        if (
          !this.errorClearedSinceLoad &&
          initialState.backoffUntil !== undefined &&
          initialState.backoffUntil > nowMs
        ) {
          const status = this.computeStatus(initialState, initialDirty);
          return { status, pulled: false, uploaded: false, skipped: true };
        }

        // `'hidden'` trigger only pushes when dirty rows exist (§9.2)
        if (reason === 'hidden' && initialDirty === 0) {
          const status = this.computeStatus(initialState, initialDirty);
          return { status, pulled: false, uploaded: false, skipped: true };
        }
      }

      this.syncing = true;
      this.emitStatus(this.computeStatus(initialState, initialDirty));

      for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt++) {
        if (isStale()) return await returnStale();
        if (cycleAbort.signal.aborted) {
          throw new MiniPodError('cancelled', 'Sync cancelled');
        }

        const attemptNow = this.now();
        const state = attempt === 0 ? initialState : await this.store.getSyncState();
        if (isStale()) return await returnStale();
        let localSnap = attempt === 0 ? initialSnap : await this.store.loadLocalDoc();
        if (isStale()) return await returnStale();
        const dirtyTotal = countDirty(localSnap);

        // If dirty and we have not yet cached remote `devices` (or a lineage reset is pending),
        // force a full `blob` read instead of 304 so `devices` and `newLineage` are accurate (SYNC-P0-04, SYNC-P0-05).
        const hasCachedRemoteDevices =
          state.remoteDevices !== undefined && Object.keys(state.remoteDevices).length > 0;
        const mustReadBlob =
          (dirtyTotal > 0 && !hasCachedRemoteDevices) || state.pendingLineageReset === true;

        // On conflict retry (`attempt > 0`), pass `null` for `ifNoneMatch` so we always read fresh remote bytes
        const ifNoneMatch = attempt === 0 && !mustReadBlob ? state.remoteEtag : null;
        const readResult = await provider.read(ifNoneMatch, cycleAbort.signal);
        if (isStale()) return await returnStale();

        let remoteDoc: SyncDocument | null = null;
        let remoteMissing = false;
        let currentEtag: string | null = state.remoteEtag;
        let merged: SyncDocument;
        let shouldUpload = false;
        let clearPendingLineageReset = false;

        if (readResult.kind === 'not-modified') {
          pulled = true;
          if (dirtyTotal === 0) {
            // Read-only pull with unchanged remote and zero dirty rows -> no-op (§9.1)
            this.consecutiveFailures = 0;
            this.needsAttention = false;
            this.errorClearedSinceLoad = true;
            await this.store.setSyncState(
              clearErrorAndBackoffPatch({
                lastPullAt: attemptNow,
                hlcLast: this.hlc.current(),
              }),
            );
            if (isStale()) return await returnStale();
            this.syncing = false;
            const finalStatus = await this.getStatus();
            this.emitStatus(finalStatus);
            return { status: finalStatus, pulled: true, uploaded: false, skipped: false };
          }

          // Dirty rows exist and remote hasn't changed since last sync.
          // Still guard against dirty rows stamped <= known remote floors (e.g. clock lagging >5m, SYNC-P0-04).
          if (hasDirtyBelowFloors(localSnap, state.floors)) {
            const maxKnownFloor = Math.max(
              state.floors.subscriptions,
              state.floors.queue,
              state.floors.progress,
            );
            await this.store.restampDirtyBelowFloor(state.floors, () =>
              Math.max(this.hlc.now(), maxKnownFloor + 1),
            );
            if (isStale()) return await returnStale();
            localSnap = await this.store.loadLocalDoc();
            if (isStale()) return await returnStale();
          }

          merged = buildLocalSyncDocument(localSnap, state, this.hlc.current(), attemptNow);
          shouldUpload = true;
        } else if (readResult.kind === 'missing') {
          pulled = true;
          remoteMissing = true;
          currentEtag = null;
          clearPendingLineageReset = state.pendingLineageReset === true;
          merged = buildLocalSyncDocument(localSnap, state, this.hlc.current(), attemptNow);
          shouldUpload = true;
        } else {
          // `blob`
          try {
            remoteDoc = parseSyncDocument(readResult.bytes);
          } catch (parseErr) {
            const schemaErr = MiniPodError.wrap(parseErr, 'sync-schema');
            // Never overwrite a corrupt or newer-schema remote document (§9.3)
            if (!schemaErr.details?.['newerSchemaVersion'] && !isStale()) {
              await this.onCorruptRemote?.(readResult.bytes, schemaErr);
            }
            return await this.recordFailure(schemaErr, false, pulled, epoch);
          }

          pulled = true;
          currentEtag = readResult.etag;

          // Fast-forward local HLC (capped at +5m drift in `hlc.observe`)
          this.hlc.observe(remoteDoc.hlcMax);

          const remoteFloors = {
            subscriptions: remoteDoc.subscriptions.floor,
            queue: remoteDoc.queue.floor,
            progress: remoteDoc.progress.floor,
          };
          const remoteKeys = {
            subscriptions: new Set(Object.keys(remoteDoc.subscriptions.items)),
            queue: new Set(Object.keys(remoteDoc.queue.items)),
            progress: new Set(Object.keys(remoteDoc.progress.items)),
          };

          // Determine whether this device is joining a brand-new remote lineage (SYNC-P0-05).
          const providerFileId = extractProviderFileId(provider);
          const neverSyncedBefore =
            state.remoteRev === 0 &&
            state.lastPullAt === undefined &&
            state.lastPushAt === undefined;
          const remoteIdentityChanged =
            (providerFileId !== null &&
              state.remoteFileId !== null &&
              providerFileId !== state.remoteFileId) ||
            state.pendingLineageReset === true;
          const newLineage =
            !remoteDoc.devices[state.deviceId] && (neverSyncedBefore || remoteIdentityChanged);

          const maxRemoteFloor = Math.max(
            remoteFloors.subscriptions,
            remoteFloors.queue,
            remoteFloors.progress,
          );

          if (newLineage) {
            // Bypass `dirtyTotal > 0` gate: protect clean live local rows absent from the new remote
            // against being dropped by the new remote's higher floors.
            if (maxRemoteFloor > 0) {
              await this.store.restampDirtyBelowFloor(
                remoteFloors,
                () => Math.max(this.hlc.now(), maxRemoteFloor + 1),
                { excludeKeys: remoteKeys, includeCleanLive: true },
              );
              if (isStale()) return await returnStale();
              localSnap = await this.store.loadLocalDoc();
              if (isStale()) return await returnStale();
            }
          } else if (dirtyTotal > 0 && hasDirtyBelowFloors(localSnap, remoteFloors)) {
            // §7.6 Before merge: re-stamp dirty local rows absent from remote sitting at/below remote floors.
            await this.store.restampDirtyBelowFloor(
              remoteFloors,
              () => Math.max(this.hlc.now(), maxRemoteFloor + 1),
              { excludeKeys: remoteKeys },
            );
            if (isStale()) return await returnStale();
            localSnap = await this.store.loadLocalDoc();
            if (isStale()) return await returnStale();
          }

          clearPendingLineageReset = state.pendingLineageReset === true;

          // Refresh `lastSeenAt` and trigger heartbeat upload if unregistered or >= 24h stale (SYNC-P2-04).
          const prevRemoteDevice = remoteDoc.devices[state.deviceId];
          const deviceHeartbeatStale =
            !prevRemoteDevice || attemptNow - prevRemoteDevice.lastSeenAt >= DEVICE_HEARTBEAT_MS;
          const lastSeenAt = deviceHeartbeatStale ? attemptNow : prevRemoteDevice.lastSeenAt;

          const localDoc = buildLocalSyncDocument(
            localSnap,
            state,
            this.hlc.current(),
            lastSeenAt,
          );
          merged = mergeSyncDocuments(localDoc, remoteDoc);

          const decisions = await this.store.applyMerged(
            merged,
            this.getCurrentEpisodeKey?.(),
          );
          if (isStale()) return await returnStale();
          if (shouldNotifyDecisions(decisions)) {
            await this.onDecisions?.(decisions);
            if (isStale()) return await returnStale();
          }

          // If local writes raced with `provider.read()`, re-load & re-merge once so concurrent
          // local edits are included in this upload rather than dropped (SYNC-P0-01).
          if (decisions.hasConcurrentLocalEdits) {
            localSnap = await this.store.loadLocalDoc();
            if (isStale()) return await returnStale();
            const refreshedLocalDoc = buildLocalSyncDocument(
              localSnap,
              state,
              this.hlc.current(),
              lastSeenAt,
            );
            merged = mergeSyncDocuments(refreshedLocalDoc, remoteDoc);
            const decisions2 = await this.store.applyMerged(
              merged,
              this.getCurrentEpisodeKey?.(),
            );
            if (isStale()) return await returnStale();
            if (shouldNotifyDecisions(decisions2)) {
              await this.onDecisions?.(decisions2);
              if (isStale()) return await returnStale();
            }
            if (decisions2.hasConcurrentLocalEdits) {
              this.rerunRequested = true;
              this.rerunReason = 'manual';
            }
          }

          // Upload decision compares entity maps OR 24h read-only device heartbeat (§9.1 + SYNC-P2-04)
          shouldUpload = !entityMapsEqual(merged, remoteDoc) || deviceHeartbeatStale;
        }

        if (!shouldUpload && !remoteMissing && remoteDoc !== null) {
          // Local already equals remote entity maps -> clear dirty, store etag/rev/floors, skip upload
          await this.store.markClean(merged);
          if (isStale()) return await returnStale();
          const mergedFloors = {
            subscriptions: merged.subscriptions.floor,
            queue: merged.queue.floor,
            progress: merged.progress.floor,
          };
          await this.store.purgeBelowFloors(mergedFloors);
          if (isStale()) return await returnStale();

          this.consecutiveFailures = 0;
          this.needsAttention = false;
          this.errorClearedSinceLoad = true;

          const providerFileId = extractProviderFileId(provider);
          await this.store.setSyncState(
            clearErrorAndBackoffPatch({
              remoteEtag: currentEtag,
              remoteFileId: providerFileId ?? state.remoteFileId,
              remoteRev: Math.max(remoteDoc.rev, state.remoteRev),
              floors: mergedFloors,
              // Persist bounded local HLC only; never poison with unbounded remote `hlcMax` (SYNC-P2-01).
              hlcLast: this.hlc.current(),
              lastPullAt: attemptNow,
              remoteDevices: merged.devices,
              ...(clearPendingLineageReset ? { pendingLineageReset: false } : {}),
              ...computeDriveFingerprintPatch(provider, providerFileId),
            }),
          );
          if (isStale()) return await returnStale();

          this.syncing = false;
          const finalStatus = await this.getStatus();
          this.emitStatus(finalStatus);
          return { status: finalStatus, pulled, uploaded: false, skipped: false };
        }

        // Upload path: refresh writer `lastSeenAt`, run writer-side GC (§7.7), stamp envelope (§9.1)
        const writerDevice: SyncDevice = {
          name: state.deviceName || localSnap.device.name,
          app: localSnap.device.app,
          lastSeenAt: attemptNow,
        };
        const withFreshWriter: SyncDocument = {
          ...merged,
          devices: {
            ...merged.devices,
            [state.deviceId]: writerDevice,
          },
        };

        const gced = gcSyncDocument(withFreshWriter, {
          nowMs: attemptNow,
          writerDeviceId: state.deviceId,
        });

        const nextRev = Math.max(remoteDoc?.rev ?? 0, state.remoteRev) + 1;
        const nextHlcMax = Math.max(
          gced.hlcMax,
          computeEntityMapsHlcMax(gced),
          this.hlc.now(),
        );
        const docToUpload: SyncDocument = {
          ...gced,
          rev: nextRev,
          writtenAt: attemptNow,
          writtenBy: state.deviceId,
          hlcMax: nextHlcMax,
        };

        const payload = serializeSyncDocument(docToUpload);
        const writeRes = await provider.write(payload, currentEtag, cycleAbort.signal);
        if (isStale()) return await returnStale();

        if (writeRes.kind === 'ok') {
          uploaded = true;
          // Pass pre-GC `withFreshWriter` so expired dirty tombstones/PLAYED entries folded into
          // `newFloors` by GC are marked clean before `purgeBelowFloors` deletes them (SYNC-P1-04).
          await this.store.markClean(withFreshWriter);
          if (isStale()) return await returnStale();
          const newFloors = {
            subscriptions: docToUpload.subscriptions.floor,
            queue: docToUpload.queue.floor,
            progress: docToUpload.progress.floor,
          };
          await this.store.purgeBelowFloors(newFloors);
          if (isStale()) return await returnStale();

          this.consecutiveFailures = 0;
          this.needsAttention = false;
          this.errorClearedSinceLoad = true;

          const providerFileId = extractProviderFileId(provider);
          await this.store.setSyncState(
            clearErrorAndBackoffPatch({
              remoteEtag: writeRes.newEtag,
              remoteFileId: providerFileId ?? state.remoteFileId,
              remoteRev: nextRev,
              floors: newFloors,
              // Persist bounded local HLC only (SYNC-P2-01).
              hlcLast: this.hlc.current(),
              ...(pulled ? { lastPullAt: attemptNow } : {}),
              lastPushAt: attemptNow,
              remoteDevices: docToUpload.devices,
              ...(clearPendingLineageReset ? { pendingLineageReset: false } : {}),
              ...computeDriveFingerprintPatch(provider, providerFileId),
            }),
          );
          if (isStale()) return await returnStale();

          this.syncing = false;
          const finalStatus = await this.getStatus();
          this.emitStatus(finalStatus);
          return { status: finalStatus, pulled, uploaded: true, skipped: false };
        }

        if (writeRes.kind === 'conflict') {
          if (attempt + 1 < MAX_CONFLICT_ATTEMPTS) {
            continue;
          }
          // Exhausted all 3 conflict retries -> exponential backoff
          return await this.recordFailure(
            new MiniPodError(
              'sync-conflict',
              `Sync conflict persisted after ${MAX_CONFLICT_ATTEMPTS} attempts`,
            ),
            true,
            pulled,
            epoch,
          );
        }

        // `writeRes.kind === 'failed'` — preserve original MiniPodError code (SYNC-P1-14)
        const writeErr =
          writeRes.cause instanceof MiniPodError
            ? writeRes.cause
            : MiniPodError.wrap(writeRes.cause, writeRes.retryable ? 'network' : 'sync-auth');
        return await this.recordFailure(writeErr, writeRes.retryable, pulled, epoch);
      }

      // Unreachable fallback
      this.syncing = false;
      const status = await this.getStatus();
      return { status, pulled, uploaded, skipped: false };
    } catch (err) {
      if (isStale()) {
        return await returnStale();
      }
      const wrapped = MiniPodError.wrap(err, 'network');
      if (wrapped.code === 'cancelled') {
        this.syncing = false;
        const status = await this.getStatus();
        this.emitStatus(status);
        return { status, pulled, uploaded: false, skipped: true };
      }
      const retryable =
        wrapped.code !== 'sync-auth' &&
        wrapped.code !== 'sync-schema' &&
        wrapped.code !== 'invalid-argument';
      return await this.recordFailure(wrapped, retryable, pulled, epoch);
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
      if (this.activeAbort === cycleAbort) {
        this.activeAbort = null;
        this.syncing = false;
      }
    }
  }

  private async recordFailure(
    error: MiniPodError,
    retryable: boolean,
    pulled: boolean,
    epoch: number,
  ): Promise<SyncRunResult> {
    if (epoch !== this.providerEpoch) {
      const status = await this.getStatus();
      return { status, pulled, uploaded: false, skipped: true };
    }

    this.syncing = false;
    this.errorClearedSinceLoad = false;

    const nowMs = this.now();
    const nonRetryable =
      !retryable || error.code === 'sync-auth' || error.code === 'sync-schema';

    if (nonRetryable) {
      this.needsAttention = true;
      await this.store.setSyncState({
        lastError: error.toShape(),
        backoffUntil: 0,
        hlcLast: this.hlc.current(),
      });
    } else {
      this.needsAttention = false;
      this.consecutiveFailures += 1;
      const delayMs = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
      );
      const backoffUntil = nowMs + delayMs;
      await this.store.setSyncState({
        lastError: error.toShape(),
        backoffUntil,
        hlcLast: this.hlc.current(),
      });
    }

    if (epoch !== this.providerEpoch) {
      const status = await this.getStatus();
      return { status, pulled, uploaded: false, skipped: true };
    }

    const finalStatus = await this.getStatus();
    this.emitStatus(finalStatus);
    return { status: finalStatus, pulled, uploaded: false, skipped: false };
  }

  /**
   * Deletes the remote sync file (when supported by the provider) and clears local remote-tracking metadata.
   */
  async resetRemote(signal?: AbortSignal): Promise<void> {
    const provider = this.provider as
      | (CloudFileProvider & { deleteRemote?: (sig?: AbortSignal) => Promise<void> })
      | null;
    if (provider?.deleteRemote) {
      await provider.deleteRemote(signal);
    }
    this.consecutiveFailures = 0;
    this.needsAttention = false;
    this.errorClearedSinceLoad = true;
    await this.store.setSyncState(
      clearErrorAndBackoffPatch({
        remoteEtag: null,
        remoteFileId: null,
        remoteRev: 0,
        remoteDevices: {},
        pendingLineageReset: false,
        hlcLast: this.hlc.current(),
      }),
    );
    const status = await this.getStatus();
    this.emitStatus(status);
  }
}
