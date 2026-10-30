/**
 * Local Folder virtual feed dialog (`DESIGN.md` §4.2, `ARCHITECTURE.md` §4.2).
 */
import { useEffect, useState } from 'react';
import { useRouteStore } from '../../app/routes';
import { Button, Dialog } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';

export function LocalFolderDialog() {
  const host = useHost();
  const t = useT();

  const open = useRouteStore((s) => s.localFolderOpen);
  const setOpen = useRouteStore((s) => s.setLocalFolderOpen);
  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);

  const [folderPath, setFolderPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [browserDirs, setBrowserDirs] = useState<readonly string[]>([]);
  const [parentDir, setParentDir] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const browseTo = async (targetPath?: string) => {
    if (!host.files.listDirectory) return;
    try {
      const res = await host.files.listDirectory(targetPath);
      setFolderPath(res.path);
      setParentDir(res.parent);
      setBrowserDirs(res.dirs);
      const base = res.path.split(/[\\/]/).filter(Boolean).pop() ?? res.path;
      setDisplayName((prev) => prev || base);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!open) {
      setFolderPath('');
      setDisplayName('');
      setBrowserDirs([]);
      setParentDir(undefined);
      return;
    }
    if (!host.info.capabilities.folderPicker && host.files.listDirectory) {
      void browseTo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host]);

  const handleSystemPick = async () => {
    if (!host.files.pickFolder) return;
    const picked = await host.files.pickFolder();
    if (picked) {
      setFolderPath(picked.ref);
      setDisplayName(picked.displayName);
    }
  };

  const handleSubmit = async () => {
    const ref = folderPath.trim();
    if (!ref || submitting) return;
    const inferredName =
      displayName.trim() || ref.split(/[\\/]/).filter(Boolean).pop() || ref;
    setSubmitting(true);
    try {
      const feed = await host.feeds.addLocalFolder({ ref, displayName: inferredName });
      setOpen(false);
      openPodcastDetail(feed.feedKey);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('local.title')}
      testId="local-folder-dialog"
      actions={
        <>
          <Button variant="text" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!folderPath.trim() || submitting}
            data-testid="local-folder-submit-btn"
            onClick={() => {
              void handleSubmit();
            }}
          >
            {t('local.add')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, color: 'var(--md-sys-color-on-surface-variant)' }}>
        {t('local.hint')}
      </p>

      {host.info.capabilities.folderPicker && host.files.pickFolder && (
        <Button
          variant="tonal"
          icon="folder"
          data-testid="local-folder-pick-btn"
          onClick={() => {
            void handleSystemPick();
          }}
        >
          {t('local.pickSystem')}
        </Button>
      )}

      <label className="m-field">
        <span className="m-field__label">{t('local.folderPath')}</span>
        <input
          className="m-field__input"
          type="text"
          data-testid="local-folder-path-input"
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
        />
      </label>

      <label className="m-field">
        <span className="m-field__label">{t('local.displayName')}</span>
        <input
          className="m-field__input"
          type="text"
          data-testid="local-folder-name-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>

      {browserDirs.length > 0 && (
        <div
          style={{
            maxHeight: 160,
            overflowY: 'auto',
            border: '1px solid var(--md-sys-color-outline-variant)',
            borderRadius: 8,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {parentDir && (
            <button
              type="button"
              className="m-menu__item"
              onClick={() => {
                void browseTo(parentDir);
              }}
            >
              ↑ {t('local.parentDir')} ({parentDir})
            </button>
          )}
          {browserDirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="m-menu__item"
              onClick={() => {
                const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
                setDisplayName(name);
                void browseTo(dir);
              }}
            >
              {dir}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
