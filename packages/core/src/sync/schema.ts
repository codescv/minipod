import { MiniPodError } from '../errors';
import {
  SYNC_SCHEMA_ID,
  SYNC_SCHEMA_VERSION,
  type DeviceId,
  type EpochMs,
  type HlcMs,
  type ProgressState,
  type QueueStub,
  type SyncDevice,
  type SyncDocument,
  type SyncEntityMaps,
  type SyncMap,
  type SyncProgress,
  type SyncQueueEntry,
  type SyncSubscription,
} from '../types';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function expectNonNegInt(val: unknown, field: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    throw new MiniPodError('sync-schema', `Invalid numeric field "${field}" in sync document`);
  }
  return Math.trunc(val);
}

function expectString(val: unknown, field: string): string {
  if (typeof val !== 'string') {
    throw new MiniPodError('sync-schema', `Invalid string field "${field}" in sync document`);
  }
  return val;
}

function expectBoolean(val: unknown, field: string): boolean {
  if (typeof val !== 'boolean') {
    throw new MiniPodError('sync-schema', `Invalid boolean field "${field}" in sync document`);
  }
  return val;
}

function parseDevices(raw: unknown): Record<DeviceId, SyncDevice> {
  if (!isRecord(raw)) {
    throw new MiniPodError('sync-schema', 'Invalid "devices" map in sync document');
  }
  const out: Record<DeviceId, SyncDevice> = {};
  for (const [deviceId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      throw new MiniPodError('sync-schema', `Invalid device entry "${deviceId}"`);
    }
    out[deviceId] = {
      name: expectString(entry['name'], `devices.${deviceId}.name`),
      app: expectString(entry['app'], `devices.${deviceId}.app`),
      lastSeenAt: expectNonNegInt(entry['lastSeenAt'], `devices.${deviceId}.lastSeenAt`),
    };
  }
  return out;
}

