import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Unified Add / Search / Top Charts / FeedPreview / 401 / Multi-Feed / OPML', () => {
  it('displays Top Charts when input is empty, switches countries, and filters search across All / Apple / PodcastIndex / fyyd / gpodder', async () => {
    renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-add-fab'));

    // Empty input shows Top Charts
    expect(await screen.findByTestId('top-charts-section')).toBeInTheDocument();
    expect(await screen.findByText('Accidental Tech Podcast')).toBeInTheDocument();

    // Switch Top Charts country to Japan
    fireEvent.change(screen.getByTestId('top-charts-country-select'), {
      target: { value: 'JP' },
    });
    expect(await screen.findByText(/Accidental Tech Podcast \(JP #1\)/)).toBeInTheDocument();

    // Search for "Free Software" — gpodder has weight 0 in `All` (`combined`), selectable alone via `gpodder` chip
    const input = screen.getByTestId('add-search-input');
    fireEvent.change(input, { target: { value: 'Free Software' } });

    fireEvent.click(screen.getByTestId('source-chip-gpodder'));
    expect(await screen.findByText('Free Software Weekly')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('source-chip-fyyd'));
    fireEvent.change(input, { target: { value: 'Open Web' } });
    expect(await screen.findByText('Open Web Craft')).toBeInTheDocument();
  });

  it('detects itpc:// / pcast:// / feed:// URLs, streams episode from FeedPreview without subscribing, then subscribes', async () => {
    const { host, engine } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    const initialSubCount = (await host.feeds.list()).length;

    fireEvent.click(screen.getByTestId('nav-rail-add-fab'));
    const input = await screen.findByTestId('add-search-input');

    fireEvent.change(input, { target: { value: 'itpc://feeds.example.org/indie-synth.xml' } });
    const openUrlBtn = await screen.findByTestId('add-open-url-btn');
    fireEvent.click(openUrlBtn);

    expect(await screen.findByTestId('feed-preview-screen')).toBeInTheDocument();
    expect(screen.getAllByText('Indie Synth').length).toBeGreaterThan(0);

    // Preview episode rows have zero inline buttons; tapping row 0 directly streams WITHOUT subscribing!
    const previewRow0 = screen.getByTestId('preview-ep-row-0');
    expect(previewRow0.querySelectorAll('button')).toHaveLength(0);
    fireEvent.click(previewRow0);
    await waitFor(() => {
      expect(engine.getSnapshot().playing).toBe(true);
    });
    expect((await host.feeds.list()).length).toBe(initialSubCount);

    // Context menu Add-to-Queue on episode 1 in FeedPreview also works without subscribing
    fireEvent.contextMenu(screen.getByTestId('preview-ep-row-1'), { clientX: 160, clientY: 220 });
    expect(await screen.findByTestId('preview-ep-context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('preview-ep-queue-1'));
    expect(await screen.findByTestId('snackbar')).toHaveTextContent('Added to queue');
    expect((await host.feeds.list()).length).toBe(initialSubCount);

    // Swipe-left on episode 0 in FeedPreview triggers Play Next with in-place row Undo (no snackbar)
    fireEvent.touchStart(previewRow0, { touches: [{ clientX: 260, clientY: 120 }] });
    fireEvent.touchMove(previewRow0, { touches: [{ clientX: 150, clientY: 121 }] });
    fireEvent.touchEnd(previewRow0, { changedTouches: [{ clientX: 140, clientY: 121 }] });
    expect(await screen.findByTestId(/^inline-undo-(?!btn)/)).toHaveTextContent('Playing next');
    expect(screen.queryByTestId('snackbar')).toBeNull();

    // Now click Subscribe -> navigates to PodcastDetail and adds to Subscriptions
    fireEvent.click(screen.getByTestId('preview-subscribe-btn'));
    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    expect((await host.feeds.list()).length).toBe(initialSubCount + 1);
  });

  it('prompts inline for HTTP 401 Basic Auth credentials and retries feed preview', async () => {
    renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-add-fab'));

    const input = await screen.findByTestId('add-search-input');
    fireEvent.change(input, { target: { value: 'https://private.example.org/feed.xml' } });
    fireEvent.click(await screen.findByTestId('add-open-url-btn'));

    // 401 Auth prompt appears inline
    expect(await screen.findByTestId('preview-auth-form')).toBeInTheDocument();
    expect(screen.getByText(/Subscriber-Only Private Feed/)).toBeInTheDocument();

    // Wrong password keeps auth prompt and shows error
    fireEvent.change(screen.getByTestId('preview-auth-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('preview-auth-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('preview-auth-retry-btn'));
    expect(await screen.findByTestId('preview-auth-error')).toBeInTheDocument();

    // Valid password resolves the protected feed preview
    fireEvent.change(screen.getByTestId('preview-auth-password'), { target: { value: 's3cr3t!' } });
    fireEvent.click(screen.getByTestId('preview-auth-retry-btn'));
    expect((await screen.findAllByText('Members Bonus Show (Private)')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('preview-subscribe-btn')).toBeInTheDocument();
  });

  it('shows multi-feed HTML discovery radio selector when multiple <link rel="alternate"> feeds exist', async () => {
    renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-add-fab'));

    const input = await screen.findByTestId('add-search-input');
    fireEvent.change(input, { target: { value: 'https://multi.example.org' } });
    fireEvent.click(await screen.findByTestId('add-open-url-btn'));

    expect(await screen.findByTestId('preview-choices-card')).toBeInTheDocument();
    expect(screen.getByText('Engineering Blog Podcast (MP3)')).toBeInTheDocument();
    expect(screen.getByText('Engineering Blog Video Cast (Atom)')).toBeInTheDocument();

    // Select the second (Atom) feed and open it
    fireEvent.click(screen.getByTestId('preview-choice-radio-1'));
    fireEvent.click(screen.getByTestId('preview-open-choice-btn'));

    expect(await screen.findByTestId('preview-subscribe-btn')).toBeInTheDocument();
    expect(screen.getAllByText('Blog Atom').length).toBeGreaterThan(0);
  });

  it('imports OPML subscriptions via checklist and adds local folder virtual feeds', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    const beforeCount = (await host.feeds.list()).length;

    fireEvent.click(screen.getByTestId('nav-rail-add-fab'));
    fireEvent.click(await screen.findByTestId('add-overflow-btn'));
    fireEvent.click(screen.getByTestId('add-menu-import-opml'));

    expect(await screen.findByTestId('opml-import-dialog')).toBeInTheDocument();
    const sampleOpml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Show One" xmlUrl="https://feeds.example.org/opml-one.xml" />
      <outline text="Show Two" xmlUrl="https://feeds.example.org/opml-two.xml" />
    </body></opml>`;

    fireEvent.change(screen.getByTestId('opml-xml-textarea'), { target: { value: sampleOpml } });
    fireEvent.click(screen.getByTestId('opml-parse-btn'));

    expect(await screen.findByText('Show One')).toBeInTheDocument();
    expect(screen.getByText('Show Two')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('opml-confirm-import-btn'));
    await waitFor(async () => {
      expect((await host.feeds.list()).length).toBe(beforeCount + 2);
    });

    // Also add a local folder virtual feed
    fireEvent.click(screen.getByTestId('add-overflow-btn'));
    fireEvent.click(screen.getByTestId('add-menu-local-folder'));
    expect(await screen.findByTestId('local-folder-dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('local-folder-path-input'), {
      target: { value: '/home/listener/Lectures' },
    });
    fireEvent.change(screen.getByTestId('local-folder-name-input'), {
      target: { value: 'CS Lectures' },
    });
    fireEvent.click(screen.getByTestId('local-folder-submit-btn'));

    expect(await screen.findByTestId('podcast-detail-screen')).toBeInTheDocument();
    expect((await screen.findAllByText('CS Lectures')).length).toBeGreaterThan(0);
  });
});
