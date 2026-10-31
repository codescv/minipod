/**
 * Feed Preview screen (`DESIGN.md` §4.2):
 * 1. Inline HTTP 401 Basic Auth username/password retry prompt (`authChallenge`).
 * 2. Multi-feed HTML `<link rel="alternate">` radio selector (`choices`).
 * 3. Full feed preview with `[ Subscribe ]` AND direct `▶` episode streaming without subscribing.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DiscoveredFeedLink, EpisodeKey, FeedPreview as FeedPreviewModel } from '@minipod/core';
import { dispatchBackNavigation } from '../../app/back';
import { useRouteStore } from '../../app/routes';
import { ArtworkImage, Button, cx, Icon, IconButton, shouldUseImageProxy } from '../../components/m3';
import { useHost } from '../../host/HostContext';
import { useHostEvents } from '../../host/useHostEvents';
import { useLocale, useT } from '../../i18n';
import { formatHumanDuration, formatShortDate, stripHtmlToText } from '../../lib/format';
import { deriveEpisodeKey } from '../../lib/identity';
import { usePlayer } from '../../player/usePlayer';
import { showSnackbar } from '../../stores/snackbar';

export interface FeedPreviewScreenProps {
  readonly url: string;
  readonly preview?: FeedPreviewModel | undefined;
  readonly authChallenge?: { readonly url: string; readonly realm?: string | undefined } | undefined;
  readonly choices?: { readonly pageUrl: string; readonly items: readonly DiscoveredFeedLink[] } | undefined;
}

export function FeedPreview({ url, preview, authChallenge, choices }: FeedPreviewScreenProps) {
  const host = useHost();
  const locale = useLocale();
  const t = useT();
  const player = usePlayer();

  const openPodcastDetail = useRouteStore((s) => s.openPodcastDetail);
  const replaceFeedPreview = useRouteStore((s) => s.replaceFeedPreview);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedChoiceUrl, setSelectedChoiceUrl] = useState(choices?.items[0]?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [queuedKeys, setQueuedKeys] = useState<ReadonlySet<EpisodeKey>>(() => new Set());

  const loadQueuedKeys = useCallback(async () => {
    try {
      const list = await host.queue.list();
      setQueuedKeys(new Set(list.map((r) => r.episode.episodeKey)));
    } catch {
      // ignore
    }
  }, [host]);

  useEffect(() => {
    void loadQueuedKeys();
  }, [loadQueuedKeys, preview?.feedKey]);

  useHostEvents((ev) => {
    if (ev.type === 'queue-changed') {
      void loadQueuedKeys();
    }
  });

  useEffect(() => {
    if (choices?.items[0]) {
      setSelectedChoiceUrl(choices.items[0].url);
    }
  }, [choices]);

  // If navigated with only a bare URL, resolve it automatically
  useEffect(() => {
    if (preview || authChallenge || choices) return;
    let alive = true;
    setBusy(true);
    void host.feeds
      .preview(url)
      .then((res) => {
        if (!alive) return;
        if (res.kind === 'feed') {
          replaceFeedPreview({ url: res.preview.url, preview: res.preview });
        } else if (res.kind === 'auth-required') {
          replaceFeedPreview({
            url: res.url,
            authChallenge: {
              url: res.url,
              ...(res.realm !== undefined ? { realm: res.realm } : {}),
            },
          });
        } else if (res.kind === 'choices') {
          replaceFeedPreview({
            url: res.pageUrl,
            choices: { pageUrl: res.pageUrl, items: res.choices },
          });
        }
      })
      .catch((err) => {
        if (alive) showSnackbar(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [url, preview, authChallenge, choices, host, replaceFeedPreview]);

  const handleAuthRetry = async () => {
    if (!authChallenge || !username.trim() || busy) return;
    setBusy(true);
    setAuthError(null);
    try {
      const creds = { username: username.trim(), password };
      const res = await host.feeds.preview(authChallenge.url, creds);
      if (res.kind === 'feed') {
        await host.feeds.setCredentials(res.preview.feedKey, creds).catch(() => undefined);
        replaceFeedPreview({ url: res.preview.url, preview: res.preview });
      } else if (res.kind === 'auth-required') {
        setAuthError(t('preview.authTitle'));
      } else if (res.kind === 'choices') {
        replaceFeedPreview({
          url: res.pageUrl,
          choices: { pageUrl: res.pageUrl, items: res.choices },
        });
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenChoice = async () => {
    if (!selectedChoiceUrl || busy) return;
    setBusy(true);
    try {
      const res = await host.feeds.preview(selectedChoiceUrl);
      if (res.kind === 'feed') {
        replaceFeedPreview({ url: res.preview.url, preview: res.preview });
      } else if (res.kind === 'auth-required') {
        replaceFeedPreview({
          url: res.url,
          authChallenge: {
            url: res.url,
            ...(res.realm !== undefined ? { realm: res.realm } : {}),
          },
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubscribe = async () => {
    if (!preview || busy) return;
    if (preview.alreadySubscribed) {
      openPodcastDetail(preview.feedKey);
      return;
    }
    setBusy(true);
    try {
      const feed = await host.feeds.subscribe(preview.previewId);
      openPodcastDetail(feed.feedKey);
    } finally {
      setBusy(false);
    }
  };

  const plainDesc = stripHtmlToText(preview?.parsed.description);

  return (
    <div className="m-page" data-testid="feed-preview-screen">
      <header className="m-appbar">
        <IconButton
          icon="back"
          label={t('common.back')}
          data-testid="preview-back-btn"
          onClick={() => dispatchBackNavigation()}
        />
        <h1 className="m-appbar__title">{preview?.parsed.title ?? t('preview.title')}</h1>
      </header>

      {/* Mode 1: HTTP 401 Basic Auth inline prompt */}
      {authChallenge && (
        <section
          className="m-radio-card is-selected"
          style={{ maxWidth: 480 }}
          data-testid="preview-auth-form"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="lock" size={22} />
            <div style={{ font: 'var(--md-sys-typescale-title-medium)' }}>
              {t('preview.authTitle')}
            </div>
          </div>
          {authChallenge.realm && (
            <div style={{ font: 'var(--md-sys-typescale-label-medium)', color: 'var(--md-sys-color-on-surface-variant)' }}>
              Realm: {authChallenge.realm}
            </div>
          )}
          <div style={{ font: 'var(--md-sys-typescale-body-small)', color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('preview.authHint')}
          </div>
          {authError && (
            <div style={{ color: 'var(--md-sys-color-error)', font: 'var(--md-sys-typescale-label-medium)' }} data-testid="preview-auth-error">
              {authError}
            </div>
          )}
          <label className="m-field">
            <span className="m-field__label">{t('preview.username')}</span>
            <input
              className="m-field__input"
              type="text"
              data-testid="preview-auth-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="m-field">
            <span className="m-field__label">{t('preview.password')}</span>
            <input
              className="m-field__input"
              type="password"
              data-testid="preview-auth-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAuthRetry();
                }
              }}
            />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              disabled={!username.trim() || busy}
              data-testid="preview-auth-retry-btn"
              onClick={() => {
                void handleAuthRetry();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        </section>
      )}

      {/* Mode 2: Multi-feed HTML discovery radio selector */}
      {choices && (
        <section
          className="m-radio-card"
          style={{ maxWidth: 560 }}
          data-testid="preview-choices-card"
        >
          <div style={{ font: 'var(--md-sys-typescale-title-medium)' }}>
            {t('preview.choicesTitle')}
          </div>
          <div style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
            {t('preview.choicesHint')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {choices.items.map((item, idx) => (
              <label
                key={item.url}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background:
                    selectedChoiceUrl === item.url
                      ? 'var(--md-sys-color-secondary-container)'
                      : 'transparent',
                }}
                data-testid={`preview-choice-row-${idx}`}
              >
                <input
                  type="radio"
                  name="feed-choice"
                  checked={selectedChoiceUrl === item.url}
                  data-testid={`preview-choice-radio-${idx}`}
                  onChange={() => setSelectedChoiceUrl(item.url)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: 'var(--md-sys-typescale-title-small)' }}>
                    {item.title ?? item.url}
                  </div>
                  <div
                    style={{
                      font: 'var(--md-sys-typescale-body-small)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.url}
                  </div>
                </div>
                <span className="m-pill-badge">
                  {item.type === 'application/atom+xml' ? 'Atom' : 'RSS'}
                </span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              disabled={!selectedChoiceUrl || busy}
              data-testid="preview-open-choice-btn"
              onClick={() => {
                void handleOpenChoice();
              }}
            >
              {t('preview.openSelected')}
            </Button>
          </div>
        </section>
      )}

      {/* Mode 3: Resolved Feed Preview */}
      {preview && (
        <>
          <section className="m-feed-hero">
            <ArtworkImage
              src={preview.parsed.imageUrl}
              allowProxyFallback={shouldUseImageProxy(host.info.platform)}
              className="m-feed-hero__cover"
              placeholder={
                <div className="m-feed-hero__cover" style={{ display: 'grid', placeItems: 'center' }}>
                  <Icon name="podcasts" size={32} />
                </div>
              }
            />
            <div className="m-feed-hero__info">
              <div style={{ font: 'var(--md-sys-typescale-title-medium)' }}>
                {preview.parsed.title ?? preview.url}
              </div>
              {preview.parsed.author && (
                <div className="m-feed-hero__author">{preview.parsed.author}</div>
              )}
              <div style={{ font: 'var(--md-sys-typescale-label-medium)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                {t('preview.episodeCount', { count: preview.episodeCount })}
              </div>
              <div style={{ paddingTop: 4 }}>
                <Button
                  icon={preview.alreadySubscribed ? 'check' : 'add'}
                  disabled={busy}
                  data-testid="preview-subscribe-btn"
                  onClick={() => {
                    void handleSubscribe();
                  }}
                >
                  {preview.alreadySubscribed ? t('preview.subscribedOpen') : t('preview.subscribe')}
                </Button>
              </div>
            </div>
          </section>

          {plainDesc && (
            <p
              className={cx('m-feed-hero__desc', !descExpanded && 'is-clamped')}
              onClick={() => setDescExpanded((v) => !v)}
              style={{ cursor: 'pointer' }}
            >
              {plainDesc}
            </p>
          )}

          <div className="m-episode-list" data-testid="preview-episode-list">
            {preview.parsed.episodes.map((ep, idx) => {
              const epKey = deriveEpisodeKey(preview.feedKey, ep.identity);
              const inQueue = queuedKeys.has(epKey);
              const isCurrent = player.episode?.episodeKey === epKey;
              const isPlaying = isCurrent && player.snapshot.playing;
              const dateStr = formatShortDate(ep.pubDate, locale);
              const durStr = formatHumanDuration(ep.durationMs);
              return (
                <div key={ep.identity} className="m-episode-row" data-testid={`preview-ep-row-${idx}`}>
                  <div className="m-episode-row__body">
                    <div className="m-episode-row__meta">
                      {dateStr && <span>{dateStr}</span>}
                      {dateStr && durStr && <span>·</span>}
                      {durStr && <span>{durStr}</span>}
                    </div>
                    <div className="m-episode-row__title">{ep.title}</div>
                  </div>
                  <div className="m-episode-row__actions">
                    <IconButton
                      icon={isPlaying ? 'pause' : 'play'}
                      variant={isPlaying ? 'filled' : 'tonal'}
                      label={`${isPlaying ? t('detail.pause') : t('detail.play')} ${ep.title}`}
                      data-testid={`preview-ep-play-${idx}`}
                      onClick={() => {
                        if (isCurrent) {
                          void player.togglePlayPause();
                        } else {
                          void player.playPreviewEpisode(preview, ep);
                        }
                      }}
                    />
                    <IconButton
                      icon={inQueue ? 'queueMusic' : 'playlistAdd'}
                      variant={inQueue ? 'tonal' : 'standard'}
                      label={`${inQueue ? t('detail.removeFromQueue') : t('detail.addToQueue')} ${ep.title}`}
                      data-testid={`preview-ep-queue-${idx}`}
                      onClick={() => {
                        void (async () => {
                          try {
                            if (inQueue) {
                              await host.queue.remove(epKey);
                            } else {
                              await host.queue.add(epKey);
                              showSnackbar(t('detail.addedToQueue'), {
                                action: {
                                  label: t('common.undo'),
                                  run: () => {
                                    void host.queue.remove(epKey).then(loadQueuedKeys);
                                  },
                                },
                              });
                            }
                            await loadQueuedKeys();
                          } catch (err) {
                            showSnackbar(err instanceof Error ? err.message : String(err));
                          }
                        })();
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {busy && !preview && !authChallenge && !choices && (
        <div className="m-empty">{t('common.loading')}</div>
      )}
    </div>
  );
}