function parseSubscriptionsMap(raw: unknown): SyncMap<SyncSubscription> {
  if (!isRecord(raw) || !isRecord(raw['items'])) {
    throw new MiniPodError('sync-schema', 'Invalid "subscriptions" map in sync document');
  }
  const floor = expectNonNegInt(raw['floor'], 'subscriptions.floor');
  const items: Record<string, SyncSubscription> = {};
  for (const [key, item] of Object.entries(raw['items'])) {
    if (!isRecord(item)) {
      throw new MiniPodError('sync-schema', `Invalid subscription "${key}"`);
    }
    const url = expectString(item['url'], `subscriptions.items.${key}.url`);
    const updatedAt = expectNonNegInt(item['updatedAt'], `subscriptions.items.${key}.updatedAt`);
    const deleted = expectBoolean(item['deleted'], `subscriptions.items.${key}.deleted`);
    const deviceId = expectString(item['deviceId'], `subscriptions.items.${key}.deviceId`);
    const movedTo =
      item['movedTo'] === null
        ? null
        : typeof item['movedTo'] === 'string'
          ? item['movedTo']
          : undefined;
    const title = typeof item['title'] === 'string' ? item['title'] : undefined;
    const imageUrl = typeof item['imageUrl'] === 'string' ? item['imageUrl'] : undefined;
    const hasCredentials = typeof item['hasCredentials'] === 'boolean' ? item['hasCredentials'] : undefined;

    items[key] = {
      url,
      updatedAt,
      deleted,
      deviceId,
      ...(movedTo !== undefined ? { movedTo } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(hasCredentials !== undefined ? { hasCredentials } : {}),
    };
  }
  return { floor, items };
}

function parseQueueStub(raw: unknown, key: string): QueueStub {
  if (!isRecord(raw)) {
    throw new MiniPodError('sync-schema', `Invalid queue stub for "${key}"`);
  }
  const identity = expectString(raw['identity'], `queue.${key}.stub.identity`);
  const title = expectString(raw['title'], `queue.${key}.stub.title`);
  const feedUrl = expectString(raw['feedUrl'], `queue.${key}.stub.feedUrl`);
  const feedTitle = typeof raw['feedTitle'] === 'string' ? raw['feedTitle'] : undefined;
  const enclosureUrl = typeof raw['enclosureUrl'] === 'string' ? raw['enclosureUrl'] : undefined;
  const enclosureMime = typeof raw['enclosureMime'] === 'string' ? raw['enclosureMime'] : undefined;
  const durationMs =
    typeof raw['durationMs'] === 'number' && Number.isFinite(raw['durationMs']) && raw['durationMs'] >= 0
      ? Math.trunc(raw['durationMs'])
      : undefined;
  const imageUrl = typeof raw['imageUrl'] === 'string' ? raw['imageUrl'] : undefined;
  const pubDate =
    typeof raw['pubDate'] === 'number' && Number.isFinite(raw['pubDate'])
      ? Math.trunc(raw['pubDate'])
      : undefined;

  return {
    identity,
    title,
    feedUrl,
    ...(feedTitle !== undefined ? { feedTitle } : {}),
    ...(enclosureUrl !== undefined ? { enclosureUrl } : {}),
    ...(enclosureMime !== undefined ? { enclosureMime } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(pubDate !== undefined ? { pubDate } : {}),
  };
}

function parseQueueMap(raw: unknown): SyncMap<SyncQueueEntry> {
  if (!isRecord(raw) || !isRecord(raw['items'])) {
    throw new MiniPodError('sync-schema', 'Invalid "queue" map in sync document');
  }
  const floor = expectNonNegInt(raw['floor'], 'queue.floor');
  const items: Record<string, SyncQueueEntry> = {};
  for (const [key, item] of Object.entries(raw['items'])) {
    if (!isRecord(item)) {
      throw new MiniPodError('sync-schema', `Invalid queue entry "${key}"`);
    }
    const feedKey = expectString(item['feedKey'], `queue.items.${key}.feedKey`);
    const pos = expectString(item['pos'], `queue.items.${key}.pos`);
    const addedAt = expectNonNegInt(item['addedAt'], `queue.items.${key}.addedAt`);
    const updatedAt = expectNonNegInt(item['updatedAt'], `queue.items.${key}.updatedAt`);
    const removed = expectBoolean(item['removed'], `queue.items.${key}.removed`);
    const deviceId = expectString(item['deviceId'], `queue.items.${key}.deviceId`);
    const stub = item['stub'] !== undefined && item['stub'] !== null ? parseQueueStub(item['stub'], key) : undefined;

    items[key] = {
      feedKey,
      pos,
      addedAt,
      updatedAt,
      removed,
      deviceId,
      ...(stub !== undefined ? { stub } : {}),
    };
  }
  return { floor, items };
}

function parseProgressState(val: unknown, key: string): ProgressState {
  if (val === 'NEW' || val === 'IN_PROGRESS' || val === 'PLAYED') {
    return val;
  }
  throw new MiniPodError('sync-schema', `Invalid progress state for "${key}": ${String(val)}`);
}

function parseProgressMap(raw: unknown): SyncMap<SyncProgress> {
  if (!isRecord(raw) || !isRecord(raw['items'])) {
    throw new MiniPodError('sync-schema', 'Invalid "progress" map in sync document');
  }
  const floor = expectNonNegInt(raw['floor'], 'progress.floor');
  const items: Record<string, SyncProgress> = {};
  for (const [key, item] of Object.entries(raw['items'])) {
    if (!isRecord(item)) {
      throw new MiniPodError('sync-schema', `Invalid progress entry "${key}"`);
    }
    const feedKey = expectString(item['feedKey'], `progress.items.${key}.feedKey`);
    const positionMs = expectNonNegInt(item['positionMs'], `progress.items.${key}.positionMs`);
    const state = parseProgressState(item['state'], key);
    const updatedAt = expectNonNegInt(item['updatedAt'], `progress.items.${key}.updatedAt`);
    const deviceId = expectString(item['deviceId'], `progress.items.${key}.deviceId`);
    const identity = typeof item['identity'] === 'string' ? item['identity'] : undefined;
    const durationMs =
      typeof item['durationMs'] === 'number' && Number.isFinite(item['durationMs']) && item['durationMs'] >= 0
        ? Math.trunc(item['durationMs'])
        : undefined;
    const playedAt =
      item['playedAt'] === null
        ? null
        : typeof item['playedAt'] === 'number' && Number.isFinite(item['playedAt'])
          ? Math.trunc(item['playedAt'])
          : undefined;

    items[key] = {
      feedKey,
      positionMs,
      state,
      updatedAt,
      deviceId,
      ...(identity !== undefined ? { identity } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(playedAt !== undefined ? { playedAt } : {}),
    };
  }
  return { floor, items };
}

/**
 * Validates and parses a `minipod-sync-v1.json` document from UTF-8 bytes or string.
 * Rejects malformed JSON or mismatched schema with `MiniPodError('sync-schema', ...)`.
 * If `schemaVersion > SYNC_SCHEMA_VERSION`, sets `details.newerSchemaVersion = true` so
 * the engine enters read-only "update MiniPod" mode instead of overwriting (§9.3).
 */
export function parseSyncDocument(input: string | Uint8Array): SyncDocument {
  const text = typeof input === 'string' ? input : utf8Decoder.decode(input);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new MiniPodError('sync-schema', 'Sync file is not valid JSON', { cause: err });
  }

  if (!isRecord(raw)) {
    throw new MiniPodError('sync-schema', 'Sync file root must be a JSON object');
  }

  if (raw['schema'] !== SYNC_SCHEMA_ID) {
    throw new MiniPodError('sync-schema', `Unexpected sync schema "${String(raw['schema'])}"`, {
      details: { schema: raw['schema'] },
    });
  }

  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MiniPodError('sync-schema', `Invalid sync schemaVersion "${String(version)}"`);
  }
  if (version > SYNC_SCHEMA_VERSION) {
    throw new MiniPodError(
      'sync-schema',
      `Sync file requires schemaVersion ${version} (this app supports up to ${SYNC_SCHEMA_VERSION}). Please update MiniPod.`,
      { details: { schemaVersion: version, newerSchemaVersion: true } },
    );
  }

  return {
    schema: SYNC_SCHEMA_ID,
    schemaVersion: version,
    rev: expectNonNegInt(raw['rev'], 'rev'),
    writtenAt: expectNonNegInt(raw['writtenAt'], 'writtenAt'),
    writtenBy: expectString(raw['writtenBy'], 'writtenBy'),
    hlcMax: expectNonNegInt(raw['hlcMax'], 'hlcMax'),
    devices: parseDevices(raw['devices']),
    subscriptions: parseSubscriptionsMap(raw['subscriptions']),
    queue: parseQueueMap(raw['queue']),
    progress: parseProgressMap(raw['progress']),
  };
}

function canonicalizeValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(canonicalizeValue);
  const rec = val as Record<string, unknown>;
  const sortedKeys = Object.keys(rec).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = rec[k];
    if (v !== undefined) {
      out[k] = canonicalizeValue(v);
    }
  }
  return out;
}

