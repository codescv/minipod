import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioEngine } from '../player/HtmlAudioEngine';
import { renderMiniPod } from './test-helpers';

describe('Player Controls, Chapters, Sleep Timer, Cross-Device Resume Undo & HtmlAudioEngine', () => {
  it('supports desktop transport, speed presets + slider, keyboard shortcuts, active chapter highlight + seek, and sanitized shownotes', async () => {
    const { host, engine } = renderMiniPod({ width: 1200 });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const playBtns = await screen.findAllByTestId(/^ep-play-/);
    fireEvent.click(playBtns[0]!);

    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect(screen.getByTestId('desktop-now-playing-title')).toHaveTextContent(
      /42: Zero-Backend Sync/,
    );

    // Skip forward (+30s) and back (-10s) via buttons
    const posBefore = engine.getSnapshot().positionMs;
    fireEvent.click(screen.getByTestId('desktop-skip-forward-btn'));
    expect(engine.getSnapshot().positionMs).toBe(posBefore + 30_000);

    fireEvent.click(screen.getByTestId('desktop-skip-back-btn'));
    expect(engine.getSnapshot().positionMs).toBe(posBefore + 20_000);

    // Cycle speed presets: 1x -> 1.25x -> 1.5x -> 1.75x -> 2x -> 1x
    const speedBtn = screen.getByTestId('desktop-speed-btn');
    expect(speedBtn).toHaveTextContent('1×');
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.25×');
    fireEvent.click(speedBtn);
    expect(speedBtn).toHaveTextContent('1.5×');

    // Fine-grain speed slider (0.5x..3.0x)
    fireEvent.click(screen.getByTestId('desktop-speed-slider-btn'));
    const slider = await screen.findByTestId('desktop-speed-slider');
    fireEvent.change(slider, { target: { value: '2.35' } });
    expect(engine.getSnapshot().speed).toBeCloseTo(2.35, 2);

    // Keyboard shortcuts: Space pauses/plays, J/L skip, [/] adjust speed, Q opens Queue
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(engine.getSnapshot().playing).toBe(false);
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(engine.getSnapshot().playing).toBe(true);

    const beforeKeySkip = engine.getSnapshot().positionMs;
    fireEvent.keyDown(window, { key: 'l' });
    expect(engine.getSnapshot().positionMs).toBe(beforeKeySkip + 30_000);
    fireEvent.keyDown(window, { key: 'j' });
    expect(engine.getSnapshot().positionMs).toBe(beforeKeySkip + 20_000);

    fireEvent.keyDown(window, { key: ']' });
    expect(engine.getSnapshot().speed).toBeCloseTo(2.45, 2);

    fireEvent.keyDown(window, { key: 'q' });
    expect(await screen.findByTestId('queue-screen')).toBeInTheDocument();

    // Open Chapters SideSheet, verify active chapter highlight & tap-to-seek
    fireEvent.click(screen.getByTestId('desktop-chapters-btn'));
    expect(await screen.findByTestId('desktop-side-sheet')).toBeInTheDocument();
    expect(await screen.findByTestId('chapters-list')).toBeInTheDocument();

    // At ~527s (8m47s), chapter index 1 (starts at 360_000ms) is active
    expect(screen.getByTestId('chapter-item-1')).toHaveAttribute('aria-current', 'true');

    // Click chapter 2 (starts at 1_080_000ms = 18:00) -> seeks immediately
    fireEvent.click(screen.getByTestId('chapter-item-2'));
    expect(engine.getSnapshot().positionMs).toBe(1_080_000);
    expect(screen.getByTestId('chapter-item-2')).toHaveAttribute('aria-current', 'true');

    // Switch SideSheet to Shownotes and click external link -> intercepted by `host.files.openExternal`
    fireEvent.click(screen.getByTestId('sidesheet-tab-shownotes'));
    const shownotes = await screen.findByTestId('shownotes-content');
    const link = shownotes.querySelector('a')!;
    fireEvent.click(link);
    expect(host.openedExternalUrls).toContain('https://antennapod.org');
  });

  it('handles Sleep Timer countdown + 60s fade-out, End-of-episode auto-advance suppression, and Cross-Device Resume Undo snackbar', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    fireEvent.click(await screen.findByText('Syntax & Signal'));
    const playBtns = await screen.findAllByTestId(/^ep-play-/);
    fireEvent.click(playBtns[0]!);
    await waitFor(() => expect(engine.getSnapshot().playing).toBe(true));

    const loadedKey = engine.getSnapshot().episodeKey!;
    const localPos = engine.getSnapshot().positionMs;

    // 1. Cross-device resume hint ("Resumed from Pixel 9 at 15:00 — Undo")
    act(() => {
      host.simulateRemoteProgress(loadedKey, 900_000, 'Pixel 9');
    });

    expect(engine.getSnapshot().positionMs).toBe(900_000);
    const snackbar = await screen.findByTestId('snackbar');
    expect(snackbar).toHaveTextContent('Resumed from Pixel 9 at 15:00');

    // Clicking Undo seeks back to localPos and invokes `host.sync.undoResume`
    fireEvent.click(screen.getByTestId('snackbar-action'));
    expect(engine.getSnapshot().positionMs).toBe(localPos);
    await waitFor(() => {
      expect(
        host.progressSaves.some(
          (s) => s.episodeKey === loadedKey && s.positionMs === localPos && s.flush === true,
        ),
      ).toBe(true);
    });

    // 2. Sleep timer 15 min: fades volume in final 60s and pauses at 0s
    fireEvent.click(screen.getByTestId('desktop-sleep-btn'));
    fireEvent.click(await screen.findByTestId('sleep-opt-15'));

    act(() => {
      engine.advanceSleepClock(14 * 60_000 + 30_000); // 30s remaining -> 0.5 fade factor
    });
    expect(engine.volumeFactor).toBeCloseTo(0.5, 1);
    expect(engine.getSnapshot().playing).toBe(true);

    act(() => {
      engine.advanceSleepClock(31_000); // expired -> pauses & restores volumeFactor = 1
    });
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.volumeFactor).toBe(1);

    // 3. Sleep timer `End of episode`: suppresses auto-advance when current episode finishes
    await act(async () => {
      await engine.play();
    });
    fireEvent.click(screen.getByTestId('desktop-sleep-btn'));
    fireEvent.click(await screen.findByTestId('sleep-opt-episode'));

    act(() => {
      engine.emitEnded();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.getSnapshot().playing).toBe(false);
    expect(engine.getSnapshot().episodeKey).toBe(loadedKey);
  });

  it('HtmlAudioEngine flushes progress with fetch keepalive on pagehide', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    const htmlEngine = new HtmlAudioEngine({
      flushUrl: '/api/progress/save',
      fetchImpl: fetchSpy,
    });

    await htmlEngine.load({
      episodeKey: 'e_test123',
      source: { kind: 'url', url: 'https://cdn.example.org/ep.mp3', mime: 'audio/mpeg' },
      startMs: 125_000,
      speed: 1.25,
      mediaType: 'AUDIO',
      metadata: { title: 'Test Ep', durationMs: 600_000 },
    });

    window.dispatchEvent(new Event('pagehide'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/progress/save');
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      episodeKey: 'e_test123',
      positionMs: 125_000,
      durationMs: 600_000,
      state: 'IN_PROGRESS',
      flush: true,
    });

    htmlEngine.dispose();
  });

  it('displays feed artwork fallback on DesktopPlayerBar when episode.imageUrl is absent', async () => {
    const desktop = renderMiniPod({ width: 1200 });
    fireEvent.click(await screen.findByText('Syntax & Signal'));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    const feeds = await desktop.host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const page = await desktop.host.episodes.list(syntax.feedKey, 'all');
    const ep39NoArt = page.items[3]!.episode;
    fireEvent.click(await screen.findByTestId(`ep-play-${ep39NoArt.episodeKey}`));
    await waitFor(() => expect(desktop.engine.getSnapshot().playing).toBe(true));

    const desktopCover = screen.getByTestId('desktop-cover-btn') as HTMLImageElement;
    expect(desktopCover.tagName).toBe('IMG');
    expect(desktopCover.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(desktopCover.getAttribute('src')).toBe(syntax.imageUrl);
  });

  it('displays episode artwork on ExpandedPlayer & MiniPlayer with proxy -> feed -> placeholder fallback on error and keeps playback alive across navigation', async () => {
    const mobile = renderMiniPod({ width: 390 });
    await screen.findByText('Syntax & Signal');

    const feeds = await mobile.host.feeds.list();
    const syntax = feeds.find((f) => f.title === 'Syntax & Signal')!;
    const brokenEpUrl = 'https://cdn.broken.example.org/ep-art.jpg';
    const feedCoverUrl = 'https://cdn.feed.example.org/podcast-cover.jpg';

    // Patch host.feeds.get & host.episodes.list for syntax.feedKey to return HTTP URLs so we exercise the full 4-step candidate chain
    const origGetFeed = mobile.host.feeds.get.bind(mobile.host.feeds);
    vi.spyOn(mobile.host.feeds, 'get').mockImplementation(async (fk) => {
      if (fk === syntax.feedKey) {
        return { ...syntax, feedKey: fk, imageUrl: feedCoverUrl };
      }
      return origGetFeed(fk);
    });
    const origListEpisodes = mobile.host.episodes.list.bind(mobile.host.episodes);
    const page = await origListEpisodes(syntax.feedKey, 'all');
    const epWithBrokenArt = {
      ...page.items[3]!.episode,
      imageUrl: brokenEpUrl,
    };
    vi.spyOn(mobile.host.episodes, 'list').mockImplementation(async (fk, filter, cursor) => {
      if (fk === syntax.feedKey) {
        return { items: [{ ...page.items[3]!, episode: epWithBrokenArt }] };
      }
      return origListEpisodes(fk, filter, cursor);
    });

    // Open Syntax & Signal and play the episode
    fireEvent.click(screen.getByTestId(`feed-tile-${syntax.feedKey}`));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId(`ep-play-${epWithBrokenArt.episodeKey}`));
    await waitFor(() => expect(mobile.engine.getSnapshot().playing).toBe(true));

    // MiniPlayer shows episode artwork with referrerPolicy="no-referrer"
    const miniImg = (await screen.findByTestId('mini-player-artwork-img')) as HTMLImageElement;
    expect(miniImg.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(miniImg.getAttribute('src')).toBe(brokenEpUrl);

    // Open ExpandedPlayer and step through error fallbacks
    fireEvent.click(screen.getByTestId('mini-player'));
    const expandedImg = (await screen.findByTestId('expanded-artwork-img')) as HTMLImageElement;
    expect(expandedImg.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(expandedImg.getAttribute('src')).toBe(brokenEpUrl);

    // Error 1 -> falls back to `/api/image-proxy?url=<episode.imageUrl>`
    fireEvent.error(expandedImg);
    expect(screen.getByTestId('expanded-artwork-img').getAttribute('src')).toBe(
      `/api/image-proxy?url=${encodeURIComponent(brokenEpUrl)}`,
    );

    // Error 2 -> falls back to `feed.imageUrl`
    fireEvent.error(screen.getByTestId('expanded-artwork-img'));
    expect(screen.getByTestId('expanded-artwork-img').getAttribute('src')).toBe(feedCoverUrl);

    // Error 3 -> falls back to `/api/image-proxy?url=<feed.imageUrl>`
    fireEvent.error(screen.getByTestId('expanded-artwork-img'));
    expect(screen.getByTestId('expanded-artwork-img').getAttribute('src')).toBe(
      `/api/image-proxy?url=${encodeURIComponent(feedCoverUrl)}`,
    );

    // Error 4 -> clean SVG placeholder (no broken <img> element left in ExpandedPlayer)
    fireEvent.error(screen.getByTestId('expanded-artwork-img'));
    expect(screen.queryByTestId('expanded-artwork-img')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('expanded-player').querySelector('.m-expanded-player__artwork-wrap svg'),
    ).not.toBeNull();

    // Closing ExpandedPlayer and navigating across screens keeps playback running uninterrupted
    fireEvent.click(screen.getByTestId('expanded-collapse-btn'));
    await waitFor(() => expect(screen.queryByTestId('expanded-player')).not.toBeInTheDocument());
    expect(mobile.engine.getSnapshot().playing).toBe(true);

    fireEvent.click(screen.getByTestId('detail-back-btn'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();
    expect(mobile.engine.getSnapshot().playing).toBe(true);

    fireEvent.click(screen.getByTestId('nav-bar-queue'));
    expect(await screen.findByTestId('queue-screen')).toBeInTheDocument();
    expect(mobile.engine.getSnapshot().playing).toBe(true);

    fireEvent.click(screen.getByTestId('nav-bar-subscriptions'));
    expect(await screen.findByTestId('subscriptions-screen')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('subs-add-fab'));
    expect(await screen.findByTestId('add-search-screen')).toBeInTheDocument();
    expect(mobile.engine.getSnapshot().playing).toBe(true);

    vi.restoreAllMocks();
  });

  it('HtmlAudioEngine keeps media elements attached inside hidden document.body park when video surface detaches on ExpandedPlayer close', async () => {
    const htmlEngine = new HtmlAudioEngine();

    await htmlEngine.load({
      episodeKey: 'e_vid_bg',
      source: { kind: 'url', url: 'https://cdn.example.org/40.mp4', mime: 'video/mp4' },
      startMs: 0,
      speed: 1,
      mediaType: 'VIDEO',
      metadata: { title: 'Video Ep', durationMs: 300_000 },
    });

    const park = document.body.querySelector('[data-minipod-media-park="true"]');
    expect(park).not.toBeNull();
    const videoEl = park!.querySelector('video')!;
    expect(videoEl).not.toBeNull();
    expect(document.body.contains(videoEl)).toBe(true);

    // Attach visible surface (ExpandedPlayer opens)
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    htmlEngine.attachVideoSurface(surface);
    expect(surface.contains(videoEl)).toBe(true);

    // Detach visible surface (ExpandedPlayer closes -> ref callback passes `null`)
    htmlEngine.attachVideoSurface(null);
    surface.remove();

    // `<video>` is reparented back into the hidden park inside `document.body`, NEVER detached from Document!
    expect(park!.contains(videoEl)).toBe(true);
    expect(document.body.contains(videoEl)).toBe(true);

    htmlEngine.dispose();
    expect(document.body.querySelector('[data-minipod-media-park="true"]')).toBeNull();
  });
});
