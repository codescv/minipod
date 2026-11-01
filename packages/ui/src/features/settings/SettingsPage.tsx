/**
 * Minimalist Settings screen (`DESIGN.md` §4.7):
 * Strictly 8 rows — Cloud sync (4), Subscriptions (3), About (1).
 */
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, SyncProviderConfig, SyncStatus } from '@minipod/core';
import {
  AGENT_FEEDBACK_EMAIL_PLACEHOLDER,
  buildAgentFeedbackMailto,
  isValidFeedbackEmail,
  loadAgentFeedbackEmail,
  saveAgentFeedbackEmail,
} from './agent-feedback';
import { isGoogleDriveSafUri } from './CloudSyncSetup';
import { dispatchBackNavigation } from '../../app/back';
import { useRouteStore } from '../../app/routes';
import { Button, Dialog, IconButton, Switch } from '../../components/m3';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useT } from '../../i18n';
import { formatBytes, formatRelativeMinutes } from '../../lib/format';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';
import { getHostViewCache } from '../../stores/view-cache';
import { useUpdateStore } from '../updater/updater';

const REFRESH_OPTIONS: readonly AppSettings['backgroundRefreshHours'][] = [0, 1, 3, 6, 12, 24];

export function SettingsPage() {
  const host = useHost();
  const t = useT();
  const isDesktop = useIsDesktop();

  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);

  const openCloudSync = useRouteStore((s) => s.openCloudSync);
  const setOpmlImportOpen = useRouteStore((s) => s.setOpmlImportOpen);

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(
    () => getHostViewCache(host).syncStatus,
  );
  const [syncingNow, setSyncingNow] = useState(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [deviceDraft, setDeviceDraft] = useState(settings.sync.deviceName);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackEmail, setFeedbackEmail] = useState(() => loadAgentFeedbackEmail());
  const [feedbackText, setFeedbackText] = useState('');

  const updateStatus = useUpdateStore((s) => s.status);
  const updateRelease = useUpdateStore((s) => s.release);
  const updateProgress = useUpdateStore((s) => s.progressPercent);
  const updateDownloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const updateTotalBytes = useUpdateStore((s) => s.totalBytes);
  const updateNeedsPermission = useUpdateStore((s) => s.needsPermission);
  const updateAppliedMessage = useUpdateStore((s) => s.appliedMessage);
  const updateError = useUpdateStore((s) => s.error);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadUpdate = useUpdateStore((s) => s.downloadUpdate);
  const installDownloadedApk = useUpdateStore((s) => s.installDownloadedApk);

  const loadStatus = useCallback(async () => {
    try {
      const st = await host.sync.status();
      getHostViewCache(host).syncStatus = st;
      setSyncStatus(st);
    } catch {
      // ignore
    }
  }, [host]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useHostEvents((ev) => {
    if (ev.type === 'sync-status') {
      getHostViewCache(host).syncStatus = ev.status;
      setSyncStatus(ev.status);
    }
  });

  const providerLabel = (provider: SyncProviderConfig | null | undefined): string => {
    if (!provider) return t('settings.providerOff');
    switch (provider.id) {
      case 'local-folder':
        return t('settings.providerCloudFolder');
      case 'saf':
        return isGoogleDriveSafUri(provider.documentUri)
          ? t('settings.providerDrive')
          : t('settings.providerCloudFolder');
      case 'drive-appdata':
      case 'drive-file':
        return t('settings.providerDrive');
      case 'webdav':
        return t('settings.providerWebdav');
      case 'gist':
        return t('settings.providerGist');
    }
  };

  const renderSyncSummary = (): string => {
    if (!syncStatus || !syncStatus.enabled || syncStatus.phase === 'off') {
      return t('settings.syncStatusOff');
    }
    if (syncStatus.phase === 'syncing' || syncingNow) {
      return t('settings.syncStatusSyncing');
    }
    if (syncStatus.phase === 'needs-attention' && syncStatus.lastError) {
      return t('settings.syncStatusAttention', { error: syncStatus.lastError.message });
    }
    const stamp = Math.max(syncStatus.lastPushAt ?? 0, syncStatus.lastPullAt ?? 0);
    if (stamp > 0) {
      return t('settings.syncStatusOk', {
        when: formatRelativeMinutes(stamp),
        rev: syncStatus.remoteRev ?? 0,
      });
    }
    return t('settings.syncStatusIdle');
  };

  const handleSyncNow = async () => {
    if (syncingNow) return;
    setSyncingNow(true);
    try {
      const next = await host.sync.syncNow();
      getHostViewCache(host).syncStatus = next;
      setSyncStatus(next);
    } finally {
      setSyncingNow(false);
    }
  };

  const handleWifiOnlyChange = async (wifiOnly: boolean) => {
    const nextSync = { ...settings.sync, wifiOnly };
    await updateSettings(host, { sync: nextSync });
    if (nextSync.provider) {
      await host.sync.configure(nextSync).catch(() => undefined);
    }
  };

  const handleSaveDeviceName = async () => {
    const trimmed = deviceDraft.trim();
    if (!trimmed) return;
    const nextSync = { ...settings.sync, deviceName: trimmed };
    await updateSettings(host, { sync: nextSync });
    if (nextSync.provider) {
      await host.sync.configure(nextSync).catch(() => undefined);
    }
    setDeviceDialogOpen(false);
  };

  const handleExportOpml = async () => {
    const xml = await host.feeds.exportOpml();
    await host.files.saveTextFile('minipod-subscriptions.opml', xml, 'text/x-opml');
    showSnackbar(t('opml.exportedSnack'));
  };

  const handleOpenFeedback = useCallback(() => {
    setFeedbackEmail(loadAgentFeedbackEmail());
    setFeedbackOpen(true);
  }, []);

  const handleSaveFeedbackEmail = () => {
    const trimmed = feedbackEmail.trim();
    if (!trimmed) {
      saveAgentFeedbackEmail('');
      setFeedbackEmail('');
      showSnackbar(t('feedback.emailClearedSnack'));
      return;
    }
    if (!isValidFeedbackEmail(trimmed)) {
      showSnackbar(t('feedback.emailInvalidSnack'));
      return;
    }
    const saved = saveAgentFeedbackEmail(trimmed);
    setFeedbackEmail(saved);
    showSnackbar(t('feedback.emailSavedSnack'));
  };

  const handleSendFeedbackEmail = async () => {
    const trimmedEmail = feedbackEmail.trim();
    if (!isValidFeedbackEmail(trimmedEmail)) {
      showSnackbar(t('feedback.emailInvalidSnack'));
      return;
    }
    const savedEmail = saveAgentFeedbackEmail(trimmedEmail);
    setFeedbackEmail(savedEmail);
    const mailtoUrl = buildAgentFeedbackMailto({
      email: savedEmail,
      appVersion: host.info.appVersion,
      feedbackText,
      platform: host.info.platform,
      os: host.info.os,
    });
    try {
      await host.files.openExternal(mailtoUrl);
    } catch {
      if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
        window.location.assign(mailtoUrl);
      }
    }
    setFeedbackText('');
    setFeedbackOpen(false);
  };

  return (
    <div className="m-page" data-testid="settings-screen">
      <header className="m-appbar">
        {!isDesktop && (
          <IconButton
            icon="back"
            label={t('common.back')}
            onClick={() => dispatchBackNavigation()}
          />
        )}
        <h1 className="m-appbar__title">{t('settings.title')}</h1>
      </header>

      {/* Section 1: Cloud sync (Rows 1..4) */}
      <section className="m-settings-section">
        <h2 className="m-settings-heading">{t('settings.sectionSync')}</h2>

        <div className="m-settings-row" data-settings-row="1" data-testid="settings-row-sync-status">
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.syncStatusLabel')}</span>
            <span className="m-settings-row__subtitle" data-testid="settings-sync-status-text">
              {renderSyncSummary()}
            </span>
          </div>
          <Button
            variant="tonal"
            disabled={!settings.sync.provider || syncingNow}
            data-testid="settings-sync-now-btn"
            onClick={() => {
              void handleSyncNow();
            }}
          >
            {t('settings.syncNow')}
          </Button>
        </div>

        <button
          type="button"
          className="m-settings-row m-settings-row--clickable"
          data-settings-row="2"
          data-testid="settings-row-provider"
          onClick={openCloudSync}
        >
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.providerLabel')}</span>
            <span className="m-settings-row__subtitle" data-testid="settings-provider-value">
              {providerLabel(settings.sync.provider)}
            </span>
          </div>
          <span aria-hidden="true">›</span>
        </button>

        <div className="m-settings-row" data-settings-row="3" data-testid="settings-row-wifi-only">
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.wifiOnly')}</span>
          </div>
          <Switch
            checked={settings.sync.wifiOnly}
            label={t('settings.wifiOnly')}
            testId="settings-switch-wifi-only"
            onChange={(next) => {
              void handleWifiOnlyChange(next);
            }}
          />
        </div>

        <button
          type="button"
          className="m-settings-row m-settings-row--clickable"
          data-settings-row="4"
          data-testid="settings-row-device-name"
          onClick={() => {
            setDeviceDraft(settings.sync.deviceName);
            setDeviceDialogOpen(true);
          }}
        >
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.deviceName')}</span>
            <span className="m-settings-row__subtitle">{settings.sync.deviceName}</span>
          </div>
          <span aria-hidden="true">›</span>
        </button>
      </section>

      {/* Section 2: Subscriptions (Rows 5..7) */}
      <section className="m-settings-section">
        <h2 className="m-settings-heading">{t('settings.sectionSubscriptions')}</h2>

        <button
          type="button"
          className="m-settings-row m-settings-row--clickable"
          data-settings-row="5"
          data-testid="settings-row-import-opml"
          onClick={() => setOpmlImportOpen(true)}
        >
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.importOpml')}</span>
          </div>
        </button>

        <button
          type="button"
          className="m-settings-row m-settings-row--clickable"
          data-settings-row="6"
          data-testid="settings-row-export-opml"
          onClick={() => {
            void handleExportOpml();
          }}
        >
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.exportOpml')}</span>
          </div>
        </button>

        <div className="m-settings-row" data-settings-row="7" data-testid="settings-row-refresh">
          <div className="m-settings-row__text">
            <span className="m-settings-row__title">{t('settings.refreshInterval')}</span>
          </div>
          <select
            className="m-field__input"
            style={{ minHeight: 38, padding: '4px 10px' }}
            aria-label={t('settings.refreshInterval')}
            data-testid="settings-refresh-select"
            value={settings.backgroundRefreshHours}
            onChange={(e) => {
              const hours = Number.parseInt(e.target.value, 10) as AppSettings['backgroundRefreshHours'];
              void updateSettings(host, { backgroundRefreshHours: hours });
            }}
          >
            {REFRESH_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h === 0 ? t('settings.refreshOff') : t('settings.refreshEveryHours', { hours: h })}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Section 3: About (Row 8) */}
      <section className="m-settings-section">
        <h2 className="m-settings-heading">{t('settings.sectionAbout')}</h2>

        <div
          className="m-settings-row m-settings-row--clickable m-settings-row--about"
          data-settings-row="8"
          data-testid="settings-row-about"
          onClick={() => setAboutOpen(true)}
        >
          <div className="m-settings-row__text">
            <span
              className="m-settings-row__title"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <span>{t('settings.aboutRow')}</span>
              <span className="m-pill-badge" data-testid="settings-version-badge">
                v{host.info.appVersion}
              </span>
            </span>
            <span className="m-settings-row__subtitle">
              {t('settings.aboutSummary', { version: host.info.appVersion })}
            </span>
            {updateStatus !== 'idle' && (
              <span className="m-settings-row__subtitle" data-testid="settings-update-status">
                {updateStatus === 'checking'
                  ? t('update.checking')
                  : updateStatus === 'up-to-date'
                    ? t('update.upToDate', { version: host.info.appVersion })
                    : updateStatus === 'available' && updateRelease
                      ? t('update.availableStatus', { version: updateRelease.version })
                      : updateStatus === 'downloading'
                        ? updateProgress >= 0
                          ? `${t('update.downloadingProgress', { percent: Math.round(updateProgress) })}${
                              updateDownloadedBytes > 0
                                ? ` (${formatBytes(updateDownloadedBytes)}${
                                    updateTotalBytes > 0 ? ` / ${formatBytes(updateTotalBytes)}` : ''
                                  })`
                                : ''
                            }`
                          : t('update.applyingUpdate')
                        : updateStatus === 'ready-to-install' && updateRelease
                          ? updateNeedsPermission
                            ? t('update.needsPermissionStatus', { version: updateRelease.version })
                            : t('update.readyStatus', { version: updateRelease.version })
                          : updateStatus === 'applied' && updateAppliedMessage
                            ? t('update.appliedStatus', { message: updateAppliedMessage })
                            : updateStatus === 'error' && updateError
                              ? t('update.errorStatus', { error: updateError })
                              : null}
              </span>
            )}
            {updateStatus === 'downloading' && (
              <div className="m-update-banner__progress-track" data-testid="settings-update-progress">
                <div
                  className={`m-update-banner__progress-fill${updateProgress < 0 ? ' is-indeterminate' : ''}`}
                  style={
                    updateProgress >= 0
                      ? { width: `${Math.min(100, Math.round(updateProgress))}%` }
                      : undefined
                  }
                />
              </div>
            )}
          </div>

          <div
            className="m-settings-row__actions"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="outlined"
              icon="mail"
              data-testid="settings-feedback-btn"
              onClick={handleOpenFeedback}
            >
              {t('feedback.openButton')}
            </Button>
            {updateStatus === 'available' && updateRelease ? (
              <Button
                variant="filled"
                icon="download"
                data-testid="settings-update-btn"
                onClick={() => {
                  void downloadUpdate(host);
                }}
              >
                {t('update.updateTo', { version: updateRelease.version })}
              </Button>
            ) : updateStatus === 'ready-to-install' ? (
              <Button
                variant="filled"
                icon="download"
                data-testid="settings-update-btn"
                onClick={() => {
                  void installDownloadedApk(host);
                }}
              >
                {updateNeedsPermission ? t('update.grantAndInstall') : t('update.installApk')}
              </Button>
            ) : (
              <Button
                variant="tonal"
                disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                data-testid="settings-update-btn"
                onClick={() => {
                  void checkForUpdate(host, { silent: false });
                }}
              >
                {updateStatus === 'checking'
                  ? t('update.checkingShort')
                  : updateStatus === 'downloading'
                    ? updateProgress >= 0
                      ? `${Math.round(updateProgress)}%`
                      : t('update.checkingShort')
                    : t('update.checkForUpdates')}
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Device Name Dialog */}
      <Dialog
        open={deviceDialogOpen}
        onClose={() => setDeviceDialogOpen(false)}
        title={t('settings.deviceName')}
        testId="settings-device-dialog"
        actions={
          <>
            <Button variant="text" onClick={() => setDeviceDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="settings-device-save-btn"
              onClick={() => {
                void handleSaveDeviceName();
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <input
          className="m-field__input"
          type="text"
          aria-label={t('settings.deviceName')}
          data-testid="settings-device-input"
          value={deviceDraft}
          onChange={(e) => setDeviceDraft(e.target.value)}
        />
      </Dialog>

      {/* About Dialog */}
      <Dialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title={`${t('app.name')} ${host.info.appVersion}`}
        testId="settings-about-dialog"
        actions={
          <>
            <Button
              variant="text"
              icon="mail"
              data-testid="settings-about-feedback-btn"
              onClick={() => {
                setAboutOpen(false);
                handleOpenFeedback();
              }}
            >
              {t('feedback.openButton')}
            </Button>
            <Button
              variant="text"
              icon="openExternal"
              onClick={() => {
                void host.files.openExternal('https://github.com/codescv/minipod');
              }}
            >
              {t('settings.sourceCode')}
            </Button>
            <Button onClick={() => setAboutOpen(false)}>{t('common.close')}</Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('settings.aboutDescription')}</p>
        <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
          <div>Platform: {host.info.platform} ({host.info.os})</div>
          <div>Device ID: {host.info.deviceId}</div>
          {host.info.dataDir && <div>Data directory: {host.info.dataDir}</div>}
        </div>
      </Dialog>

      {/* Agent Feedback Dialog */}
      <Dialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        title={t('feedback.dialogTitle')}
        testId="settings-feedback-dialog"
        actions={
          <>
            <Button
              variant="text"
              data-testid="settings-feedback-cancel-btn"
              onClick={() => setFeedbackOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="filled"
              icon="send"
              data-testid="settings-feedback-send-btn"
              onClick={() => {
                void handleSendFeedbackEmail();
              }}
            >
              {t('feedback.sendEmail')}
            </Button>
          </>
        }
      >
        <div className="m-field">
          <label className="m-field__label" htmlFor="minipod-agent-feedback-email">
            {t('feedback.emailLabel')}
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              id="minipod-agent-feedback-email"
              className="m-field__input"
              style={{ flex: '1 1 200px', minWidth: 0 }}
              type="email"
              placeholder={AGENT_FEEDBACK_EMAIL_PLACEHOLDER}
              aria-label={t('feedback.emailLabel')}
              data-testid="settings-feedback-email-input"
              value={feedbackEmail}
              onChange={(e) => setFeedbackEmail(e.target.value)}
            />
            <Button
              variant="tonal"
              data-testid="settings-feedback-save-email-btn"
              onClick={handleSaveFeedbackEmail}
            >
              {t('feedback.saveEmail')}
            </Button>
          </div>
          <span className="m-field__hint">{t('feedback.emailHint')}</span>
        </div>

        <div className="m-field">
          <label className="m-field__label" htmlFor="minipod-agent-feedback-message">
            {t('feedback.messageLabel')}
          </label>
          <textarea
            id="minipod-agent-feedback-message"
            className="m-field__input m-field__textarea"
            rows={4}
            placeholder={t('feedback.messagePlaceholder')}
            aria-label={t('feedback.messageLabel')}
            data-testid="settings-feedback-message-input"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
          />
          <span className="m-field__hint" data-testid="settings-feedback-subject-preview">
            {t('feedback.subjectPreview', { version: host.info.appVersion.replace(/^v/i, '') })}
          </span>
        </div>
      </Dialog>
    </div>
  );
}