/**
 * Serializes a `SyncDocument` into canonical, deterministically ordered UTF-8 JSON.
 */
export function stringifySyncDocument(doc: SyncDocument): string {
  const ordered = {
    schema: doc.schema,
    schemaVersion: doc.schemaVersion,
    rev: doc.rev,
    writtenAt: doc.writtenAt,
    writtenBy: doc.writtenBy,
    hlcMax: doc.hlcMax,
    devices: canonicalizeValue(doc.devices),
    subscriptions: {
      floor: doc.subscriptions.floor,
      items: canonicalizeValue(doc.subscriptions.items),
    },
    queue: {
      floor: doc.queue.floor,
      items: canonicalizeValue(doc.queue.items),
    },
    progress: {
      floor: doc.progress.floor,
      items: canonicalizeValue(doc.progress.items),
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function serializeSyncDocument(doc: SyncDocument): Uint8Array {
  return utf8Encoder.encode(stringifySyncDocument(doc));
}

export function createEmptySyncDocument(deviceId: DeviceId = 'd_00000000000000000000000000000000', writtenAt: EpochMs = 0): SyncDocument {
  return {
    schema: SYNC_SCHEMA_ID,
    schemaVersion: SYNC_SCHEMA_VERSION,
    rev: 0,
    writtenAt,
    writtenBy: deviceId,
    hlcMax: 0,
    devices: {},
    subscriptions: { floor: 0, items: {} },
    queue: { floor: 0, items: {} },
    progress: { floor: 0, items: {} },
  };
}

/**
 * Computes the maximum HLC timestamp across all entity records and floors in `maps`.
 */
export function computeEntityMapsHlcMax(maps: SyncEntityMaps): HlcMs {
  let max = Math.max(maps.subscriptions.floor, maps.queue.floor, maps.progress.floor, 0);
  for (const sub of Object.values(maps.subscriptions.items)) {
    if (sub.updatedAt > max) max = sub.updatedAt;
  }
  for (const q of Object.values(maps.queue.items)) {
    if (q.updatedAt > max) max = q.updatedAt;
    if (q.addedAt > max) max = q.addedAt;
  }
  for (const p of Object.values(maps.progress.items)) {
    if (p.updatedAt > max) max = p.updatedAt;
    if (typeof p.playedAt === 'number' && p.playedAt > max) max = p.playedAt;
  }
  return max;
}

/**
 * Deep structural equality over entity maps (`subscriptions`, `queue`, `progress`) ONLY,
 * ignoring `devices`, `rev`, `writtenAt`, `writtenBy`, and `hlcMax` (ARCHITECTURE.md §9.1).
 */
export function entityMapsEqual(a: SyncEntityMaps, b: SyncEntityMaps): boolean {
  if (
    a.subscriptions.floor !== b.subscriptions.floor ||
    a.queue.floor !== b.queue.floor ||
    a.progress.floor !== b.progress.floor
  ) {
    return false;
  }
  return (
    JSON.stringify(canonicalizeValue(a.subscriptions.items)) ===
      JSON.stringify(canonicalizeValue(b.subscriptions.items)) &&
    JSON.stringify(canonicalizeValue(a.queue.items)) ===
      JSON.stringify(canonicalizeValue(b.queue.items)) &&
    JSON.stringify(canonicalizeValue(a.progress.items)) ===
      JSON.stringify(canonicalizeValue(b.progress.items))
  );
}
