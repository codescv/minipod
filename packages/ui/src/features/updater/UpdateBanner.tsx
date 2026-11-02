/**
 * Non-intrusive M3 banner surfaced when a newer MiniPod release is available on GitHub.
 *
 * - Dismissible per release tag (`minipod:update:dismissedTag` in `localStorage`).
 * - Android APK: 1-click auto-download with live progress bar + system installer launch.
 * - PC Web App: 1-click self-update (`host.updater.apply()`) or GitHub release page.
 */
import { Button, Icon, IconButton } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { formatBytes } from '../../lib/format';
import { useUpdateStore } from './updater';

function summarizeNotes(notes: string): string {
  const firstLine = notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

export function UpdateBanner() {
  const host = useHost();
  const t = useT();

  const status = useUpdateStore((s) => s.status);
  const release = useUpdateStore((s) => s.release);
  const dismissedTag = useUpdateStore((s) => s.dismissedTag);
  const progressPercent = useUpdateStore((s) => s.progressPercent);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const needsPermission = useUpdateStore((s) => s.needsPermission);
  const installerLaunched = useUpdateStore((s) => s.installerLaunched);
  const appliedMessage = useUpdateStore((s) => s.appliedMessage);
  const downloadUpdate = useUpdateStore((s) => s.downloadUpdate);
  const installDownloadedApk = useUpdateStore((s) => s.installDownloadedApk);
  const dismiss = useUpdateStore((s) => s.dismiss);

  if (!release) return null;

  const isActionable =
    status === 'available' ||
    status === 'downloading' ||
    status === 'ready-to-install' ||
    status === 'applied';
  if (!isActionable) return null;

  if ((status === 'available' || status === 'applied') && dismissedTag === release.tagName) {
    return null;
  }

  const summary = summarizeNotes(release.notes);
  const sizeBadge =
    host.info.platform === 'android' && release.apkSizeBytes && release.apkSizeBytes > 0
      ? ` · ${formatBytes(release.apkSizeBytes)}`
      : '';
  const pct = progressPercent >= 0 ? Math.min(100, Math.round(progressPercent)) : -1;

  return (
    <section
      className="m-update-banner"
      role="region"
      aria-label={t('update.bannerTitle', { version: release.version })}
      data-testid="update-banner"
    >
      <div className="m-update-banner__icon" aria-hidden="true">
        <Icon name="download" size={20} />
      </div>

      <div className="m-update-banner__content">
        <div className="m-update-banner__headline">
          <span className="m-pill-badge">{t('update.newBadge')}</span>
          <span className="m-update-banner__title">
            {t('update.bannerTitle', { version: release.version })}
            {sizeBadge}
          </span>
        </div>

        {status === 'downloading' ? (
          <div className="m-update-banner__progress" data-testid="update-banner-progress">
            <div className="m-update-banner__progress-label">
              <span>
                {pct >= 0
                  ? t('update.downloadingProgress', { percent: pct })
                  : t('update.applyingUpdate')}
              </span>
              {downloadedBytes > 0 && (
                <span>
                  {formatBytes(downloadedBytes)}
                  {totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''}
                </span>
              )}
            </div>
            <div className="m-update-banner__progress-track">
              <div
                className={`m-update-banner__progress-fill${pct < 0 ? ' is-indeterminate' : ''}`}
                style={pct >= 0 ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        ) : status === 'ready-to-install' ? (
          <div className="m-update-banner__notes">
            {needsPermission
              ? t('update.needsPermissionStatus', { version: release.version })
              : installerLaunched
                ? t('update.installerLaunchedStatus', { version: release.version })
                : t('update.readyStatus', { version: release.version })}
          </div>
        ) : status === 'applied' && appliedMessage ? (
          <div className="m-update-banner__notes" data-testid="update-banner-applied-msg">
            {appliedMessage}
          </div>
        ) : summary ? (
          <div className="m-update-banner__notes">{summary}</div>
        ) : null}
      </div>

      <div className="m-update-banner__actions">
        {status === 'ready-to-install' ? (
          <Button
            variant="filled"
            icon="download"
            data-testid="update-banner-install-btn"
            onClick={() => void installDownloadedApk(host)}
          >
            {needsPermission ? t('update.grantAndInstall') : t('update.installApk')}
          </Button>
        ) : status !== 'applied' ? (
          <Button
            variant="filled"
            icon="download"
            disabled={status === 'downloading'}
            data-testid="update-banner-action-btn"
            onClick={() => void downloadUpdate(host)}
          >
            {status === 'downloading'
              ? pct >= 0
                ? `${pct}%`
                : t('update.checkingShort')
              : t('update.updateNow')}
          </Button>
        ) : null}

        {status !== 'downloading' && (
          <IconButton
            icon="close"
            label={t('update.later')}
            data-testid="update-banner-dismiss-btn"
            onClick={() => dismiss(release.tagName)}
          />
        )}
      </div>
    </section>
  );
}
