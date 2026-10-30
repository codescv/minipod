/**
 * Unified Add / Search screen (`DESIGN.md` §4.2):
 * - Single box accepting search queries, RSS/Atom URLs, website URLs, Apple links, and
 *   `itpc://`, `pcast://`, `pcast:`, `feed://`, `antennapod-subscribe://` schemes.
 * - Federated source chips: `All` (`combined`), `Apple`, `PodcastIndex`, `fyyd`, `gpodder`.
 * - Top Charts picker when input is empty.
 * - `⋮` overflow: *Import OPML…* and *Add local folder…*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResolveResult, SearchResult, SourceId } from '@minipod/core';
import { dispatchBackNavigation } from '../../app/back';
import { useRouteStore } from '../../app/routes';
import { Chip, Icon, IconButton, Menu, type MenuEntry } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { looksLikeUrlInput } from '../../lib/identity';
import { showSnackbar } from '../../stores/snackbar';
import { TopCharts } from './TopCharts';

const SOURCE_CHIPS: readonly {
  readonly id: SourceId;
  readonly labelKey:
    | 'add.sourceAll'
    | 'add.sourceApple'
    | 'add.sourcePodcastIndex'
    | 'add.sourceFyyd'
    | 'add.sourceGpodder';
}[] = [
  { id: 'combined', labelKey: 'add.sourceAll' },
  { id: 'apple', labelKey: 'add.sourceApple' },
  { id: 'podcastindex', labelKey: 'add.sourcePodcastIndex' },
  { id: 'fyyd', labelKey: 'add.sourceFyyd' },
  { id: 'gpodder', labelKey: 'add.sourceGpodder' },
];

export function AddSearch({ initialInput }: { readonly initialInput?: string | undefined }) {
  const host = useHost();
  const t = useT();

  const openFeedPreview = useRouteStore((s) => s.openFeedPreview);
  const setOpmlImportOpen = useRouteStore((s) => s.setOpmlImportOpen);
  const setLocalFolderOpen = useRouteStore((s) => s.setLocalFolderOpen);

  const [input, setInput] = useState(initialInput ?? '');
  const [source, setSource] = useState<SourceId>('combined');
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const autoResolvedInitialRef = useRef<string | null>(null);

  const routeResolveResult = useCallback(
    (rawUrl: string, res: ResolveResult) => {
      if (res.kind === 'feed') {
        openFeedPreview({ url: res.preview.url, preview: res.preview });
      } else if (res.kind === 'auth-required') {
        openFeedPreview({
          url: res.url,
          authChallenge: {
            url: res.url,
            ...(res.realm !== undefined ? { realm: res.realm } : {}),
          },
        });
      } else if (res.kind === 'choices') {
        openFeedPreview({
          url: res.pageUrl,
          choices: { pageUrl: res.pageUrl, items: res.choices },
        });
      } else {
        void rawUrl;
      }
    },
    [openFeedPreview],
  );

  const handleResolveUrl = useCallback(
    async (rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || resolving) return;
      setResolving(true);
      try {
        const res = await host.search.resolveUrl(trimmed);
        routeResolveResult(trimmed, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showSnackbar(msg);
      } finally {
        setResolving(false);
      }
    },
    [host, resolving, routeResolveResult],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialInput !== undefined && initialInput !== autoResolvedInitialRef.current) {
      autoResolvedInitialRef.current = initialInput;
      setInput(initialInput);
      if (looksLikeUrlInput(initialInput)) {
        void handleResolveUrl(initialInput);
      }
    }
  }, [initialInput, handleResolveUrl]);

  const trimmed = input.trim();
  const isUrlLike = looksLikeUrlInput(trimmed);

  // Debounced federated search when input is non-empty text
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void host.search
        .query(trimmed, source, ctrl.signal)
        .then((items) => {
          if (!ctrl.signal.aborted) {
            setResults(items);
            setSearching(false);
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) {
            setResults([]);
            setSearching(false);
          }
        });
    }, 150);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [trimmed, source, host]);

  const overflowItems: MenuEntry[] = [
    {
      key: 'import-opml',
      label: t('add.importOpml'),
      icon: 'rss',
      testId: 'add-menu-import-opml',
      onSelect: () => setOpmlImportOpen(true),
    },
    ...(host.info.capabilities.localFolderFeeds
      ? [
          {
            key: 'add-local-folder',
            label: t('add.addLocalFolder'),
            icon: 'folder' as const,
            testId: 'add-menu-local-folder',
            onSelect: () => setLocalFolderOpen(true),
          },
        ]
      : []),
  ];

  return (
    <div className="m-page" data-testid="add-search-screen">
      <div className="m-search-bar">
        <IconButton
          icon="back"
          label={t('common.back')}
          data-testid="add-back-btn"
          onClick={() => dispatchBackNavigation()}
        />
        <input
          ref={inputRef}
          className="m-search-bar__input"
          type="text"
          placeholder={t('add.placeholder')}
          aria-label={t('add.placeholder')}
          data-testid="add-search-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isUrlLike) {
              e.preventDefault();
              void handleResolveUrl(trimmed);
            }
          }}
        />
        {input.length > 0 && (
          <IconButton
            icon="close"
            label={t('common.clear')}
            data-testid="add-clear-btn"
            onClick={() => {
              setInput('');
              inputRef.current?.focus();
            }}
          />
        )}
        <Menu label={t('common.more')} items={overflowItems} testId="add-overflow-btn" />
      </div>

      {trimmed.length === 0 ? (
        <TopCharts
          onSelectResult={(item) => {
            void handleResolveUrl(item.feedUrl);
          }}
        />
      ) : (
        <>
          {isUrlLike && (
            <button
              type="button"
              className="m-open-url-card"
              disabled={resolving}
              data-testid="add-open-url-btn"
              onClick={() => {
                void handleResolveUrl(trimmed);
              }}
            >
              <Icon name="rss" size={24} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: 'var(--md-sys-typescale-title-small)' }}>
                  {resolving ? t('common.loading') : t('add.openFeed')}
                </div>
                <div
                  style={{
                    font: 'var(--md-sys-typescale-body-small)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('add.openFeedHint', { url: trimmed })}
                </div>
              </div>
            </button>
          )}

          <div className="m-chips" role="tablist" aria-label="Podcast directories">
            {SOURCE_CHIPS.map((chip) => (
              <Chip
                key={chip.id}
                selected={source === chip.id}
                testId={`source-chip-${chip.id}`}
                onClick={() => setSource(chip.id)}
              >
                {t(chip.labelKey)}
              </Chip>
            ))}
          </div>

          {searching ? (
            <div className="m-empty" data-testid="add-searching">
              {t('add.searching')}
            </div>
          ) : results.length === 0 ? (
            <div className="m-empty" data-testid="add-no-results">
              {t('add.noResults')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="add-results-list">
              {results.map((item, idx) => (
                <button
                  key={`${item.source}-${item.feedUrl}-${idx}`}
                  type="button"
                  className="m-result-row"
                  data-testid={`search-result-${idx}`}
                  onClick={() => {
                    void handleResolveUrl(item.feedUrl);
                  }}
                >
                  {item.imageUrl ? (
                    <img className="m-result-row__cover" src={item.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <div className="m-result-row__cover" style={{ display: 'grid', placeItems: 'center' }}>
                      <Icon name="podcasts" size={22} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        font: 'var(--md-sys-typescale-title-small)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </div>
                    {item.author && (
                      <div
                        style={{
                          font: 'var(--md-sys-typescale-body-small)',
                          color: 'var(--md-sys-color-on-surface-variant)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.author}
                      </div>
                    )}
                  </div>
                  <span className="m-pill-badge">{item.source}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
