/**
 * Zero-cost Cloud Sync Provider Setup screen (`DESIGN.md` §4.8, `ARCHITECTURE.md` §3 & §8).
 * Dynamically gated by `host.info.capabilities.syncProviders`.
 */
import { useEffect, useState } from 'react';
import type { SyncProviderConfig } from '@minipod/core';
import { dispatchBackNavigation } from '../../app/back';
import { Button, cx, Dialog, IconButton } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';

type ProviderChoice = 'off' | 'cloud-folder' | 'drive' | 'webdav' | 'gist';

export function isGoogleDriveSafUri(uri: string | undefined): boolean {
  return Boolean(uri && /com\.google\.android\.apps\.docs/i.test(uri));
}

function initialChoiceFromConfig(cfg: SyncProviderConfig | null): ProviderChoice {
  if (!cfg) return 'off';
  switch (cfg.id) {
    case 'local-folder':
      return 'cloud-folder';
    case 'saf':
      return isGoogleDriveSafUri(cfg.documentUri) ? 'drive' : 'cloud-folder';
    case 'drive-appdata':
    case 'drive-file':
      return 'drive';
    case 'webdav':
      return 'webdav';
    case 'gist':
      return 'gist';
  }
}

export function CloudSyncSetup() {
  const host = useHost();
  const t = useT();

  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);

  const supported = new Set(host.info.capabilities.syncProviders);
  const canLocalFolder = supported.has('local-folder');
  const canSaf = supported.has('saf');
  const canCloudFolder = canLocalFolder || canSaf;
  const canDriveAppData = supported.has('drive-appdata');
  const canDriveFile = supported.has('drive-file');
  const canDrive = canDriveAppData || canDriveFile;
  const canWebdav = supported.has('webdav');
  const canGist = supported.has('gist');

  const currentProvider = settings.sync.provider;

  const [choice, setChoice] = useState<ProviderChoice>(() =>
    initialChoiceFromConfig(currentProvider),
  );
  const [folderPath, setFolderPath] = useState(
    currentProvider?.id === 'local-folder' ? currentProvider.folderPath : '',
  );
  const [safUri, setSafUri] = useState(
    currentProvider?.id === 'saf' ? currentProvider.documentUri : '',
  );
  const [driveMode, setDriveMode] = useState<'drive-appdata' | 'drive-file'>(
    currentProvider?.id === 'drive-file'
      ? 'drive-file'
      : canDriveAppData
        ? 'drive-appdata'
        : 'drive-file',
  );
  const [webdavUrl, setWebdavUrl] = useState(
    currentProvider?.id === 'webdav' ? currentProvider.fileUrl : '',
  );
  const [webdavUser, setWebdavUser] = useState(
    currentProvider?.id === 'webdav' ? currentProvider.username : '',
  );
  const [webdavPass, setWebdavPass] = useState('');
  const [gistToken, setGistToken] = useState('');
  const [gistId, setGistId] = useState(
    currentProvider?.id === 'gist' ? (currentProvider.gistId ?? '') : '',
  );
  const [browserDirs, setBrowserDirs] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  useEffect(() => {
    setChoice(initialChoiceFromConfig(currentProvider));
    if (currentProvider?.id === 'saf') {
      setSafUri(currentProvider.documentUri);
    }
  }, [currentProvider]);

  const handleBrowseFolders = async () => {
    if (!host.files.listDirectory) return;
    const res = await host.files.listDirectory(folderPath || undefined);
    setFolderPath(res.path);
    setBrowserDirs(res.dirs);
  };

  const handlePickSaf = async (mode: 'open' | 'create') => {
    if (!host.files.pickSyncFile || busy) return;
    setBusy(true);
    try {
      const picked = await host.files.pickSyncFile(mode);
      if (!picked) return;
      setSafUri(picked.documentUri);
      await host.sync.configure({
        ...settings.sync,
        provider: { id: 'saf', documentUri: picked.documentUri },
      });
      await loadSettings(host);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveOff = async () => {
    setBusy(true);
    try {
      await host.sync.disconnect();
      await loadSettings(host);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveLocalFolder = async () => {
    const trimmed = folderPath.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await host.sync.configure({
        ...settings.sync,
        provider: { id: 'local-folder', folderPath: trimmed },
      });
      await loadSettings(host);
    } finally {
      setBusy(false);
    }
  };

  const handleEnableDrive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await host.sync.authorize(driveMode);
      await host.sync.configure({
        ...settings.sync,
        provider: { id: driveMode },
      });
      await loadSettings(host);
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveWebdav = async () => {
    if (!webdavUrl.trim() || !webdavUser.trim() || busy) return;
    setBusy(true);
    try {
      await host.sync.configure(
        {
          ...settings.sync,
          provider: {
            id: 'webdav',
            fileUrl: webdavUrl.trim(),
            username: webdavUser.trim(),
          },
        },
        { id: 'webdav', password: webdavPass },
      );
      await loadSettings(host);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveGist = async () => {
    if (!gistToken.trim() || busy) return;
    setBusy(true);
    try {
      const trimmedId = gistId.trim();
      await host.sync.configure(
        {
          ...settings.sync,
          provider: {
            id: 'gist',
            ...(trimmedId ? { gistId: trimmedId } : {}),
          },
        },
        { id: 'gist', token: gistToken.trim() },
      );
      await loadSettings(host);
    } finally {
      setBusy(false);
    }
  };

  const handleResetRemote = async () => {
    setConfirmResetOpen(false);
    setBusy(true);
    try {
      await host.sync.resetRemote();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-page" data-testid="cloud-sync-screen">
      <header className="m-appbar">
        <IconButton
          icon="back"
          label={t('common.back')}
          data-testid="sync-back-btn"
          onClick={() => dispatchBackNavigation()}
        />
        <h1 className="m-appbar__title">{t('sync.setupTitle')}</h1>
      </header>

      <div
        style={{
          font: 'var(--md-sys-typescale-body-medium)',
          color: 'var(--md-sys-color-on-surface-variant)',
        }}
        data-testid="sync-bg-hint"
      >
        {host.info.capabilities.backgroundSync ? t('sync.bgDesktopHint') : t('sync.bgAndroidHint')}
      </div>

      {/* Option 0: Off */}
      <div className={cx('m-radio-card', choice === 'off' && 'is-selected')} data-testid="sync-card-off">
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="radio"
            name="sync-provider"
            checked={choice === 'off'}
            data-testid="sync-radio-off"
            onChange={() => {
              setChoice('off');
              if (currentProvider) {
                void handleSaveOff();
              }
            }}
          />
          <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
            {t('settings.providerOff')}
          </span>
        </label>
      </div>

      {/* Option 1: File in a cloud folder (Desktop path OR Android SAF) */}
      {canCloudFolder && (
        <div
          className={cx('m-radio-card', choice === 'cloud-folder' && 'is-selected')}
          data-testid="sync-card-cloud-folder"
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name="sync-provider"
              checked={choice === 'cloud-folder'}
              data-testid="sync-radio-cloud-folder"
              onChange={() => setChoice('cloud-folder')}
            />
            <span style={{ font: 'var(--md-sys-typescale-title-small)', flex: 1 }}>
              {t('settings.providerCloudFolder')}
            </span>
            <span className="m-pill-badge">{t('sync.recommended')}</span>
          </label>
          <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {canSaf ? t('sync.folderDescAndroid') : t('sync.folderDescDesktop')}
          </div>

          {choice === 'cloud-folder' && canLocalFolder && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="m-field">
                <span className="m-field__label">{t('local.folderPath')}</span>
                <input
                  className="m-field__input"
                  type="text"
                  data-testid="sync-local-folder-input"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                />
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {host.files.listDirectory && (
                  <Button
                    variant="tonal"
                    icon="folder"
                    onClick={() => {
                      void handleBrowseFolders();
                    }}
                  >
                    {t('local.browse')}
                  </Button>
                )}
                <Button
                  disabled={!folderPath.trim() || busy}
                  data-testid="sync-local-folder-save-btn"
                  onClick={() => {
                    void handleSaveLocalFolder();
                  }}
                >
                  {t('sync.applyProvider')}
                </Button>
              </div>
              {browserDirs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {browserDirs.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="m-menu__item"
                      onClick={() => setFolderPath(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {choice === 'cloud-folder' && canSaf && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {safUri && (
                <div style={{ font: 'var(--md-sys-typescale-label-small)', overflowWrap: 'anywhere' }}>
                  {safUri}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant="tonal"
                  disabled={busy}
                  data-testid="sync-saf-create-btn"
                  onClick={() => {
                    void handlePickSaf('create');
                  }}
                >
                  {t('sync.safCreate')}
                </Button>
                <Button
                  variant="outlined"
                  disabled={busy}
                  data-testid="sync-saf-open-btn"
                  onClick={() => {
                    void handlePickSaf('open');
                  }}
                >
                  {t('sync.safOpen')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Option 2: Google Drive (gated on drive-appdata / drive-file capability) */}
      {canDrive && (
        <div
          className={cx('m-radio-card', choice === 'drive' && 'is-selected')}
          data-testid="sync-card-drive"
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name="sync-provider"
              checked={choice === 'drive'}
              data-testid="sync-radio-drive"
              onChange={() => setChoice('drive')}
            />
            <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
              {t('settings.providerDrive')}
            </span>
          </label>
          <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('sync.driveDesc')}
          </div>

          {choice === 'drive' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {canDriveAppData && canDriveFile && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="radio"
                      name="drive-mode"
                      checked={driveMode === 'drive-appdata'}
                      data-testid="sync-drive-mode-appdata"
                      onChange={() => setDriveMode('drive-appdata')}
                    />
                    <span>{t('sync.driveAppData')}</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="radio"
                      name="drive-mode"
                      checked={driveMode === 'drive-file'}
                      data-testid="sync-drive-mode-file"
                      onChange={() => setDriveMode('drive-file')}
                    />
                    <span>{t('sync.driveVisibleFile')}</span>
                  </label>
                </div>
              )}
              {currentProvider?.id === 'saf' && isGoogleDriveSafUri(currentProvider.documentUri) && (
                <div
                  style={{ font: 'var(--md-sys-typescale-label-small)', overflowWrap: 'anywhere' }}
                  data-testid="sync-drive-connected-uri"
                >
                  {currentProvider.documentUri}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  disabled={busy}
                  data-testid="sync-drive-signin-btn"
                  onClick={() => {
                    void handleEnableDrive();
                  }}
                >
                  {t('sync.driveSignIn')}
                </Button>
                {canSaf && Boolean(host.files.pickSyncFile) && (
                  <Button
                    variant="outlined"
                    disabled={busy}
                    data-testid="sync-drive-open-existing-btn"
                    onClick={() => {
                      void handlePickSaf('open');
                    }}
                  >
                    {t('sync.safOpen')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Option 3: WebDAV */}
      {canWebdav && (
        <div
          className={cx('m-radio-card', choice === 'webdav' && 'is-selected')}
          data-testid="sync-card-webdav"
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name="sync-provider"
              checked={choice === 'webdav'}
              data-testid="sync-radio-webdav"
              onChange={() => setChoice('webdav')}
            />
            <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
              {t('settings.providerWebdav')}
            </span>
          </label>
          <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('sync.webdavDesc')}
          </div>

          {choice === 'webdav' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="m-field">
                <span className="m-field__label">{t('sync.webdavUrl')}</span>
                <input
                  className="m-field__input"
                  type="url"
                  data-testid="sync-webdav-url"
                  value={webdavUrl}
                  onChange={(e) => setWebdavUrl(e.target.value)}
                />
              </label>
              <label className="m-field">
                <span className="m-field__label">{t('preview.username')}</span>
                <input
                  className="m-field__input"
                  type="text"
                  data-testid="sync-webdav-username"
                  value={webdavUser}
                  onChange={(e) => setWebdavUser(e.target.value)}
                />
              </label>
              <label className="m-field">
                <span className="m-field__label">{t('preview.password')}</span>
                <input
                  className="m-field__input"
                  type="password"
                  data-testid="sync-webdav-password"
                  value={webdavPass}
                  onChange={(e) => setWebdavPass(e.target.value)}
                />
              </label>
              <div>
                <Button
                  disabled={!webdavUrl.trim() || !webdavUser.trim() || busy}
                  data-testid="sync-webdav-save-btn"
                  onClick={() => {
                    void handleSaveWebdav();
                  }}
                >
                  {t('sync.applyProvider')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Option 4: GitHub Gist */}
      {canGist && (
        <div
          className={cx('m-radio-card', choice === 'gist' && 'is-selected')}
          data-testid="sync-card-gist"
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name="sync-provider"
              checked={choice === 'gist'}
              data-testid="sync-radio-gist"
              onChange={() => setChoice('gist')}
            />
            <span style={{ font: 'var(--md-sys-typescale-title-small)' }}>
              {t('settings.providerGist')}
            </span>
          </label>
          <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('sync.gistDesc')}
          </div>

          {choice === 'gist' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="m-field">
                <span className="m-field__label">{t('sync.gistToken')}</span>
                <input
                  className="m-field__input"
                  type="password"
                  data-testid="sync-gist-token"
                  value={gistToken}
                  onChange={(e) => setGistToken(e.target.value)}
                />
              </label>
              <label className="m-field">
                <span className="m-field__label">{t('sync.gistId')}</span>
                <input
                  className="m-field__input"
                  type="text"
                  data-testid="sync-gist-id"
                  value={gistId}
                  onChange={(e) => setGistId(e.target.value)}
                />
              </label>
              <div>
                <Button
                  disabled={!gistToken.trim() || busy}
                  data-testid="sync-gist-save-btn"
                  onClick={() => {
                    void handleSaveGist();
                  }}
                >
                  {t('sync.applyProvider')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {currentProvider && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 8 }}>
          <Button
            variant="tonal"
            disabled={busy}
            data-testid="sync-setup-sync-now-btn"
            onClick={() => {
              void host.sync.syncNow();
            }}
          >
            {t('settings.syncNow')}
          </Button>
          <Button
            variant="outlined"
            disabled={busy}
            data-testid="sync-setup-disconnect-btn"
            onClick={() => {
              void handleSaveOff();
            }}
          >
            {t('sync.disconnect')}
          </Button>
          <Button
            variant="text"
            disabled={busy}
            data-testid="sync-setup-reset-btn"
            onClick={() => setConfirmResetOpen(true)}
          >
            {t('sync.resetRemote')}
          </Button>
        </div>
      )}

      <Dialog
        open={confirmResetOpen}
        onClose={() => setConfirmResetOpen(false)}
        title={t('sync.resetRemote')}
        testId="sync-reset-confirm-dialog"
        actions={
          <>
            <Button variant="text" onClick={() => setConfirmResetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="sync-reset-confirm-btn"
              onClick={() => {
                void handleResetRemote();
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('sync.resetConfirm')}</p>
      </Dialog>
    </div>
  );
}
