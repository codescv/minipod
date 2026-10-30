# AntennaPod Source & Discovery Inventory

This document provides a comprehensive, code-verified technical inventory of all discovery providers, feed parsing protocols, ingestion pipelines, network security mechanisms, and playback/chapter formats in **AntennaPod** (commit `047e35079b` / `develop` branch and historical tags).

Every detail documented herein has been verified against the AntennaPod source code.

---

## 1. Online Discovery & Search Providers (`net/discovery/`)

AntennaPod organizes online podcast search and discovery under the `net/discovery` Gradle subproject (`de.danoeh.antennapod.net.discovery`). All search providers implement the common interface `PodcastSearcher`.

```mermaid
graph TD
    UI[AddFeedFragment / OnlineSearchFragment] --> Registry[PodcastSearcherRegistry]
    Registry --> Combined[CombinedSearcher (Weight: 0.0)]
    Registry --> iTunes[ItunesPodcastSearcher (Weight: 1.0)]
    Registry --> PodcastIndex[PodcastIndexPodcastSearcher (Weight: 1.0)]
    Registry --> Fyyd[FyydPodcastSearcher (Weight: 0.0)]
    Registry -. Historical .-> Gpodder[GpodnetPodcastSearcher (Removed in #7047)]
    
    Combined -->|Parallel Reactive Fetch| iTunes
    Combined -->|Parallel Reactive Fetch| PodcastIndex
    Combined -->|Harmonic Rank Merge & Deduplicate| UI
```

### 1.1 Apple Podcasts / iTunes Search & Top Charts

**Implementation Files:**
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/ItunesPodcastSearcher.java`
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/ItunesTopListLoader.java`

#### 1.1.1 Podcast Search API
* **Endpoint URL:** `https://itunes.apple.com/search?media=podcast&term=%s`
* **Query Encoding:** `URLEncoder.encode(query, "UTF-8")`
* **HTTP Method:** `GET`
* **Client:** Standard `AntennapodHttpClient.getHttpClient()` (OkHttp)
* **Response Format:** JSON object containing a `results` array.
* **Result Field Mapping:**
  | Search Result Field | JSON Source Property | Fallback |
  | :--- | :--- | :--- |
  | `title` | `collectionName` | `"Unknown"` |
  | `imageUrl` | `artworkUrl100` | `""` |
  | `feedUrl` | `feedUrl` | Skipped if absent (`!podcastJson.has("feedUrl")`) |
  | `author` | `artistName` | `"Unknown"` |

#### 1.1.2 URL Scheme & Apple Podcast ID Lookup
* **Needs Lookup Detection (`urlNeedsLookup`):**
  Matches if `url.contains("itunes.apple.com")` or matches regex:
  ```regex
  .*/podcasts\.apple\.com/.*/podcast/.*/id(\d+).*
  ```
* **ID Extraction & Lookup URL:**
  Extracts capture group 1 (`id`) and calls:
  `https://itunes.apple.com/lookup?id={id}`
* **Response Handling & Search Fallback:**
  Reads JSON `results[0].feedUrl`. If `feedUrl` is missing, throws `FeedUrlNotFoundException(artistName, trackName)`.
  - **AntennaPod Fallback (`OnlineFeedViewActivity.java:197-230`):**
    When `lookupUrl()` throws `FeedUrlNotFoundException`, AntennaPod catches it in `tryToRetrieveFeedUrlBySearch()`:
    1. Instantiates `CombinedSearcher` and searches for `trackName + " " + artistName`.
    2. Iterates over results looking for an exact, case-insensitive match on both author and title:
       `result.author.equalsIgnoreCase(artistName) && result.title.equalsIgnoreCase(trackName)`.
    3. If matched, uses `result.feedUrl` to resolve the podcast without failing.
    4. If no exact match is found, presents `showNoPodcastFoundError()`.

#### 1.1.3 Top Charts / Top Podcasts Loader (`ItunesTopListLoader`)
* **Endpoint URL:**
  `https://itunes.apple.com/%s/rss/toppodcasts/limit=25/explicit=true/json`
  where `%s` is a 2-letter ISO country code.
* **Country Resolution:**
  - If `country` is unset (`"99"` / `COUNTRY_CODE_UNSET`), defaults to `Locale.getDefault().getCountry()`.
  - **Fallback Rule:** If the top list request throws `IOException`, AntennaPod falls back to `"US"` **only if** `country == COUNTRY_CODE_UNSET` (`"99"`). If the user explicitly selected a non-default country and that country's request fails (e.g. HTTP 400 "iTunes does not have data for the selected country"), the exception is re-thrown and no fallback to `"US"` occurs.
* **Caching:** Uses OkHttp `CacheControl.Builder().maxStale(1, TimeUnit.DAYS).build()`.
* **Response Format & Mapping:**
  JSON hierarchy `feed.entry[]`:
  - `title`: `entry["im:name"]["label"]`
  - `imageUrl`: Iterates `entry["im:image"]`, selects first where attribute `height` >= 100, extracts `label`.
  - `feedUrl`: Temporary lookup URL: `"https://itunes.apple.com/lookup?id=" + entry["id"]["attributes"]["im:id"]`.
  - `author`: `entry["im:artist"]["label"]` (nullable fallback).
* **De-duplication Against Subscribed Feeds:**
  `removeSubscribed(suggestedPodcasts, subscribedFeeds, limit)` compares `subscribedFeed.getTitle().trim()` against `suggested.title.trim()` and filters out already-subscribed podcasts before returning up to `limit` entries.

---

