import { FeedUrlNotFoundError, MiniPodError } from '../errors';
import { decodeFeedBytes } from '../feed/decode';
import { discoverFeeds } from '../feed/HtmlFeedDiscoverer';
import { parseFeed } from '../feed/SyndParser';
import { detectFeedType } from '../feed/TypeDetector';
import { fetchWithBasicAuth, parseWwwAuthenticateRealm } from '../http/basicAuth';
import { RedirectRecorder } from '../http/redirectRecorder';
import { DEFAULT_USER_AGENT } from '../http/userAgent';
import type {
  FeedKey,
  FeedPreview,
  HttpBasicCredentials,
  HttpClient,
  PermanentRedirect,
  PodcastSearcherRegistry,
  ResolveResult,
} from '../types';
import { extractUrlCredentials, extractUrlFromSharedText } from '../util/url';
import { feedKey, prepareUrl } from './UrlNormalizer';

export interface FeedUrlResolverDeps {
  readonly http: HttpClient;
  readonly registry: PodcastSearcherRegistry;
  readonly userAgent?: string;
  readonly isSubscribed?: (key: FeedKey) => boolean | Promise<boolean>;
  readonly createPreviewId?: () => string;
}

export interface ResolveUrlOptions {
  readonly credentials?: HttpBasicCredentials;
  readonly signal?: AbortSignal;
}

function defaultPreviewId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = 'p_';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Implements the full URL resolution pipeline (ARCHITECTURE.md §4.1.2):
 * 1. Extract URL from share text if needed & normalize via `UrlNormalizer.prepare`.
 * 2. Translate Apple Podcasts / iTunes URLs via `registry.lookupUrl`; if Apple omits `feedUrl`
 *    (`FeedUrlNotFoundError`), run AntennaPod's `tryToRetrieveFeedUrlBySearch` exact title+author fallback.
 * 3. Fetch with Basic Auth challenge-response + redirect chain tracking.
 * 4. Run `TypeDetector` -> `SyndParser` (recording 301/308, `http->https`, or `<itunes:new-feed-url>`).
 * 5. On HTML webpages, run `HtmlFeedDiscoverer`: 1 feed -> auto-follow, N feeds -> `choices`, 0 -> `unsupported-feed`.
 */
export class FeedUrlResolver {
  private readonly http: HttpClient;
  private readonly registry: PodcastSearcherRegistry;
  private readonly userAgent: string;
  private readonly isSubscribed?: (key: FeedKey) => boolean | Promise<boolean>;
  private readonly createPreviewId: () => string;

  constructor(deps: FeedUrlResolverDeps) {
    this.http = deps.http;
    this.registry = deps.registry;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
    if (deps.isSubscribed !== undefined) this.isSubscribed = deps.isSubscribed;
    this.createPreviewId = deps.createPreviewId ?? defaultPreviewId;
  }

  async resolve(input: string, options?: ResolveUrlOptions): Promise<ResolveResult> {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new MiniPodError('invalid-url', 'URL must not be empty');
    }

    const candidate = /\s/.test(trimmed) ? (extractUrlFromSharedText(trimmed) ?? trimmed) : trimmed;
    let targetUrl = prepareUrl(candidate);

    if (this.registry.urlNeedsLookup(targetUrl)) {
      targetUrl = await this.lookupWithSearchFallback(targetUrl, options?.signal);
      targetUrl = prepareUrl(targetUrl);
    }

