import { HLC_MAX_FORWARD_SKEW_MS, type EpochMs, type HlcMs } from '../types';

/**
 * Hybrid Logical Clock (ARCHITECTURE.md §7.3).
 *
 * - `now()` advances monotonically: `Math.max(wallMs, hlc + 1)`.
 * - `observe(remoteHlcMax)` fast-forwards from remote documents capped at `wallMs + 5 min`
 *   so a badly skewed remote clock cannot permanently poison the global clock.
 * - `stamp(prevUpdatedAt)` stamps a local entity write with `Math.max(now(), (prev ?? 0) + 1)`
 *   so a causal edit of an entity always beats its previous version regardless of clock skew.
 */
export class HybridLogicalClock {
  private hlc: HlcMs;
  private readonly wallNow: () => EpochMs;

  constructor(initialHlc: HlcMs = 0, wallNow: () => EpochMs = Date.now) {
    this.hlc = Math.max(0, Math.trunc(initialHlc));
    this.wallNow = wallNow;
  }

  current(): HlcMs {
    return this.hlc;
  }

  now(): HlcMs {
    const wall = Math.trunc(this.wallNow());
    this.hlc = Math.max(wall, this.hlc + 1);
    return this.hlc;
  }

  /**
   * Restores this device's own persisted local HLC lower bound across restarts while
   * clamping to `wallNow + HLC_MAX_FORWARD_SKEW_MS` so normal backward wall-clock jumps
   * stay monotonic without allowing a poisoned future timestamp to persist forever.
   */
  restore(persistedLocalHlc: HlcMs): HlcMs {
    if (!Number.isFinite(persistedLocalHlc) || persistedLocalHlc <= 0) {
      return this.hlc;
    }
    const maxAllowed = Math.trunc(this.wallNow()) + HLC_MAX_FORWARD_SKEW_MS;
    const bounded = Math.min(Math.trunc(persistedLocalHlc), maxAllowed);
    this.hlc = Math.max(this.hlc, bounded);
    return this.hlc;
  }

  observe(remoteHlcMax: HlcMs): HlcMs {
    if (!Number.isFinite(remoteHlcMax) || remoteHlcMax <= 0) {
      return this.hlc;
    }
    const maxAllowed = Math.trunc(this.wallNow()) + HLC_MAX_FORWARD_SKEW_MS;
    const bounded = Math.min(Math.trunc(remoteHlcMax), maxAllowed);
    this.hlc = Math.max(this.hlc, bounded);
    return this.hlc;
  }

  stamp(previousUpdatedAt?: HlcMs): HlcMs {
    const tick = this.now();
    const prev = previousUpdatedAt !== undefined && Number.isFinite(previousUpdatedAt) ? Math.trunc(previousUpdatedAt) : 0;
    const next = Math.max(tick, prev + 1);
    const maxAllowed = Math.trunc(this.wallNow()) + HLC_MAX_FORWARD_SKEW_MS;
    if (next > this.hlc && next <= maxAllowed) {
      this.hlc = next;
    }
    return next;
  }

  /**
   * Stamps a historical local event (e.g. Android background playback journal replay) at its
   * real `eventWallMs` (capped at current wall clock) while preserving strict per-entity
   * causality (`> previousUpdatedAt`) without advancing the global clock to the replay time.
   */
  stampAtEventTime(eventWallMs: EpochMs, previousUpdatedAt?: HlcMs): HlcMs {
    const prev =
      previousUpdatedAt !== undefined && Number.isFinite(previousUpdatedAt)
        ? Math.trunc(previousUpdatedAt)
        : 0;
    const wall = Math.trunc(this.wallNow());
    const eventTs =
      Number.isFinite(eventWallMs) && eventWallMs > 0 ? Math.min(Math.trunc(eventWallMs), wall) : wall;
    return Math.max(eventTs, prev + 1);
  }
}

export function stampEntityUpdate(hlc: HybridLogicalClock, previousUpdatedAt?: HlcMs): HlcMs {
  return hlc.stamp(previousUpdatedAt);
}