### 1.2 PodcastIndex.org Searcher

**Implementation Files:**
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/PodcastIndexPodcastSearcher.java`
- `net/discovery/build.gradle`

#### 1.2.1 Search API Endpoint
* **Endpoint URL:** `https://api.podcastindex.org/api/1.0/search/byterm?q=%s`
* **Query Encoding:** `URLEncoder.encode(query, "UTF-8")`
* **HTTP Method:** `GET`
* **Response Format:** JSON object containing a `feeds` array.
* **Result Field Mapping:**
  | Search Result Field | JSON Source Property | Fallback |
  | :--- | :--- | :--- |
  | `title` | `title` | `"Unknown"` |
  | `imageUrl` | `image` | `""` |
  | `feedUrl` | `url` | Skipped if absent (`!podcastJson.has("url")`) |
  | `author` | `author` | `"Unknown"` |

#### 1.2.2 Cryptographic Authentication Headers (SHA-1)
PodcastIndex requires a time-windowed SHA-1 hash for authentication.
* **Header Calculation:**
  ```java
  Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
  calendar.clear();
  calendar.setTime(new Date());
  long secondsSinceEpoch = calendar.getTimeInMillis() / 1000L;
  String apiHeaderTime = String.valueOf(secondsSinceEpoch);
  String data4Hash = apiKey + apiSecret + apiHeaderTime;
  String hashString = sha1(data4Hash);
  ```
* **Required HTTP Headers:**
  - `X-Auth-Date`: UTC Unix timestamp in seconds (e.g. `"1761824000"`).
  - `X-Auth-Key`: The API key.
  - `Authorization`: Hexadecimal lowercase SHA-1 digest of `apiKey + apiSecret + apiHeaderTime`.
  - `User-Agent`: AntennaPod user agent string.

#### 1.2.3 Build Configuration & Fallback Keys
In `net/discovery/build.gradle`, AntennaPod injects the credentials via Gradle `BuildConfig`:
```groovy
defaultConfig {
    if (project.hasProperty("podcastindexApiKey")) {
        buildConfigField "String", "PODCASTINDEX_API_KEY", '"' + podcastindexApiKey + '"'
        buildConfigField "String", "PODCASTINDEX_API_SECRET", '"' + podcastindexApiSecret + '"'
    } else {
        // Public fallback keys embedded in open-source repo
        buildConfigField "String", "PODCASTINDEX_API_KEY", '"XTMMQGA2YZ4WJUBYY4HK"'
        buildConfigField "String", "PODCASTINDEX_API_SECRET", '"XAaAhk4^2YBsTE33vdbwbZNj82ZRLABDDqFdKe7x"'
    }
}
```
*Note for MiniPod:* MiniPod can safely use either custom developer properties or the public open-source credentials as a graceful default.

---

### 1.3 fyyd Searcher

**Implementation File:**
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/FyydPodcastSearcher.java`

* **Endpoint URL:** `https://api.fyyd.de/0.2/search/podcast?title=%s&count=10`
* **Query Encoding:** `URLEncoder.encode(query, "UTF-8")`
* **HTTP Method:** `GET`
* **URL Needs Lookup:** `false` (Direct RSS feeds provided)
* **Response Format:** JSON object with a `data` array.
* **Result Field Mapping:**
  | Search Result Field | JSON Source Property | Fallback |
  | :--- | :--- | :--- |
  | `title` | `title` | `"Unknown"` |
  | `imageUrl` | `thumbImageURL` | `""` |
  | `feedUrl` | `xmlURL` | `""` |
  | `author` | `author` | `"Unknown"` |

---

### 1.4 gpodder.net Directory & Search

**Implementation Files:**
- `net/sync/gpoddernet/src/main/java/de/danoeh/antennapod/net/sync/gpoddernet/GpodnetService.java`
- Historical: `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/GpodnetPodcastSearcher.java` (Commit `4e47691e7~1`)

#### 1.4.1 gpodder.net Search Endpoint
* **Endpoint URL:** `https://gpodder.net/search.json?q={query}` (optional: `&scale_logo={1..256}`)
* **HTTP Method:** `GET`
* **Response Structure:** JSON array of podcast objects:
  ```json
  [
    {
      "title": "Podcast Title",
      "url": "https://example.com/feed.xml",
      "description": "Show notes...",
      "subscribers": 1420,
      "logo_url": "https://example.com/logo.jpg",
      "author": "Host Name"
    }
  ]
  ```
* **Toplist Endpoint (Historical):** `https://gpodder.net/toplist/50.json`

#### 1.4.2 Deprecation & Fallback Analysis in AntennaPod
1. **Commit `5448e1f39` ("Remove gpodder toplist"):** AntennaPod removed the gpodder toplist because majority of the links were dead or uncurated.
2. **Commit `4e47691e7` ("Remove gpodder search (#7047)"):** AntennaPod removed `GpodnetPodcastSearcher` from discovery UI because gpodder.net server search frequently returned HTTP 500 or broken feeds.
3. **Current Status in AntennaPod:** gpodder.net synchronization remains in `:net:sync:gpoddernet` (`GpodnetService`), but discovery search is disabled/unregistered in `PodcastSearcherRegistry`.
4. **Architectural Recommendation for MiniPod:** Support gpodder.net search as an optional/legacy fallback provider, but keep its weight at `0.0f` or disabled by default in federated search to prevent latency spikes and HTTP 500 timeouts.

---

### 1.5 CombinedSearcher (Federated Search & Deduplication)