    return this.fetchAndInspect(targetUrl, options, true);
  }

  private async lookupWithSearchFallback(url: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.registry.lookupUrl(url, signal);
    } catch (err) {
      if (!(err instanceof FeedUrlNotFoundError)) {
        throw err;
      }
      // Port of AntennaPod `OnlineFeedViewActivity.tryToRetrieveFeedUrlBySearch`
      const query = `${err.trackName} ${err.artistName}`.trim();
      if (!query) throw err;

      const results = await this.registry.byId('combined').search(query, signal);
      const wantTitle = err.trackName.trim().toLowerCase();
      const wantAuthor = err.artistName.trim().toLowerCase();

      for (const r of results) {
        const gotTitle = r.title.trim().toLowerCase();
        const gotAuthor = (r.author ?? '').trim().toLowerCase();
        if (gotTitle === wantTitle && gotAuthor === wantAuthor && !this.registry.urlNeedsLookup(r.feedUrl)) {
          return r.feedUrl;
        }
      }
      throw err;
    }
  }

  private async fetchAndInspect(
    rawFetchUrl: string,
    options: ResolveUrlOptions | undefined,
    allowHtmlDiscovery: boolean,
  ): Promise<ResolveResult> {
    const { cleanUrl, credentials: inlineCreds } = extractUrlCredentials(rawFetchUrl);
    const effectiveCreds = inlineCreds ?? options?.credentials;

    const resp = await fetchWithBasicAuth(
      this.http,
      {
        url: cleanUrl,
        method: 'GET',
        headers: {
          Accept:
            'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
          'User-Agent': this.userAgent,
        },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      effectiveCreds,
    );

    const finalUrl = resp.finalUrl || cleanUrl;

    if (resp.status === 401) {
      const wwwAuth = resp.headers['www-authenticate'];
      const realm = parseWwwAuthenticateRealm(wwwAuth);
      return {
        kind: 'auth-required',
        url: finalUrl,
        ...(realm ? { realm } : {}),
      };
    }

    if (resp.status === 404 || resp.status === 410) {
      throw new MiniPodError('feed-not-found', `Feed not found at ${finalUrl} (HTTP ${resp.status})`, {
        details: { status: resp.status, url: finalUrl },
      });
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw new MiniPodError('network', `Failed to fetch feed (HTTP ${resp.status})`, {
        details: { status: resp.status, url: finalUrl },
      });
    }

    const contentType = resp.headers['content-type'];
    const text = decodeFeedBytes(await resp.bytes(), contentType);

    try {
      detectFeedType(text);
    } catch (err) {
      const isHtmlLike =
        (err instanceof MiniPodError && err.details?.['isHtml'] === true) ||
        Boolean(contentType && /text\/html|application\/xhtml\+xml/i.test(contentType));

      if (allowHtmlDiscovery && isHtmlLike) {
        const discovered = discoverFeeds(text, finalUrl);
        if (discovered.length === 1) {
          return this.fetchAndInspect(prepareUrl(discovered[0]!.url, finalUrl), options, false);
        }
        if (discovered.length > 1) {
          return {
            kind: 'choices',
            pageUrl: finalUrl,
            choices: discovered,
          };
        }
        throw new MiniPodError('unsupported-feed', 'Website does not contain any RSS or Atom feed links', {
          details: {
            url: finalUrl,
            ...(err instanceof MiniPodError && err.details ? err.details : {}),
          },
        });
      }
      throw err;
    }

    const parsed = parseFeed(text, { baseUrl: finalUrl });

    const chainPermRedirect = RedirectRecorder.analyse(resp.chain);
    let permanentRedirect: PermanentRedirect | undefined = chainPermRedirect;
    let canonicalFetchUrl = chainPermRedirect ? chainPermRedirect.to : cleanUrl;

    if (parsed.redirectUrl) {
      const preparedNewUrl = prepareUrl(parsed.redirectUrl, finalUrl);
      if (preparedNewUrl !== canonicalFetchUrl) {
        permanentRedirect = {
          from: cleanUrl,
          to: preparedNewUrl,
          reason: '301',
        };
        canonicalFetchUrl = preparedNewUrl;
      }
    }

    const key = feedKey(canonicalFetchUrl);
    const alreadySubscribed = this.isSubscribed ? await this.isSubscribed(key) : false;

    const preview: FeedPreview = {
      previewId: this.createPreviewId(),
      feedKey: key,
      url: canonicalFetchUrl,
      parsed,
      episodeCount: parsed.episodes.length,
      alreadySubscribed,
      ...(permanentRedirect ? { permanentRedirect } : {}),
    };

    return { kind: 'feed', preview };
  }
}

export function createFeedUrlResolver(deps: FeedUrlResolverDeps): FeedUrlResolver {
  return new FeedUrlResolver(deps);
}
