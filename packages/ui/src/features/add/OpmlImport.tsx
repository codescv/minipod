/**
 * OPML Import checklist dialog (`DESIGN.md` §4.2, §4.7).
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { OpmlCandidate } from '@minipod/core';
import { useRouteStore } from '../../app/routes';
import { Button, Dialog } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { showSnackbar } from '../../stores/snackbar';

interface PreloadedOpmlState {
  readonly xml: string | null;
  setXml(xml: string | null): void;
}

const usePreloadedOpmlStore = create<PreloadedOpmlState>()((set) => ({
  xml: null,
  setXml: (xml) => set({ xml }),
}));

export function openOpmlImportWithXml(xml: string): void {
  usePreloadedOpmlStore.getState().setXml(xml);
  useRouteStore.getState().setOpmlImportOpen(true);
}

export function OpmlImport() {
  const host = useHost();
  const t = useT();

  const open = useRouteStore((s) => s.opmlImportOpen);
  const setOpen = useRouteStore((s) => s.setOpmlImportOpen);

  const preloadedXml = usePreloadedOpmlStore((s) => s.xml);
  const setPreloadedXml = usePreloadedOpmlStore((s) => s.setXml);

  const [xmlText, setXmlText] = useState('');
  const [candidates, setCandidates] = useState<readonly OpmlCandidate[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [parsedOnce, setParsedOnce] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseOpmlText = async (raw: string) => {
    const list = await host.feeds.importOpml(raw);
    setCandidates(list);
    setSelected(new Set(list.map((c) => c.xmlUrl)));
    setParsedOnce(true);
  };

  useEffect(() => {
    if (!open) {
      setXmlText('');
      setCandidates([]);
      setSelected(new Set());
      setParsedOnce(false);
      return;
    }
    if (preloadedXml) {
      const text = preloadedXml;
      setPreloadedXml(null);
      setXmlText(text);
      void parseOpmlText(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preloadedXml]);

  const toggleUrl = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0 || importing) return;
    setImporting(true);
    try {
      const res = await host.feeds.subscribeMany(Array.from(selected));
      showSnackbar(t('opml.importedSnack', { added: res.added }));
      setOpen(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('opml.title')}
      testId="opml-import-dialog"
      actions={
        <>
          <Button variant="text" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          {candidates.length > 0 ? (
            <Button
              disabled={selected.size === 0 || importing}
              data-testid="opml-confirm-import-btn"
              onClick={() => {
                void handleImport();
              }}
            >
              {t('opml.importCount', { count: selected.size })}
            </Button>
          ) : (
            <Button
              disabled={!xmlText.trim()}
              data-testid="opml-parse-btn"
              onClick={() => {
                void parseOpmlText(xmlText);
              }}
            >
              {t('opml.parse')}
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".opml,.xml,text/xml,application/xml"
          style={{ display: 'none' }}
          data-testid="opml-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              setXmlText(text);
              return parseOpmlText(text);
            });
          }}
        />
        <Button variant="tonal" icon="folder" onClick={() => fileInputRef.current?.click()}>
          {t('opml.chooseFile')}
        </Button>
      </div>

      {candidates.length === 0 && (
        <label className="m-field">
          <span className="m-field__label">{t('opml.pasteLabel')}</span>
          <textarea
            className="m-field__input"
            rows={5}
            data-testid="opml-xml-textarea"
            value={xmlText}
            onChange={(e) => setXmlText(e.target.value)}
          />
        </label>
      )}

      {parsedOnce && candidates.length === 0 && (
        <div style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>{t('opml.empty')}</div>
      )}

      {candidates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="text"
              data-testid="opml-select-all-btn"
              onClick={() => setSelected(new Set(candidates.map((c) => c.xmlUrl)))}
            >
              {t('opml.selectAll')}
            </Button>
            <Button
              variant="text"
              data-testid="opml-select-none-btn"
              onClick={() => setSelected(new Set())}
            >
              {t('opml.selectNone')}
            </Button>
          </div>
          <div
            style={{
              maxHeight: 260,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
            data-testid="opml-candidates-list"
          >
            {candidates.map((c) => (
              <label
                key={c.xmlUrl}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 8px',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.xmlUrl)}
                  onChange={() => toggleUrl(c.xmlUrl)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: 'var(--md-sys-typescale-title-small)' }}>{c.title}</div>
                  <div
                    style={{
                      font: 'var(--md-sys-typescale-body-small)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.xmlUrl}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