**Implementation Files:**
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/CombinedSearcher.java`
- `net/discovery/src/main/java/de/danoeh/antennapod/net/discovery/PodcastSearcherRegistry.java`

#### 1.5.1 Provider Registry & Weights
In `PodcastSearcherRegistry.getSearchProviders()`:
| Provider | Class | Default Weight | Active in Combined |
| :--- | :--- | :--- | :--- |
| **Combined** | `CombinedSearcher` | `0.0f` | No (self-excluded) |
| **Apple Podcasts** | `ItunesPodcastSearcher` | `1.0f` | **Yes** |
| **PodcastIndex** | `PodcastIndexPodcastSearcher` | `1.0f` | **Yes** |
| **fyyd** | `FyydPodcastSearcher` | `0.0f` | No (weight <= 0.00001f) |

#### 1.5.2 Parallel Execution Architecture
* Executes each active provider asynchronously via RxJava `Single` on `Schedulers.io()`.
* Tracks completion using a `CountDownLatch(providerCount)`.
* Individual provider failures (`onError`) are caught, logged, and still count down the latch without cancelling peer searchers.
* Cancellation: `doOnDispose()` immediately disposes all underlying provider network subscriptions.

#### 1.5.3 Ranking & Deduplication Algorithm
The federated search merges results into a single ranking map keyed by `feedUrl`:
1. `resultRanking` map (`HashMap<String, Float>`) stores accumulated score.
2. `urlToResult` map (`HashMap<String, PodcastSearchResult>`) stores the result object.
3. For each provider with `providerPriority > 0`:
   For each item at 0-indexed `position`:
   $$\text{scoreIncrement} = \frac{1.0}{\text{position} + 1.0}$$
   $$\text{ranking}(feedUrl) = \left(\text{previousRanking} + \text{scoreIncrement}\right) \times \text{providerPriority}$$
4. Feeds appearing in multiple engines (e.g. #1 in Apple and #2 in PodcastIndex) naturally accumulate scores.
5. Sorts descending by aggregate float score and emits the deduplicated list.

---

## 2. Feed Ingestion & Parsing Protocols (`parser/feed/`)

AntennaPod's feed engine is a streaming SAX/Pull parser capable of handling multi-megabyte feeds with minimal heap allocation.

```mermaid
graph TD
    InputURL[Feed URL or Website URL] --> PreCheck[UrlChecker.prepareUrl]
    PreCheck --> Downloader[HttpDownloader / OkHttp]
    Downloader --> Redirects[RedirectChecker 301/308 / Perm Redirect]
    Downloader --> BasicAuth[BasicAuthorizationInterceptor ISO-8859-1 -> UTF-8]
    Downloader --> FileCached[Local Downloaded Feed File]
    FileCached --> TypeGet[TypeGetter: Inspect Root Element]
    TypeGet -->|feed tag| Atom[Atom 1.0 Namespace]
    TypeGet -->|rss tag v2.0/0.91| RSS[RSS 2.0 Namespace]
    TypeGet -->|html tag| HTMLDiscover[FeedDiscoverer: HTML link rel=alternate]
    
    RSS --> Namespaces[Namespace Registry]
    Atom --> Namespaces
    Namespaces --> itunes[itunes: DTD]
    Namespaces --> podcast[podcast: Podcasting 2.0]
    Namespaces --> media[media: MRSS]
    Namespaces --> psc[psc: SimpleChapters]
    Namespaces --> content[content: Encoded]
    Namespaces --> dc[dc: Dublin Core]
