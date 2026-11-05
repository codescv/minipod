/**
 * Compact per-episode download controls shared by Queue rows, episode rows and the
 * `episode-detail-sheet` (`v0.1.29`, Android user feedback on `v0.1.28`):
 * - `下载中用百分比来表示进度`: a visible `{percent}%` label (tabular digits, no layout jitter) next to the
 *   progress ring, instead of a percentage hidden in a desktop-only hover `title`.
 * - `如果单集下载失败了，显示一个继续下载按钮`: a tappable `继续下载` / `Resume` pill for `FAILED` downloads.
 *
 * Both inline controls live inside gesture-driven rows (`role="button"` row containers), so they
 * are `<span role="button" tabIndex={0}>` (never nested `<button>`s) and stop pointer / touch /
 * click / `Enter` / `Space` propagation so tapping them never plays the row, opens its long-press
 * menu or starts a swipe.
 */
import type { KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from 'react';
import { Icon } from './m3';

/** Event props that run `action` on tap / click / `Enter` / `Space` without bubbling to the row. */
export function inlineRowActionProps(action: () => void): {
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  readonly onTouchStart: (e: TouchEvent<HTMLElement>) => void;
  readonly onClick: (e: MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  readonly onContextMenu: (e: MouseEvent<HTMLElement>) => void;
} {
  return {
    onPointerDown: (e) => {
      e.stopPropagation();
    },
    onTouchStart: (e) => {
      e.stopPropagation();
    },
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    },
    onContextMenu: (e) => {
      // No row long-press menu and no native menu for the inline control.
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** Dashed track + solid arc progress ring (14×14) with an optional centered stop square. */
export function DownloadProgressRing({
  ratio,
  withStop,
}: {
  readonly ratio: number;
  readonly withStop: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <circle
        cx="7"
        cy="7"
        r="5.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.1 2.1"
        opacity="0.45"
      />
      <circle
        cx="7"
        cy="7"
        r="5.25"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray={32.99}
        strokeDashoffset={Number((32.99 * (1 - Math.max(0.12, clamped))).toFixed(2))}
        transform="rotate(-90 7 7)"
      />
      {withStop && <rect x="5" y="5" width="4" height="4" rx="0.7" fill="currentColor" />}
    </svg>
  );
}

/** Visible `{percent}%` label (`tabular-nums`, fixed min width so `9%` -> `42%` never shifts the row). */
export function DownloadPercentText({
  percent,
  testId,
}: {
  readonly percent: number;
  readonly testId?: string | undefined;
}) {
  return (
    <span className="m-download-percent" data-testid={testId}>
      {`${percent}%`}
    </span>
  );
}

/** Compact tonal error-accented `继续下载` pill for `FAILED` downloads inside gesture rows. */
export function ResumeDownloadChip({
  label,
  ariaLabel,
  title,
  testId,
  onResume,
}: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly title?: string | undefined;
  readonly testId: string;
  readonly onResume: () => void;
}) {
  return (
    <span
      className="m-resume-download-chip"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      data-testid={testId}
      data-cache-state="failed"
      {...inlineRowActionProps(onResume)}
    >
      <Icon name="refresh" size={14} />
      <span>{label}</span>
    </span>
  );
}

/**
 * `episode-detail-sheet` download status line: `下载中 42%` (with ring) while `QUEUED`/`RUNNING`,
 * `下载失败` while `FAILED`; renders nothing otherwise.
 */
export function DetailDownloadStatus({
  state,
  ratio,
  downloadingLabel,
  failedLabel,
  testId,
}: {
  readonly state: 'downloading' | 'failed' | null;
  readonly ratio: number;
  readonly downloadingLabel: string;
  readonly failedLabel: string;
  readonly testId: string;
}) {
  if (state === null) return null;
  return (
    <div
      className={`m-detail-download-status is-${state}`}
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-download-state={state}
    >
      {state === 'downloading' ? (
        <DownloadProgressRing ratio={ratio} withStop={false} />
      ) : (
        <Icon name="close" size={14} />
      )}
      <span>{state === 'downloading' ? downloadingLabel : failedLabel}</span>
    </div>
  );
}