```

### 2.1 Feed Type Detection & Parsing Pipeline

**Implementation Files:**
- `parser/feed/src/main/java/de/danoeh/antennapod/parser/feed/FeedHandler.java`
- `parser/feed/src/main/java/de/danoeh/antennapod/parser/feed/util/TypeGetter.java`
- `parser/feed/src/main/java/de/danoeh/antennapod/parser/feed/SyndHandler.java`

1. **Stream Encoding:** Uses Apache Commons `XmlStreamReader` to automatically resolve BOM and XML encoding headers (`<?xml encoding="..."?>`).
2. **Type Determination (`TypeGetter`):**
   Uses `XmlPullParser` on the first few tags:
   - Root `<feed>` $\rightarrow$ `Type.ATOM` (sets `Feed.TYPE_ATOM1`, extracts `xml:lang`).
   - Root `<rss>`:
     - `version == null` or `version == "2.0"` $\rightarrow$ `Type.RSS20` (`Feed.TYPE_RSS2`).
     - `version == "0.91"` or `"0.92"` $\rightarrow$ `Type.RSS091`.
   - Root `<rdf:RDF>` (RSS 1.0 / RDF): **Not supported by upstream AntennaPod** (`TypeGetter.java` has no `RDF` case and throws `UnsupportedFeedtypeException("RDF", null)` in the `default` branch). *MiniPod Design Note:* MiniPod can optionally add a guarded parser for RDF/RSS 1.0 using standard RSS 2.0 channel/item extraction.
   - Root `<html>` or non-feed tag $\rightarrow$ Invokes `throwExceptionIfWebsite()` using Jsoup to extract `<title>` and throw `UnsupportedFeedtypeException("html", "Website title: ...")`, triggering HTML feed discovery.
3. **SAX Parsing (`SyndHandler`):**
   `SyndHandler` maintains a `tagstack` (`Stack<SyndElement>`), a `defaultNamespaces` stack, and a registered `namespaces` map.

---

### 2.2 XML Namespaces & Tag Specification

#### 2.2.1 RSS 2.0 (`Rss20.java`)
Default namespace for `<rss>` documents.
* `<channel>`: Feed container.
  - `<title>`: Sanitized via `HtmlCompat.fromHtml(..., FROM_HTML_MODE_COMPACT)`.
  - `<link>`: Website URL.
  - `<description>`: Feed summary.
  - `<language>`: Lowercased locale string.
  - `<image><url>`: Fallback cover image (if `itunes:image` not present).
* `<item>`: Episode container.
  - `<guid>`: Unique item identifier (`itemIdentifier`).
  - `<title>`: Falls back to description if `<title>` tag is absent.
  - `<link>`: Episode web page URL.
  - `<pubDate>`: Parsed via `DateUtils.parseOrNullIfFuture(content)`.
  - `<description>`: Plaintext/HTML show notes (`setDescriptionIfLonger`).
  - `<enclosure url="..." length="..." type="...">`: Media enclosure. Ignores suspiciously small enclosures (< 16,384 bytes). Auto-assigns `audio/*` if MIME type is unrecognized or ambiguous.

#### 2.2.2 Atom 1.0 (`Atom.java` — `http://www.w3.org/2005/Atom`)
* `<feed>`: Feed root.
  - `<id>`: Unique feed identifier.
  - `<title>`: Feed title (supports text/html types via `AtomText`).
  - `<subtitle>`: Feed description.
  - `<logo>`, `<icon>`: Feed cover image.
  - `<author><name>`: Feed author.
* `<entry>`: Episode item.
  - `<id>`: Unique item identifier.
  - `<title>`: Episode title.
  - `<summary>`, `<content>`: Episode show notes.
  - `<published>`, `<updated>`: Publication timestamps.
* `<link>` Handling:
  - `rel="alternate"` (or absent): Feed/episode website URL. If `type="application/rss+xml"` or `type="application/atom+xml"`, registered as an alternate/archive feed URL.
  - `rel="enclosure"`: Media attachment (`href`, `length`, `type`).
  - `rel="payment"`: Monetization link (`FeedFunding`).
  - `rel="next"`: Paged feeds (`setPaged(true)`, `setNextPageLink(href)`).

#### 2.2.3 iTunes Podcast Namespace (`Itunes.java`)
* **Namespace URIs:**
  - Standard: `http://www.itunes.com/dtds/podcast-1.0.dtd`
  - Legacy: `http://www.itunes.com/DTDs/Podcast-1.0.dtd`
* **Elements:**
  - `<itunes:image href="...">`: Preferred high-resolution feed and episode artwork.
  - `<itunes:author>`: Artist/author name.
  - `<itunes:duration>`: Formats `HH:MM:SS`, `MM:SS`, or raw seconds; converted to milliseconds via `DurationParser.inMillis()`.
  - `<itunes:subtitle>` / `<itunes:summary>`: Episode description fallbacks.
  - `<itunes:new-feed-url>`: Feed relocation pointer. Sets `state.redirectUrl` to permanently migrate the subscription URL.

#### 2.2.4 Podcasting 2.0 Namespace (`PodcastIndex.java`)
* **Namespace URIs:**
  - `https://podcastindex.org/namespace/1.0`
  - `https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md`
* **Elements:**
  - `<podcast:funding url="...">`: Creator support/donation URL and call-to-action text.
  - `<podcast:chapters url="..." type="application/json">`: URL pointing to external Podcasting 2.0 JSON chapters.
  - `<podcast:transcript url="..." type="...">`: URL for subtitle/transcript files (`text/vtt`, `application/x-subrip`, `application/json`, `text/html`).
  - `<podcast:socialInteract uri="...">`: ActivityPub / comments link for the episode.

#### 2.2.5 Additional Supported Namespaces
* **Content Module (`Content.java` — `http://purl.org/rss/1.0/modules/content/`):**
  - `<content:encoded>`: Unescaped full HTML show notes. Applied via `setDescriptionIfLonger()` to avoid overwriting rich notes with short RSS descriptions.
* **Media RSS / Yahoo MRSS (`Media.java` — `http://search.yahoo.com/mrss/`):**
  - `<media:content url="..." fileSize="..." type="..." duration="..." isDefault="..." medium="audio|video|image">`: Alternative media enclosure parsing.
  - `<media:thumbnail url="...">`: Episode thumbnail image.
* **Podlove Simple Chapters (`SimpleChapters.java` — `http://podlove.org/simple-chapters`):**
  - Prefixes: `psc|sc`
  - `<psc:chapters>` $\rightarrow$ `<psc:chapter start="..." title="..." href="..." image="...">`
* **Dublin Core (`DublinCore.java` — `http://purl.org/dc/elements/1.1/`):**
  - `<dc:date>`: Standard ISO-8601 publication date parsing.

---

### 2.3 HTML Feed Auto-Discovery (`FeedDiscoverer.java`)

**Implementation File:**
- `app/src/main/java/de/danoeh/antennapod/ui/screen/onlinefeedview/FeedDiscoverer.java`

When a user pastes a standard website URL (e.g. `https://relay.fm/cortex`) instead of an RSS URL:
1. AntennaPod parses the document using Jsoup: `document.head().getElementsByTag("link")`.
2. Inspects `<link>` tags matching:
   - `rel="alternate"` OR `rel="feed"`
   - `type="application/rss+xml"` OR `type="application/atom+xml"`
3. Resolves relative URLs (`href="/feed.xml"`) against `baseUrl` via `Uri.parse(baseUrl).buildUpon().path(href).build()`.
4. Returns `Map<String, String>` mapping resolved Feed URL $\rightarrow$ Feed Title (falls back to URL if `title` attribute is blank).

---

### 2.4 URL Normalization, Schemes, & Redirect Handling

**Implementation Files:**
- `net/common/src/main/java/de/danoeh/antennapod/net/common/UrlChecker.java`
- `net/common/src/main/java/de/danoeh/antennapod/net/common/RedirectChecker.java`

#### 2.4.1 URL Protocol Normalization (`UrlChecker.prepareUrl`)
AntennaPod sanitizes arbitrary input strings into standard HTTP(S) URLs:
| Raw URL Scheme / Prefix | Transformation | Output Example |
| :--- | :--- | :--- |
| `feed://example.com/rss` | Replace `feed://` with `http://` | `http://example.com/rss` |
| `pcast://example.com/rss` | Remove `pcast://` | `http://example.com/rss` |
| `pcast:example.com/rss` | Remove `pcast:` | `http://example.com/rss` |
| `itpc://example.com/rss` | Replace `itpc://` with `http://` | `http://example.com/rss` |
| `antennapod-subscribe://https://...` | Remove `antennapod-subscribe://` | `https://...` |
| `antennapod.org/deeplink/subscribe?url={enc}` | Extract & URL-decode query param `url` | Decoded target URL |
| `subscribeonandroid.com/{url}` | Strip prefix | Cleaned target URL |
| `//example.com/rss` (Protocol-relative) | Prepend base URL scheme | `https://example.com/rss` |
| `example.com/rss` (No scheme) | Prepend `http://` | `http://example.com/rss` |

#### 2.4.2 HTTP 301/308 Permanent Redirect Updates (`RedirectChecker`)
* **Detection:** Inspects OkHttp's response history chain (`response.priorResponse()`).
* **Condition:**
  - Status code is `301` (`HTTP_MOVED_PERM`) or `308` (`HTTP_PERM_REDIRECT`).
  - OR: Non-permanent redirect from `http://` to identical `https://` endpoint is automatically treated as permanent.
* **Action:**
  The new target URL is returned as `permanentRedirectUrl` and immediately saved to `feed.setDownload_url(newUrl)` in SQLite. This ensures AntennaPod never repeatedly hits dead redirect chains.

---

### 2.5 HTTP Basic Auth Protected Feeds & Enclosures

**Implementation Files:**
- `net/common/src/main/java/de/danoeh/antennapod/net/common/BasicAuthorizationInterceptor.java`
- `net/common/src/main/java/de/danoeh/antennapod/net/common/HttpCredentialEncoder.java`
- `net/common/src/main/java/de/danoeh/antennapod/net/common/AntennapodHttpClient.java`

#### 2.5.1 Dual-Stage Interceptor Pipeline
OkHttp is configured with `BasicAuthorizationInterceptor`:
1. Requests proceed normally. If server returns `401 Unauthorized`:
2. Credentials are extracted:
   - First checked from URI `userInfo` (e.g. `https://alice:secret@example.com/feed.xml`).
   - If empty, checked from `DownloadRequest.getUsername()` and `getPassword()` stored in SQLite `FeedPreferences`.
3. **Charset Fallback:**
   - **Step 1:** Encodes credentials using `ISO-8859-1` base64 (`HttpCredentialEncoder.encode(user, pass, "ISO-8859-1")`) and re-issues request.
   - **Step 2:** If HTTP 401 persists, re-issues request with `UTF-8` base64 credentials.
4. **Redirect Header Preservation:**
   OkHttp drops `Authorization` headers when following cross-domain or protocol redirects. The interceptor detects URL discrepancy (`!response.request().url().equals(request.url())`) and explicitly re-injects the `Authorization` header to the final redirected endpoint.

---

### 2.6 OPML 1.0 & 2.0 Import & Export

**Implementation Files:**
- `storage/importexport/src/main/java/de/danoeh/antennapod/storage/importexport/OpmlReader.java`
- `storage/importexport/src/main/java/de/danoeh/antennapod/storage/importexport/OpmlWriter.java`
- `storage/importexport/src/main/java/de/danoeh/antennapod/storage/importexport/OpmlElement.java`
- `storage/importexport/src/main/java/de/danoeh/antennapod/storage/importexport/OpmlSymbols.java`

#### 2.6.1 OPML Reader (`OpmlReader.java`)
* Parses XML stream using `XmlPullParser`.
* Identifies `<opml>` root and traverses `<outline>` elements.
* Extracted Attributes:
  - `text` / `title`: Title of the podcast (prefers `title`, falls back to `text`, falls back to `xmlUrl`).
  - `xmlUrl`: RSS/Atom subscription URL (required; skips element if missing).
  - `htmlUrl`: Podcast homepage URL.
  - `type`: Usually `"rss"`.

#### 2.6.2 OPML Writer (`OpmlWriter.java`)
* Serializes subscribed feeds using `XmlSerializer` with UTF-8 encoding.
* Output Specification:
  ```xml
  <?xml version='1.0' encoding='UTF-8' standalone='no' ?>
  <opml version="2.0">
    <head>
      <title>AntennaPod Subscriptions</title>
      <dateCreated>30 Oct 26 19:30:00 +0800</dateCreated>
    </head>
    <body>
      <outline text="Podcast Title" title="Podcast Title" type="rss" 
               xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com" />
    </body>
  </opml>
  ```
* Skips feeds whose state is not `Feed.STATE_SUBSCRIBED`.

---

### 2.7 Local Folder Virtual Feeds (`LocalFeedUpdater.java`)

**Implementation File:**
- `net/download/service/src/main/java/de/danoeh/antennapod/net/download/service/feed/local/LocalFeedUpdater.java`

AntennaPod allows subscribing to an arbitrary local Android directory or USB drive as if it were a podcast feed using the Storage Access Framework (SAF).

1. **Virtual Feed URL Scheme:**
   `feed.getDownloadUrl()` starts with `Feed.PREFIX_LOCAL_FOLDER` (`"local-folder:"`), followed by the tree URI string:
   `local-folder:content://com.android.externalstorage.documents/tree/primary%3APodcasts`
2. **Directory Traversal:**
   Resolves `DocumentFile.fromTreeUri(context, uri)`. Uses `FastDocumentFile.list()` for high-performance file listing without individual Binder IPC calls.
3. **Media Filtering:**
   Inspects MIME types via `MimeTypeUtils.getMimeType()`:
   Filters for `MediaType.AUDIO` or `MediaType.VIDEO`.
4. **Virtual Episode Generation & Rescan Reconciliation:**
   For each media file (`createFeedItem`):
   - `itemIdentifier`: Initialized to a freshly generated UUID (`UUID.randomUUID().toString()`).
   - `link`: Stores the plain filename (`file.getName()`).
   - **Rescan Matching:** To reconcile files across folder refreshes without duplicating items or losing playback history, `feedContainsFile(feed, filename)` inspects existing items:
     An existing item is matched if `i.getMedia() != null && i.getLink().equals(filename)`.
   - **Metadata Caching:** If an existing item matches `file.getUri().toString()` and has identical `file.getLength() == existingItem.getMedia().getSize()`, AntennaPod re-uses the existing item's metadata without re-parsing (`item.updateFromOther(existingItem)`).
   - **Primary Metadata Extraction (`MediaMetadataRetrieverCompat`):**
     - `title`: `METADATA_KEY_TITLE` (falls back to filename without extension via `FilenameUtils.removeExtension(file.getName())`).
     - `pubDate`: `METADATA_KEY_DATE` parsed with format `yyyyMMdd'T'HHmmss` or `DateUtils.parse(dateStr)` (ignores default placeholder `"19040101T000000.000Z"`).
     - `duration`: `METADATA_KEY_DURATION` in milliseconds.
     - `hasEmbeddedPicture`: `mediaMetadataRetriever.getEmbeddedPicture() != null`.
   - **Description Extraction (ID3 / Vorbis / M4A Readers):**
     Custom media readers are invoked *strictly* to populate episode show notes/descriptions via `setDescriptionIfLonger()`:
     1. `Id3MetadataReader`: Extracts comment (`reader.getComment()`).
     2. `VorbisCommentMetadataReader`: Extracts description (`reader.getDescription()`).
     3. `M4AMetadataReader`: Extracts description (`reader.getDescription()`).
5. **Feed Cover Resolution:**
   Searches folder for images in order of preference:
   1. `folder.jpg` / `Folder.jpg`
   2. `folder.png` / `Folder.png`
   3. First image file with MIME `image/jpeg` or `image/png`.
   4. Fallback: Generates a vector cover with prefix `Feed.PREFIX_GENERATIVE_COVER` (`"generative-cover:"`).
6. **Constraint:**
   Auto-download is permanently set to `FeedPreferences.AutoDownloadSetting.DISABLED` because files are already local.

---

## 3. Playback & Chapter Formats

```mermaid
graph TD
    MediaSource[Media Source: Audio/Video Stream or Local File] --> FormatDetect[MediaFormatDetector: Magic Bytes Sniffing]
    FormatDetect -->|ID3 Header| ID3[ChapterReader: CHAP / TIT2 / WXXX / APIC]
    FormatDetect -->|OggS Header| Vorbis[VorbisCommentChapterReader: CHAPTERxxx]
    FormatDetect -->|ftyp Atom| M4A[M4AChapterReader: moov.udta.chpl]
    
    FeedXML[RSS XML Feed] -->|psc:chapters| PSC[SimpleChapters Namespace]
    FeedXML -->|podcast:chapters url| Pod20[PodcastIndexChapterParser JSON]
    
    PSC --> MergerPhase1[ChapterMerger: Phase 1]
    ID3 --> MergerPhase1
    Vorbis --> MergerPhase1
    M4A --> MergerPhase1
    
    MergerPhase1 --> MergerPhase2[ChapterMerger: Phase 2]
    Pod20 --> MergerPhase2
    MergerPhase2 --> FinalChapters[Final Ordered Chapter List]
```

### 3.1 Media Enclosure Streaming & Byte-Range Handling

**Implementation Files:**
- `playback/service/src/main/java/de/danoeh/antennapod/playback/service/internal/ExoPlayerWrapper.java`
- `playback/service/src/main/java/de/danoeh/antennapod/playback/service/internal/LocalPSMP.java`
- `net/download/service/src/main/java/de/danoeh/antennapod/net/download/service/feed/remote/HttpDownloader.java`

#### 3.1.1 ExoPlayer / Media3 Streaming Configuration
* **Cleartext Traffic Declaration:** AntennaPod declares `android:usesCleartextTraffic="true"` in `app/src/main/AndroidManifest.xml:38`. On Android 9+ (API 28+), Android blocks unencrypted `http://` traffic by default. Because hundreds of legacy podcast feeds, MP3 enclosures, and redirected CDN endpoints remain exclusively on HTTP, this manifest flag is strictly required to prevent playback network security policy failures.
* **Media3 Integration:** AntennaPod uses AndroidX Media3 ExoPlayer.
* **HTTP Data Source:** `DefaultHttpDataSource.Factory` configured with:
  - Custom `User-Agent`
  - `setAllowCrossProtocolRedirects(true)`
  - `setKeepPostFor302Redirects(true)`
* **HTTP Basic Auth Streaming:**
  When media requires credentials, sets `Authorization: Basic ...` on `DefaultHttpDataSource`:
  ```java
  requestProperties.put("Authorization", HttpCredentialEncoder.encode(user, password, "ISO-8859-1"));
  httpDataSourceFactory.setDefaultRequestProperties(requestProperties);
  ```
* **Local Chunk Caching:** Wraps HTTP data source in `CacheDataSource.Factory` backed by `SimpleCache` and `LeastRecentlyUsedCacheEvictor` to prevent re-fetching audio segments during seeking.
* **Extractor Configuration:**
  - `ProgressiveMediaSource.Factory` with `DefaultExtractorsFactory`.
  - `setConstantBitrateSeekingEnabled(true)`: Enables seeking within constant and variable bitrate MP3/AAC streams even without an explicit index table.
  - `setMp3ExtractorFlags(Mp3Extractor.FLAG_DISABLE_ID3_METADATA)`: Prevents ExoPlayer from spending cycles parsing ID3 metadata because AntennaPod parses chapters and metadata directly.

#### 3.1.2 Byte-Range Download Resumption (`HttpDownloader.java`)
When downloading podcast episodes:
* If destination file exists:
  - Adds header: `Range: bytes={destination.length()}-`
  - Adds header: `If-Range: {lastModified_or_ETag}`
* Server returns HTTP `206 Partial Content` with `Content-Range: bytes {start}-{end}/{total}`.
* Downloader appends incoming bytes to `FileOutputStream(destination, true)`.

---

### 3.2 Chapter Formats & Parsers

AntennaPod supports 5 distinct chapter formats spanning in-band audio metadata, XML feed elements, and external JSON documents:

| Chapter Format | Location | Specification / Standard | Parser Class |
| :--- | :--- | :--- | :--- |
| **ID3v2 Chapters** | Embedded MP3 | [id3v2-chapters-1.0](https://id3.org/id3v2-chapters-1.0) (`CHAP`, `CTOC`) | `ChapterReader.java` |
| **Vorbis Comments** | Embedded Ogg/Opus | `CHAPTERxxx`, `CHAPTERxxxNAME`, `CHAPTERxxxURL` | `VorbisCommentChapterReader.java` |
| **MP4 / Nero Chapters** | Embedded M4A/AAC | MPEG-4 atom `moov.udta.chpl` | `M4AChapterReader.java` |
| **Podlove Simple Chapters**| RSS/Atom XML | `<psc:chapters>` / `<psc:chapter>` | `SimpleChapters.java` |
| **Podcasting 2.0 Chapters**| External HTTP JSON | [Podcasting 2.0 Chapters Spec](https://github.com/Podcastindex-org/podcast-namespace) | `PodcastIndexChapterParser.java` |

#### 3.2.1 Format Sniffing (`MediaFormatDetector.java`)
Reads the first 64 bytes of the audio stream to determine format without relying on file extensions:
- Bytes `0..2` == `0x49 0x44 0x33` (`"ID3"`) $\rightarrow$ `Format.ID3`
- Bytes `0..3` == `0x4F 0x67 0x67 0x53` (`"OggS"`) $\rightarrow$ `Format.OGG`
- Bytes `0..3` == `0x66 0x4C 0x61 0x43` (`"fLaC"`) $\rightarrow$ `Format.FLAC`
- Bytes `4..7` == `0x66 0x74 0x79 0x70` (`"ftyp"`) $\rightarrow$ `Format.M4A`

#### 3.2.2 Embedded ID3v2 Chapters (`ChapterReader.java`)
- Reads frame `CHAP`:
  - `elementId`: Null-terminated ISO-8859-1 string.
  - `startTime`: 4-byte big-endian integer (milliseconds).
  - Skips 12 bytes (`endTime`, `startOffset`, `endOffset`).
  - Iterates sub-frames:
    - `TIT2`: Chapter title string.
    - `WXXX`: User-defined URL link (decoded).
    - `APIC`: Embedded or linked chapter artwork. If `mime == "-->"`, reads image URL link; otherwise extracts raw byte offset via `EmbeddedChapterImage.makeUrl(offset, length)`.

#### 3.2.3 Embedded Vorbis Comment Chapters (`VorbisCommentChapterReader.java`)
- Regex matches comment keys matching `chapter\d\d\d.*`:
  - `CHAPTER001=00:00:00.000` $\rightarrow$ Start time (`HH:MM:SS.mmm`).
  - `CHAPTER001NAME=Introduction` $\rightarrow$ Chapter title.
  - `CHAPTER001URL=https://...` $\rightarrow$ Clickable URL.
- **Parsing Implementation & Quirk:**
  - Key ID extraction: `getIdFromKey` parses 3 digits via `Integer.parseInt(key.substring(CHAPTERXXX_LENGTH - 3, CHAPTERXXX_LENGTH))` where `CHAPTERXXX_LENGTH = "chapterxxx".length()` (10), effectively taking `key.substring(7, 10)`.
  - Timestamp parsing (`getStartTimeFromValue`): Splits by `:`. For seconds, it strips optional `-->` end offsets and computes:
    `TimeUnit.MILLISECONDS.convert(((long) Float.parseFloat(parts[2])), TimeUnit.SECONDS)`.
    *Note on Upstream Quirk:* The cast `((long) Float.parseFloat(...))` converts float seconds directly to integer seconds, which truncates sub-second millisecond fractions (e.g. `12.850` seconds becomes `12000 ms` instead of `12850 ms`). In MiniPod, it is recommended to preserve full millisecond accuracy (`(long)(Float.parseFloat(parts[2]) * 1000)`).

#### 3.2.4 Embedded MP4 / Nero Chapters (`M4AChapterReader.java`)
- Scans atoms for `moov.udta.chpl`:
  - Skips 5-byte Nero header (version, flags, reserved byte).
  - Reads 4-byte big-endian `chapterCount`.
  - For each chapter:
    - 8-byte `startTime` in 100-nanosecond units ($\text{startTime} / 10,000 = \text{milliseconds}$).
    - 1-byte `chapterNameSize`.
    - UTF-8 string bytes for title.

#### 3.2.5 Podlove Simple Chapters (`SimpleChapters.java`)
- XML elements in RSS feed:
  ```xml
  <psc:chapters version="1.2">
    <psc:chapter start="00:01:30.000" title="Topic One" href="https://example.com" image="https://example.com/art.jpg" />
  </psc:chapters>
  ```
- Parsed during feed download and stored in SQLite database (`chapters` table).

#### 3.2.6 Podcasting 2.0 JSON Chapters (`PodcastIndexChapterParser.java`)
- Referenced in feed XML: `<podcast:chapters url="https://example.com/chapters.json" type="application/json" />`
- Downloaded asynchronously when opening player or episode details:
  ```json
  {
    "version": "1.2.0",
    "chapters": [
      {
        "startTime": 0,
        "title": "Intro",
        "img": "https://example.com/ch1.png",
        "url": "https://example.com"
      },
      {
        "startTime": 120,
        "title": "Deep Dive"
      }
    ]
  }
  ```
- Note: AntennaPod reads `int startTime = jsonObject.optInt("startTime", 0)` and computes `startTime * 1000L`.
  *Note on Upstream Quirk:* The Podcasting 2.0 Chapters specification permits floating point seconds for `startTime` (e.g. `12.5` seconds). AntennaPod's `optInt` discards fractional seconds, rounding down to whole seconds. MiniPod should read `startTime` as a `Double` (`(long)(jsonObject.optDouble("startTime", 0.0) * 1000.0)`) to maintain millisecond precision.

---

### 3.3 Multi-Source Chapter Reconciliation & Merging Engine

**Implementation Files:**
- `ui/chapters/src/main/java/de/danoeh/antennapod/ui/chapters/ChapterUtils.java`
- `ui/chapters/src/main/java/de/danoeh/antennapod/ui/chapters/ChapterMerger.java`

An episode can have chapters declared in the RSS feed (Simple Chapters), embedded in the audio file (ID3/Vorbis/MP4), and hosted externally (Podcasting 2.0 JSON). AntennaPod executes a two-phase merge:

$$\text{Phase 1} = \text{ChapterMerger.merge}(\text{chaptersFromDatabase}, \text{chaptersFromMediaFile})$$
$$\text{Final Chapters} = \text{ChapterMerger.merge}(\text{Phase 1}, \text{chaptersFromPodcastIndex})$$

#### `ChapterMerger` Algorithm:
1. **Null/Empty Handling:** If one list is null or empty, returns the other list.
2. **Count Discrepancy:** If `listA.size() != listB.size()`, returns whichever list has **more** chapters (assumed to be higher resolution).
3. **Equal Count Alignment:**
   If both lists have identical size $N$:
   - Compares timestamps $\lvert \text{start}_A[i] - \text{start}_B[i] \rvert \le 1000\text{ ms}$.
   - If all timestamps align within 1 second: **Merges metadata!** Missing title, URL link, or chapter artwork in list B are filled in from list A.
   - If any timestamp differs by $> 1000\text{ ms}$: Cancels merge and selects the list with the higher quality score:
     $$\text{score}(\text{list}) = \sum_{c \in \text{list}} \left( [\text{hasTitle}(c)] + [\text{hasLink}(c)] + [\text{hasImage}(c)] \right)$$

---

## 4. Architectural Summary for MiniPod

To achieve 100% AntennaPod compatibility in MiniPod while maintaining an ultra-minimal codebase:

1. **Discovery Layer:**
   - Implement `PodcastDiscoveryRegistry` with `ItunesSearcher`, `PodcastIndexSearcher` (using public/default SHA-1 auth), and `CombinedSearcher` (harmonic rank merge).
   - Omit gpodder.net and fyyd by default to avoid slow/unreliable network requests, but keep them as pluggable adapters.
2. **Ingestion & Normalization Layer:**
   - Single unified SAX/streaming feed parser handling RSS 2.0, Atom 1.0, and namespaces (`itunes`, `podcast`, `psc`, `content`, `media`).
   - Implement `UrlChecker.prepareUrl` and `FeedDiscoverer` to allow users to paste arbitrary links, custom URL schemes (`feed://`, `itpc://`, `pcast://`), and webpage URLs.
   - Retain HTTP 301/308 permanent redirect rewriting to keep stored feed URLs fresh.
3. **Playback & Chapter Engine:**
   - Single progressive Media3 ExoPlayer instance with constant bitrate seeking enabled.
   - Dedicated chapter extraction combining embedded ID3/Vorbis/MP4 tags and Podcasting 2.0 JSON via `ChapterMerger`'s 1-second fuzzy alignment algorithm.
