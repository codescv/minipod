# Podcasts (`codescv/minipod`) — Integration, E2E, Cloud Sync, Auto-Updater & Android APK Test Report

- **Date**: 2026-10-31
- **Version Verified**: `0.1.6` (`dev.minipod.app`, `application-label: 'Podcasts'`, `versionCode 7`)
- **Live Repository & Release**:
  - Repository: <https://github.com/codescv/minipod> (`origin main` + tag `v0.1.6`)
  - Release `v0.1.6`: <https://github.com/codescv/minipod/releases/tag/v0.1.6>
  - Release API: `https://api.github.com/repos/codescv/minipod/releases/latest` (`200 OK`)
- **Environment**:
  - OS: Linux (`x86_64`)
  - Node.js: `v22.22.1` (built-in `node:sqlite`, Web Crypto, `CompressionStream`)
  - Package Manager: `pnpm 10.32.1` (`onlyBuiltDependencies: []`)
  - Browser Automation: Playwright Headless Chromium (`chrome-linux64` build `1223`)
  - Java / Android Toolchain: OpenJDK `21`, Android SDK `compileSdk 36` / `targetSdk 36` / `minSdk 26`, Gradle `8.14.3`, `build-tools 35.0.0` (`apksigner`, `aapt2`, `dexdump`)

---

## Executive Summary

| Verification Gate | Result | Summary |
| :--- | :---: | :--- |
| **1. Static Typecheck (`pnpm typecheck`)** | **PASS** | `0` errors across `@minipod/core`, `@minipod/ui`, `@minipod/host-node`, `@minipod/host-android` (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) |
| **2. Unit, Property & Integration Suite (`pnpm test`)** | **PASS** | **28 / 28 test files**, **117 / 117 tests passed** (incl. randomized multi-device CRDT property tests, `<podcast:images>` / `<item><image>` artwork parsing, `/api/image-proxy` RAM+disk cache & ETag `304`, gesture-first `EpisodeRow` & `QueueList` with live swipe edge hints, live item-following pointer-drag queue reorder with neighbor slot shifting, grid-only `SubscriptionsGrid` with top-right `subs-settings-btn`, conditional `Manage downloads` / `DownloadsPage`, `Podcasts` branding across `en` / `zh-CN` / `ja`, & cross-platform auto-updater suites) |
| **3. Zero-Native-Addon Gate (`pnpm check:native`)** | **PASS** | **0** `.node` binaries, **0** `binding.gyp`, **0** native build scripts across runtime tree |
| **4. Production Web + Server Bundles (`pnpm build`)** | **PASS** | Built `@minipod/host-node` (`dist/server.mjs` + `dist/web` with `favicon.svg`, `icon-light-192.png`, `icon-dark-192.png`) & `@minipod/host-android` (`www` with adaptive icons) |
| **5. Live Server & Playwright Browser E2E** | **PASS** | **98 / 98 end-to-end checks passed** (`39` core/UI/sync/updater E2E + `11` `v0.1.3` Timeline/Background/Artwork E2E + `12` `v0.1.4` `Podcasts` branding & 7A/7B adaptive icon E2E + `21` `v0.1.5` gesture `EpisodeRow`, pointer-drag `QueueList`, & conditional `Manage downloads` E2E + `15` `v0.1.6` swipe edge hints, live item-following queue drag reorder, removed queue overflow menu, grid-only Subscriptions + `subs-settings-btn`, & 3-layer artwork cache E2E checks; `[data-settings-row]` strictly `9`) |
| **6. Standalone Android APK (`v0.1.6`) & Adaptive Icon / Background Playback / Native Artwork Cache** | **PASS** | Built & verified `app-release.apk` / `minipod-v0.1.6.apk` (`7,125,400` bytes, `application-label:'Podcasts'`, `versionCode='7'`, `versionName='0.1.6'`, APK Signature v2, `BridgeWebViewClient.shouldInterceptRequest` native disk artwork cache, day/night `ic_launcher_background` `#F4F1EA` / `#18181B`, `ic_launcher_arcs` `#1C1917` / `#F4F4F5`, `ic_launcher_dot` `#FF4F00`, `ic_launcher_foreground_vector`, `ic_launcher_monochrome`, `mipmap-*` & `mipmap-night-*`) |
| **7. Live Public GitHub Repository & Release (`v0.1.6`)** | **PASS** | Published `main` + annotated tag `v0.1.6` + GitHub Release `v0.1.6` with `minipod-v0.1.6.apk`, `app-release.apk`, and `minipod-v0.1.6-pc.tar.gz` |

---

## 1. Unit, Property-Based CRDT & Package Integration Suite (`pnpm test`)

All **28 test suites (117 tests)** execute cleanly under Vitest `4.1.12`:

| Package | Test File | Tests | Key Coverage |
| :--- | :--- | :---: | :--- |
| `@minipod/core` | `src/discovery/discovery.test.ts` | 9 | `UrlNormalizer` (`feed://`, `pcast://`, `itpc://`, `antennapod-subscribe://`, `subscribeonandroid.com`), scheme-less SHA-1 `feedKey`, `ItunesSearcher` + `/lookup` + `FeedUrlNotFoundError`, `ItunesTopListLoader` (`'99'` -> `'US'` fallback vs explicit country error), `PodcastIndexSearcher` SHA-1 headers, `FyydSearcher`, `GpodderSearcher`, `CombinedSearcher` harmonic rank & dedup, `FeedUrlResolver` |
| `@minipod/core` | `src/feed/feed.test.ts` | 8 | `TypeDetector`, `SyndParser` across RSS 2.0 / 0.91, Atom 1.0 (incl. `rel="next"`, `<entry><logo>`/`<icon>`), RDF 1.0, `<itunes:*>`, `<podcast:images srcset>` / `<podcast:image>`, `<item><image><url>`, `<psc:chapters>`, `<content:encoded>`, whitespace `imageUrl` normalization, `DurationParser`, `DateUtils`, `HtmlFeedDiscoverer`, `OpmlCodec` |
| `@minipod/core` | `src/chapters/chapters.test.ts` | 6 | Format magic sniffing (`ID3`, `OGG`, `FLAC`, `MP4`), ID3v2.3/2.4 `CHAP`/`CTOC`/`TIT2`/`WXXX`/`APIC` byte-slice offsets, Ogg Opus & FLAC Vorbis `CHAPTERxxx` (incl. 3-digit IDs `>= 100` & float ms), MP4 `moov.udta.chpl` Nero chapters + trailing `moov` locate hint, `ChapterMerger` two-phase positional merge (`±1000 ms`) & quality scoring |
| `@minipod/core` | `src/http/http.test.ts` | 4 | `BasicAuth` ISO-8859-1 -> UTF-8 retry & cross-host redirect re-injection, `RedirectRecorder` (`301`/`308` & `http->https` permanent vs `302`/`307` temporary) |
| `@minipod/core` | `src/queue/queue.test.ts` | 3 | Base-62 LexoRank fractional indexing (`between`, `insertAtHead`, `insertAtTail`, midpoint non-collision over thousands of moves) & blank `imageUrl` fallback in `buildQueueStub` |
| `@minipod/core` | `src/progress/progress.test.ts` | 4 | 3-second resume rewind (`Math.max(0, pos - 3000)`), `< 30s` / `>= 97%` completion detection, playback speed clamping |
| `@minipod/core` | `src/sync/sync.test.ts` | 12 | `HybridLogicalClock` monotonicity & clock-skew clamping, `SyncEngine` subscription LWW + tombstone non-resurrection, permanent redirect aliasing, queue CRDT merge + tombstone GC (`90d`), progress monotonic/HLC rules, **randomized 3-device property-based commutativity/associativity/idempotence tests**, `WebDavProvider` (Basic + Digest + `412`), `GitHubGistProvider` (`ETag` + `>800KB` gzip/Base64 + truncated `raw_url`), `GoogleDriveProvider` (`appDataFolder` + duplicate self-healing), `SyncScheduler` |
| `@minipod/core` | `src/updater/updater.test.ts` | 6 | `parseSemver` / `compareSemver`, `parseGithubReleaseJson` (`minipod-*.apk` / `app-release.apk` + PC tarball asset extraction, draft filtering), `parseGithubReleasesAtom` XML parser, `fetchLatestRelease` (`/releases/latest` -> `/releases?per_page=5` -> `releases.atom` 403/429 fallback) |
| `@minipod/core` | `src/util/util.test.ts` | 9 | Pure-TS SHA-1, gzip/gunzip streams, Base64, URL credential stripping, allowlist HTML sanitizer (XSS `<script>`/`onerror`/`javascript:` stripping) |
| `@minipod/host-node` | `src/db/SqliteSyncStore.test.ts` | 2 | `node:sqlite` WAL migrations, `SqliteSyncStore` transactional snapshot/apply, synced queue stub materialization, permanent feed move re-keying |
| `@minipod/host-node` | `src/feeds/local-folder.test.ts` | 1 | Desktop `local-folder:` scanning, natural episode sort, embedded ID3/MP4 tag extraction, `folder.jpg` cover detection |
| `@minipod/host-node` | `src/net/fetcher.test.ts` | 3 | Manual redirect chain capture, Basic Auth ISO-8859-1/UTF-8 challenge retry, `maxBodyBytes` streaming abort |
| `@minipod/host-node` | `src/net/range-proxy.test.ts` | 4 | `/media/:episodeKey` local & remote HTTP `206 Partial Content`, `416 Range Not Satisfiable`, `HEAD`, Basic Auth header forwarding, ID3 `APIC` chapter image byte-slice streaming, `/api/image-proxy` persistent disk cache (`<dataDir>/artwork-cache`), `Cache-Control: immutable`, `ETag` `304 Not Modified`, and concurrent in-flight deduplication |
| `@minipod/host-node` | `src/sync/LocalFolderFileProvider.test.ts` | 2 | Atomic `.tmp` + `fsync` + `rename` writes, SHA-256 `ETag` conditional checks, concurrent `conflict` detection |
| `@minipod/host-node` | `src/server/server.test.ts` | 3 | Loopback `Host` DNS-rebinding (`403`), `Origin` CSRF (`403`), JSON `Content-Type` (`415`) guards, XML OPML import, single-fetch preview->subscribe, `/media` `206`, `/api/image-proxy` (`200` / hotlink bypass / `400` / `502` HTML error rejection), auto-delete download when played, SSE events, `flush: true` sync |
| `@minipod/host-node` | `src/updater/self-updater.test.ts` | 3 | `parseCliArgs` (`update`, `--check`, `--force`), `POST /api/update/check` & `POST /api/update/apply` via `git pull --ff-only` in git worktrees, and atomic release tarball download outside git |
| `@minipod/host-android` | `src/storage/IdbSyncStore.test.ts` | 2 | IndexedDB schema & `IdbSyncStore` CRDT merge parity (`fake-indexeddb`) |
| `@minipod/host-android` | `src/net/plugin-http.test.ts` | 2 | Capacitor `MiniPodPlugin.httpRequest` Base64 body & redirect hop adapter |
| `@minipod/host-android` | `src/player/NativeAudioEngine.test.ts` | 1 | Media3 native service bridge (`nativeLoad`, `nativeSetQueue`, `nativeSetSleepTimer`, `nativeAdvanced` events) |
| `@minipod/host-android` | `src/sync/SafFileProvider.test.ts` | 1 | Android SAF `content://` tree atomic sync file read/write & ETag probing |
| `@minipod/host-android` | `src/capacitor-host.test.ts` | 4 | End-to-end `createCapacitorPlatformHost` native journal reconciliation, SAF local-folder + `APIC` chapter `data:` URLs + `ACTION_SEND` extraction, blank `imageUrl` fallback in `buildRemainingQueueSources`, and native GitHub release check + `downloadAndInstallApk` / `installApkFile` bridge |
| `@minipod/ui` | `src/__tests__/subscriptions-and-back.test.tsx` | 9 | Adaptive `NavRail` vs `NavBar`, grid-only subscriptions (`subs-grid`, `subs-list` & `subs-overflow-btn` absent), top-right `subs-settings-btn` direct Settings navigation, collapsible subscriptions (`> 6` grid), unplayed Latest Episodes Timeline (`pubDate` DESC + right-swipe played dismiss + context menu podcast navigation), conditional `Manage downloads` (`subs-manage-downloads`) & `DownloadsPage` swipe-left delete, ~450ms long-press & `onContextMenu` viewport-clamped `ContextMenu`, empty state, LIFO back navigation stack, and `artwork-cache.ts` LRU pin pool + candidate memory |
| `@minipod/ui` | `src/__tests__/add-search-preview.test.tsx` | 5 | Top Charts country selector, federated source chips, HTML multi-feed radio disambiguation, 401 Basic Auth inline form, unsubscribed tap-to-stream preview & long-press `preview-ep-context-menu` |
| `@minipod/ui` | `src/__tests__/podcast-detail.test.tsx` | 1 | `All` / `Unplayed` / `Downloaded` filter chips, 3s rewind resume, 4-element `EpisodeRow` (0 inline buttons, tap-to-play, long-press `ep-context-menu`, swipe-left `swipe-hint-left-*` `Play next` + `data-swipe-armed`, swipe-right `swipe-hint-right-*` `Mark played` & immediate dismiss + `Undo`), `loadOlder` pagination |
| `@minipod/ui` | `src/__tests__/queue.test.tsx` | 1 | 0 inline buttons, 0 `queue-overflow-btn`, tap-to-play, long-press `queue-context-menu`, compact `20×36px` live item-following pointer-drag reorder (`data-drag-offset-y` + neighbor `data-shift-y`), swipe-left `swipe-hint-left-*` `Remove` + `Undo` snackbar, synced stub display |
| `@minipod/ui` | `src/__tests__/player-and-engine.test.tsx` | 6 | Desktop transport, speed cycle & slider (`0.5x–3.0x`), keyboard shortcuts, active chapter highlight & seek, XSS-safe shownotes, `SleepTimer` 60s fade-out, `<ArtworkImage>` fallback + `/api/image-proxy` on `ExpandedPlayer` / `MiniPlayer` / `DesktopPlayerBar`, and persistent `document.body` video/audio media park across `ExpandedPlayer` close |
| `@minipod/ui` | `src/__tests__/settings-and-sync.test.tsx` | 3 | Strict 9-row Settings invariant, Cloud Sync provider setup flows, EN / `zh-CN` runtime switching |
| `@minipod/ui` | `src/__tests__/updater.test.tsx` | 3 | Throttled startup check + `<UpdateBanner />` per-version dismiss, Android `apkDownloadProgress` + unknown-sources permission (`Grant & install` -> `installApkFile`), PC `host.updater.apply()`, and strict 9-row Settings invariant |

---

## 2. Live End-to-End & Playwright Browser Verification (39 / 39 Passed)

Executed against live `@minipod/host-node` loopback servers (`node:sqlite` WAL DB + real HTTP sockets + playable 90-second PCM WAV, ID3v2+APIC MP3, Ogg Opus, and MP4 Nero media fixtures) driven by **Playwright Headless Chromium**:

### 2.1 CLI Launcher
- **`bin/minipod.mjs --no-open --port 0 --data-dir <tmp> "itpc://..."`**: Verified ephemeral `127.0.0.1` binding (`http://127.0.0.1:44907`), `/api/info` (`200 OK`), SPA `index.html` serving, deep-link `open-add` emission, and clean `SIGTERM` shutdown (`exit code 0`).

### 2.2 Requirement 1 — Complete AntennaPod Source Parity Matrix

| Capability | Verification Method | Result |
| :--- | :--- | :---: |
| **Apple iTunes Top Charts** | `GET /api/search/top-charts?country=99` with `defaultCountry='ZZ'` (`404`) automatically fell back to `'US'`; explicit `country=AQ` rejected with `404 feed-not-found` (matching AntennaPod `ItunesTopListLoader`) | **PASS** |
| **Apple iTunes Search & `/lookup`** | `GET /api/search/query?source=apple` & `POST /api/search/resolve` on `podcasts.apple.com/.../id777` resolved RSS feed; `id888` omitting `feedUrl` (`FeedUrlNotFoundError`) fell back to `CombinedSearcher` exact title+author match | **PASS** |
| **PodcastIndex.org** | Verified live `X-Auth-Key`, `X-Auth-Date`, and `Authorization = SHA1(key + secret + epochSec)` headers against upstream server | **PASS** |
| **fyyd & gpodder.net** | Verified `source=fyyd` (`/0.2/search/podcast`) and `source=gpodder` (`/search.json`) query endpoints and `combinedWeight = 0` | **PASS** |
| **`CombinedSearcher`** | Parallel Apple + PodcastIndex fan-out deduplicated identical scheme-less `feedKey` URLs and ranked via harmonic `1/(rank+1)` weights | **PASS** |
| **URL Normalization** | Resolved `itpc://`, `pcast://`, `feed://`, `antennapod-subscribe://`, and `https://antennapod.org/deeplink/subscribe?url=...` | **PASS** |
| **HTML `<link rel="alternate">`** | Single-feed webpage auto-followed to `FeedPreview`; multi-feed webpage returned `choices` (`2` feeds) and resolved via browser radio picker | **PASS** |
| **RSS 2.0, Atom 1.0 (`rel=next`), RDF 1.0** | Subscribed & parsed all 3 formats; `POST /api/feeds/:key/load-older` fetched Atom page 2 (`rel="next"`) and appended archived episodes | **PASS** |
| **HTTP `301` / `308` Permanent Redirects** | Preview followed `301` recording `permanentRedirect`; subsequent `308` on refresh updated `feeds.url` and `feeds.moved_to` in SQLite | **PASS** |
| **HTTP `401` Basic Auth** | Returned `{ kind: 'auth-required', realm: 'Patreon Members' }`; retried with UTF-8 password (`s3cr3t-café`), stored in `secrets.json`, and proxied `/media/:episodeKey` (`206 Partial Content`) with injected `Authorization` | **PASS** |
| **OPML 2.0 Import / Export** | Exported subscribed feeds via `GET /api/feeds/opml` and re-imported raw `text/xml` via `POST /api/feeds/opml` | **PASS** |
| **Local Folder Virtual Podcast** | Scanned directory containing ID3v2 `.mp3`, `.wav`, and `folder.jpg`; extracted `TIT2` title, served cover at `/api/feeds/:key/cover`, streamed `/media/:key` (`206`), and excluded `l_<sha1>` feed from cloud sync | **PASS** |
| **5-Format `ChapterMerger` + `APIC`** | Verified 3-layer positional merge (`PSC` + `ID3 CHAP/CTOC/APIC` + `Podcasting 2.0 JSON`), Ogg Opus `CHAPTERxxx` (`15,500 ms`), MP4 `moov.udta.chpl` (`30,000 ms`), and binary `GET /api/episodes/:key/chapters/1/image` returning exact `image/jpeg` `APIC` slice | **PASS** |

### 2.3 Requirement 2 — Minimalist UI & Playback Verification (Playwright Chromium)

- **Desktop Viewport (`1280x800`)**:
  - Rendered 3-item `NavRail` (`Subscriptions`, `Queue`, `Settings`) + `+ Add` FAB (`mobile-nav-bar` count = `0`).
  - Verified **Settings** screen contains **strictly `9` rows** (`[data-settings-row]` count = `9`).
  - Verified **Add / Search** Top Charts default view, source filter chips, HTML multi-feed radio disambiguation, and inline HTTP `401` Basic Auth login retry.
  - **Stream Without Subscribing**: Pasted `itpc://...`, clicked `▶` on Episode 1 in `FeedPreview` *before* subscribing -> verified Chromium `HTMLAudioElement` streamed `/media/e_af2b3577280a6ab86837bd6e749bdface13ca09a` with HTTP `206 Partial Content` (`Content-Range: bytes 0-720043/720044`), `GET /api/feeds` remained empty (`0` subscriptions), and `GET /api/queue` placed Episode 1 at head.
  - **Single-Fetch Subscribe**: Clicked `Subscribe` on `FeedPreview` -> transitioned to `PodcastDetail` without re-fetching upstream RSS XML.
  - **PodcastDetail & Offline Download**: Verified `All` / `Unplayed` / `Downloaded` filter chips and offline download + local `/media` playback.
  - **Queue Management**: Added Episode 2 from episode menu, reordered to top via fractional-index `move`, removed from queue, and restored via `Undo` snackbar.
  - **DesktopPlayerBar & SideSheet**: Opened `SideSheet` Chapters tab, clicked chapter `"Architecture Deep Dive"` (`20s`) -> verified `HTMLAudioElement.currentTime` sought to `20s`; verified Shownotes tab rendered formatted HTML while stripping `<script>` (`window.__xss === false`); verified `+30s` / `-10s` skip buttons, `1.25x` speed cycle (`playbackRate === 1.25`), and Sleep Timer (`End of episode` / `Off`).
  - **Millisecond Pause Persistence & 3s Resume Rewind**: Sought to `30,000 ms` (`30.0s`) and paused -> verified SQLite persisted `positionMs = 30000` (`state: 'IN_PROGRESS'`); switched to Episode 2, then resumed Episode 1 -> verified `HTMLAudioElement` resumed at **`27.3s`** (`30.0s - 3.0s` rewind).
- **Mobile Viewport (`390x844`)**:
  - Rendered 2-tab `NavBar` (`Subscriptions`, `Queue`, zero unread badges, `desktop-nav-rail` count = `0`).
  - Started playback -> verified docked `MiniPlayer` above `NavBar` -> tapped `MiniPlayer` to open full-screen `ExpandedPlayer` sheet -> opened `SleepTimerSheet` -> verified 4-step LIFO `window.__minipodHandleBack()` unwinding (`SleepTimerSheet` -> `ExpandedPlayer` -> `PodcastDetail` -> root returning `false`).

### 2.4 Requirement 3 — Two-Device Cloud File Auto-Sync Simulation (`Device A: "Pixel 8"` ⇄ `Device B: "ThinkPad X1"`)

1. **Subscription LWW & Tombstone Non-Resurrection**:
   - Configured Device B via Playwright UI (`Settings -> Sync provider -> Cloud-synced folder`) and Device A via `/api/sync/configure` pointing at the same shared sync directory (`minipod-sync.v1.json`).
   - Device A subscribed to an RDF feed and synced -> Device B pulled it -> Device B unsubscribed (`deleted: true` tombstone with newer HLC) and synced -> Device A synced -> verified feed remained unsubscribed on both devices across repeated sync cycles without resurrection.
2. **Concurrent Fractional-Index Queue Merge & Instant Synced Stub Playback**:
   - While offline from each other, Device A queued `[Ep1, StubEp1]` and moved `StubEp1` ahead of `Ep1`, while Device B concurrently queued `[Ep2]`.
   - After syncing both devices, queues converged identically (`[StubEp1, Ep1, Ep2]`), and Device B immediately streamed `StubEp1` via `/media/:episodeKey` (`206 Partial Content`, `RIFF` WAV header verified) **before** `StubEp1`'s RSS feed was refreshed.
3. **Live Playwright Cross-Device Episode Progress Resume & `Undo`**:
   - With Episode 1 loaded at `10.0s` on Device B's Playwright browser, Device A (`"Pixel 8"`) saved `positionMs: 42000` (`00:42`, `flush: true`).
   - Clicked `Sync now` in Device B's Playwright UI -> verified SSE pushed `progress-changed`, `HTMLAudioElement.currentTime` automatically sought to **`42.0s`**, and snackbar **`"Resumed from Pixel 8 at 00:42"`** with **`Undo`** button appeared.
   - Clicked **`Undo`** in Playwright -> `HTMLAudioElement.currentTime` reverted to **`10.0s`**, `/api/sync/undo-resume` re-stamped local progress with a newer HLC, and on the next sync Device A converged back to `10,000 ms`.
4. **Live WebDAV & GitHub Gist Providers**:
   - Reconfigured both servers against live mock **WebDAV** (`HEAD`/`GET`/`PUT` with `ETag` + `If-Match`) and **GitHub Secret Gist** (`Bearer` PAT + `ETag` + `minipod-sync.v1.json`) endpoints; verified initial upload, attach, and two-device sync convergence (`200 OK`).

### 2.5 Requirement 4 — Live GitHub Release (`v0.1.2`) & Cross-Platform Auto-Updater E2E (11 / 11 Passed)

Executed with zero mocks against the **live public GitHub repository (`codescv/minipod`)** and **`https://api.github.com/repos/codescv/minipod/releases/latest`** in Playwright Headless Chromium:

| # | Live E2E Check | Verification Result | Status |
| :---: | :--- | :--- | :---: |
| 1 | **Public Repo & Release HTTP Probes** | Unauthenticated `curl -sI` returned `HTTP/2 200` on `https://github.com/codescv/minipod`, `https://github.com/codescv/minipod/releases/tag/v0.1.2`, `https://api.github.com/repos/codescv/minipod/releases/latest` (`tag_name: "v0.1.2"`), and `gh release view v0.1.2` | **PASS** |
| 2 | **Live `releases.atom` Fallback** | `GET https://github.com/codescv/minipod/releases.atom` returned `200 OK` (`4,195` chars, `v0.1.2` `<entry>`) for GitHub API rate-limit resilience | **PASS** |
| 3 | **CLI `minipod update --check` (`0.1.0` simulated)** | `MINIPOD_APP_VERSION=0.1.0 node packages/host-node/bin/minipod.mjs update --check` reported `Update available: MiniPod v0.1.2 (current: v0.1.0) — https://github.com/codescv/minipod/releases/tag/v0.1.2` | **PASS** |
| 4 | **CLI `minipod update --check` (`0.1.2` current)** | Default `node packages/host-node/bin/minipod.mjs update --check` reported `MiniPod v0.1.2 is up to date.` | **PASS** |
| 5 | **`POST /api/update/check` (`0.1.0` -> live GitHub)** | Returned `updateAvailable: true`, `release.version = "0.1.2"`, `apkUrl = ".../minipod-v0.1.2.apk"` (`6,994,455` bytes), `tarballUrl = ".../minipod-v0.1.2-pc.tar.gz"` (`534,387` bytes) | **PASS** |
| 6 | **Playwright Startup Check & `<UpdateBanner />` (`0.1.0`)** | Browser issued live `GET https://api.github.com/repos/codescv/minipod/releases/latest` (`200 OK`) and automatically rendered `[data-testid="update-banner"]` (`"MiniPod v0.1.2 available"`) | **PASS** |
| 7 | **Playwright Settings 9-Row Invariant & Row 9 About** | Navigated to Settings (`1280x800`): verified `[data-settings-row]` count is **strictly `9`**, badge shows `v0.1.0`, status shows `"Update available: v0.1.2"`, and inline button shows `"Update to v0.1.2"` | **PASS** |
| 8 | **Playwright `<UpdateBanner />` Dismiss Persistence** | Clicked `[data-testid="update-banner-dismiss-btn"]` -> banner hid, `localStorage["minipod:update:dismissedTag"] === "v0.1.2"`, and `[data-settings-row]` remained `9` | **PASS** |
| 9 | **Playwright 1-Click Live PC Self-Update Download** | Clicked `"Update to v0.1.2"` -> `POST /api/update/apply` downloaded the live `minipod-v0.1.2-pc.tar.gz` (`534,387` bytes, SHA-256 `fd7d67191759a86e40f24b93d28344c83d75f970203d1319ad2d02887fd7b7ef`) into `<dataDir>/updates/minipod-v0.1.2.tar.gz`; `[data-settings-row]` remained `9` | **PASS** |
| 10 | **Playwright About Dialog & `0.1.2` Up-to-Date Check** | Verified Row 9 opens `settings-about-dialog` (`Source code` -> `https://github.com/codescv/minipod`); on a `0.1.2` server, clicking `"Check for updates"` against live GitHub API reported `"Up to date (v0.1.2)"` with `0` banners and `[data-settings-row] === 9` across both `1280x800` and `390x844` | **PASS** |
| 11 | **Playwright Capacitor Android Native Bridge Flow** | Simulated `0.1.0` mobile (`390x844`) with `window.Capacitor.Plugins.MiniPod` against live GitHub API -> verified `downloadAndInstallApk({ url: ".../minipod-v0.1.2.apk", version: "0.1.2" })`, `apkDownloadProgress` (`50%`), unknown-sources `"Grant & install"`, and `installApkFile` handoff | **PASS** |

### 2.6 `v0.1.3` Enhancements & Fixes E2E Matrix (11 / 11 Passed)

Executed against a live `v0.1.3` `@minipod/host-node` server (`appVersion: "0.1.3"`) and an upstream test podcast CDN in **Playwright Headless Chromium** across both Mobile (`390x844`, `zh-CN`) and Desktop (`1280x800`, `en-US`) viewports:

| # | `v0.1.3` E2E Verification Group | Verification Result | Status |
| :---: | :--- | :--- | :---: |
| 1 | **`v0.1.3` Server & `/api/info`** | Verified live server reports `appVersion: "0.1.3"` | **PASS** |
| 2 | **`<podcast:images srcset>` Feed Parser** | Subscribed to 8 RSS feeds; verified `PodcastIndex.ts` extracted primary episode artwork URL from `<podcast:images srcset="...">` | **PASS** |
| 3 | **`GET /api/image-proxy` Endpoint** | Verified hotlink/UA-protected image returned `200 OK` (`image/png`, `Cache-Control: public, max-age=86400`, `X-Content-Type-Options: nosniff`) | **PASS** |
| 4 | **Req #1a — Expandable Subscriptions (`390x844`)** | With `8` subscribed feeds in grid mode: `6` tiles shown initially -> clicked `subs-expand-toggle` (`展开全部 (8)`) -> `8` tiles shown (`收起`) -> clicked again -> collapsed back to `6` tiles | **PASS** |
| 5 | **Req #1b — Subscriptions Timeline (`pubDate` DESC)** | Verified `subs-timeline-section` rendered directly below `.m-subs-section`, merged all `11` episodes across `8` feeds in strict `pubDate` DESC order (`Ep H8 Overall Newest` -> `Ep A1 Direct Artwork` -> `Ep E5 Interleaved Mid`), with clickable `ep-podcast-thumb-*` + `ep-podcast-link-*` on all `11` rows | **PASS** |
| 6 | **Req #1c — Mobile (`390x844`) Long-Press & Edge-Clamped `ContextMenu`** | Verified `0` top-right `⋮` buttons inside `PodcastTile`; ~450ms `pointerdown` long-press on 3rd-column tile clamped to `right=382` (`<= 390`), and bottom-right `(389, 843)` `contextmenu` clamped to `left=192, top=736, right=382, bottom=836` (`100%` inside `390x844` with `8px` margin) | **PASS** |
| 7 | **Req #5 — Streamlined `EpisodeRow` Actions** | Verified inline `ep-play-*`, inline `ep-queue-btn-*` (live queue add/remove verified via `GET /api/queue`), and `ep-menu-*` containing strictly `['下载单集', '标记为已播']` (`ep-download-*`, `ep-mark-played-*`) with `0` `Play next` and `0` `Share link` items | **PASS** |
| 8 | **Req #3a — Mobile `MiniPlayer` & `ExpandedPlayer` Artwork (4/4 Scenarios)** | Verified `naturalWidth === 64` & `referrerPolicy="no-referrer"` on both `mini-player-artwork-img` and `expanded-artwork-img` across: (1) direct `episode.imageUrl`, (2) absent `episode.imageUrl` (`feed.imageUrl` fallback), (3) broken `404` `episode.imageUrl` (`feed.imageUrl` fallback), and (4) hotlink-blocked `episode.imageUrl` (`4` direct browser `403`s automatically recovered via `/api/image-proxy`) | **PASS** |
| 9 | **Req #2 — Uninterrupted Background Playback Across Route Changes** | Started playback in `ExpandedPlayer`, collapsed `ExpandedPlayer`, and navigated `PodcastDetail (0.61s)` -> `Subscriptions (1.01s)` -> `Queue (1.41s)` -> `Add (1.88s)` -> `Settings (2.53s, [data-settings-row] === 9)` -> verified `audio.paused === false` and monotonic `currentTime` advancement without interruption | **PASS** |
| 10 | **Req #1d — Desktop (`1280x800`) Expandable Grid & Edge-Clamped `ContextMenu`** | Verified `Show all (8)` / `Show less` toggle; 6th-column rightmost tile ~450ms long-press clamped to `right=1272` (`<= 1280`), and `(1279, 799)` bottom-right `contextmenu` clamped to `left=1082, top=692, right=1272, bottom=792` (`100%` inside `1280x800` with `8px` margin) | **PASS** |
| 11 | **Req #3b — `DesktopPlayerBar` Artwork (4/4 Scenarios)** | Verified `img[data-testid="desktop-cover-btn"]` rendered `naturalWidth === 64` across direct, absent->feed, broken `404`->feed, and hotlink->`/api/image-proxy` scenarios | **PASS** |

### 2.7 `v0.1.4` System-Theme-Adaptive Icon (`7A` Light / `7B` Dark) & `"Podcasts"` Brand E2E Matrix (12 / 12 Passed)

Executed against a live `v0.1.4` `@minipod/host-node` loopback server in **Playwright Headless Chromium** across Light (`prefers-color-scheme: light`) and Dark (`prefers-color-scheme: dark`) color schemes and `en-US` / `zh-CN` viewports:

| # | `v0.1.4` E2E Verification Check | Verification Result | Status |
| :---: | :--- | :--- | :---: |
| 1 | **`GET /api/info` Version** | Returned `200 OK` with `data.appVersion === "0.1.4"` | **PASS** |
| 2 | **`GET /favicon.svg`** | Returned `200 OK` (`image/svg+xml`, `6,264` bytes) with `@media (prefers-color-scheme: dark)` rules | **PASS** |
| 3 | **`GET /icon-light-192.png`** | Returned `200 OK` (`image/png`, `192×192`, `12,478` bytes) | **PASS** |
| 4 | **`GET /icon-dark-192.png`** | Returned `200 OK` (`image/png`, `192×192`, `12,788` bytes) | **PASS** |
| 5 | **Page `<title>`** | Verified `document.title === "Podcasts"` across Desktop (`1280×800`) and Mobile (`390×844`) | **PASS** |
| 6 | **HTML Adaptive `<link rel="icon">` Tags** | Verified `/favicon.svg` (`image/svg+xml`), `/icon-light-192.png` (`(prefers-color-scheme: light)` + `apple-touch-icon`), and `/icon-dark-192.png` (`(prefers-color-scheme: dark)`) | **PASS** |
| 7 | **Decoded 192px PNG Pixels** | Canvas pixel verification confirmed `icon-light-192.png` (`#F4F1EA` bg + `#FF4F00` dot) and `icon-dark-192.png` (`#18181B` bg + `#FF4F00` dot) | **PASS** |
| 8 | **Desktop `en-US` Settings & About Dialog** | Verified `[data-settings-row]` count === `9`, `"Up to date (v0.1.4)"`, and `settings-about-dialog` displaying `"Podcasts"` + `"0.1.4"` | **PASS** |
| 9 | **`/favicon.svg` Light Mode (`7A`)** | `color_scheme="light"` computed styles: `.bg = #F4F1EA`, `.dot = #FF4F00`, `.arc = [#1C1917, #1C1917]` | **PASS** |
| 10 | **`/favicon.svg` Dynamic Dark Switch (`7B`)** | `emulate_media(color_scheme="dark")` computed styles: `.bg = #18181B`, `.dot = #FF4F00`, `.arc = [#F4F4F5, #F4F4F5]` | **PASS** |
| 11 | **Mobile `zh-CN` Branding & `<UpdateBanner />`** | Verified `document.title === "Podcasts"` and localized `<UpdateBanner />` rendering `"Podcasts v0.1.5 已发布"` | **PASS** |
| 12 | **Fresh Dark `BrowserContext` `/favicon.svg` (`7B`)** | Native dark-scheme context immediately resolved `.bg = #18181B` and `.arc = #F4F4F5` | **PASS** |

### 2.8 `v0.1.5` Gesture-Driven Episode/Queue Rows, Pointer Queue Reorder & Conditional "Manage Downloads" E2E Matrix (21 / 21 Passed)

Executed against a live `v0.1.5` `@minipod/host-node` server (`node:sqlite` WAL DB + playable WAV audio & PNG artwork upstream server) in **Playwright Headless Chromium** across Mobile (`390×844`, `zh-CN`, touch enabled) and Desktop (`1280×800`, `en-US`) viewports:

| # | `v0.1.5` E2E Verification Check | Verification Result | Status |
| :---: | :--- | :--- | :---: |
| 1 | **`GET /api/info` Version & Capabilities** | Returned `200 OK` with `appVersion === "0.1.5"` and `capabilities.downloads === true` | **PASS** |
| 2 | **Req #3a — `subs-manage-downloads` Hidden When Empty** | With `0` downloaded episodes, opening `subs-overflow-btn` rendered `0` `subs-manage-downloads` items | **PASS** |
| 3 | **Req #1a — Timeline `EpisodeRow` Strictly 4 Elements & 0 Buttons** | Verified all `7` timeline rows have `0` `<button>` elements, `44×44` cover icon (`naturalWidth === 64`), title, and `dateStr · remStr` (`['10月30日', '·', '12 min']`) | **PASS** |
| 4 | **Req #1a — `EpisodeRow` Title 2-Line Clamp** | Verified `webkitLineClamp === "2"`, `overflow === "hidden"`, and long multi-line title clamped to `37.8px <= 39.8px` (`scrollHeight > clientHeight`) | **PASS** |
| 5 | **Req #1b — Click `EpisodeRow` Directly Plays** | Clicking `episode-row-*` directly started `HTMLAudioElement` playback (`paused === false`, `.is-current === true`, `mini-player` visible) | **PASS** |
| 6 | **Req #1c — ~450ms Long-Press Clamped `ep-context-menu`** | Holding `pointerdown` ~520ms near right edge opened `ep-context-menu` clamped at `rect=(192, 328, right=382, bottom=560)` inside `390×844` without triggering playback | **PASS** |
| 7 | **Req #1c — Right-Click Clamped `ep-context-menu`** | Right-clicking near right edge opened `ep-context-menu` (`right=382 <= 382`) with `ep-play-next-*`, `ep-queue-btn-*`, `ep-download-*`, `ep-mark-played-*`, and `ep-open-podcast-*` | **PASS** |
| 8 | **Req #1d — Timeline Touch Swipe-Left (`deltaX < -64px`) -> Play Next** | Touch swipe-left (`deltaX = -110px`) inserted episode at `queue[1]` (`queue.playNext`) right after head | **PASS** |
| 9 | **Req #1e — Timeline Swipe-Right (`deltaX > +64px`) -> Mark Played & Remove** | Pointer swipe-right (`deltaX = +120px`, live `translateX(45px)`) persisted `state: "PLAYED"` in SQLite and immediately detached the row from `subs-timeline-list` | **PASS** |
| 10 | **Req #1a — `PodcastDetail` `EpisodeRow` Layout & 0 Buttons** | Verified all `5` rows in `detail-episode-list` have `44×44` cover icon, `webkitLineClamp === "2"`, date & remaining time, and `0` inline `<button>` elements | **PASS** |
| 11 | **Req #1d — `PodcastDetail` Swipe-Left (`deltaX < -64px`) -> Play Next** | Pointer swipe-left (`deltaX = -120px`, live `translateX(-45px)`) inserted episode at `queue[1]` (`queue.playNext`) | **PASS** |
| 12 | **Req #1e — `PodcastDetail` Swipe-Right (`deltaX > +64px`) -> Mark Played & Remove** | Swiping right (`deltaX = +120px`) under `All` filter persisted `state: "PLAYED"` and immediately removed the row (`5 -> 4` visible rows) | **PASS** |
| 13 | **Req #2a — `QueueList` 0 Inline Buttons & Compact Handle** | Verified all `5` queue rows have `0` `<button>` elements and compact `queue-handle-*` (`20×36px`, `width <= 24px`, `touch-action: none`) | **PASS** |
| 14 | **Req #2b — Click Queue Row Directly Plays** | Clicking queue row body directly started playback and promoted the active episode via `ensureAtHead` | **PASS** |
| 15 | **Req #2c — Long-Press Queue Row Opens Clamped `queue-context-menu`** | ~520ms long-press near right edge opened `queue-context-menu` (`right=382 <= 382`) with `move-top`, `move-up`, `move-down`, `mark-played`, and `remove` | **PASS** |
| 16 | **Req #2d — Pointer Drag on `queue-handle-*` Reorders Queue** | Real pointer drag (`pointerdown` -> `pointermove` -> `pointerup`) moved item `3 -> 0` with live `.is-drop-target` indicator and persisted fractional-index order in SQLite | **PASS** |
| 17 | **Req #2e — Swipe-Left (`deltaX < -64px`) Removes from Queue** | Swiping left (`deltaX = -120px`) on `queue-row-0` immediately removed the item from DOM and `/api/queue` | **PASS** |
| 18 | **Req #3b — Episode Download Surfaces `subs-manage-downloads` (`管理下载 (1)`)** | Triggering `ep-download-*` via long-press menu completed download (`DONE`) and surfaced `subs-manage-downloads` (`管理下载 (1)`) inside `subs-overflow-btn` | **PASS** |
| 19 | **Req #3c — `subs-manage-downloads` Opens `DownloadsPage`** | Clicking `subs-manage-downloads` navigated to `downloads-screen` (`管理下载`, badge `1`, downloaded `EpisodeRow` listed) | **PASS** |
| 20 | **Req #3c — Deleting Download Hides `subs-manage-downloads` Again** | Deleting download rendered `downloads-empty` (`暂无已下载的单集`), and navigating back hid `subs-manage-downloads` (`count === 0`) | **PASS** |
| 21 | **Desktop (`1280×800`) Settings 9-Row Invariant & `v0.1.5` About** | Verified `document.title === "Podcasts"`, `[data-settings-row]` count === `9`, and `settings-about-dialog` displaying `"Podcasts"` + `"0.1.5"` | **PASS** |

### 2.9 `v0.1.6` Swipe Edge Hints, Live Item-Following Queue Drag, Grid-Only Subscriptions + Settings Button & 3-Layer Artwork Cache E2E Matrix (15 / 15 Passed)

Executed against a live `v0.1.6` `@minipod/host-node` server (`node:sqlite` WAL DB + `<dataDir>/artwork-cache/` + playable WAV audio & PNG artwork upstream server) in **Playwright Headless Chromium** across Mobile (`390×844`, `zh-CN`, touch enabled) and Desktop (`1280×800`, `en-US`) viewports:

| # | `v0.1.6` E2E Verification Check | Verification Result | Status |
| :---: | :--- | :--- | :---: |
| 1 | **`GET /api/info` Version & Platform** | Returned `200 OK` with `appVersion === "0.1.6"` and `platform === "desktop"` | **PASS** |
| 2 | **Req #5a — `/api/image-proxy` Disk Cache & Immutable Headers** | Verified `200 OK` (`Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256>"`, `X-Content-Type-Options: nosniff`) and persistent `<hash>.bin` + `<hash>.json` written to `<dataDir>/artwork-cache/` | **PASS** |
| 3 | **Req #5b — `/api/image-proxy` `ETag` `304 Not Modified`** | Conditional `If-None-Match: "<sha256>"` returned `304 Not Modified` with `0` upstream image requests (`upstreamHits: 1 -> 1`) | **PASS** |
| 4 | **Req #4a (Mobile `zh-CN`) — Grid-Only Subscriptions & Header Buttons** | Rendered `subs-grid` (`count === 1`) with `subs-list === 0`, `subs-toggle-layout === 0`, `subs-overflow-btn === 0`, `subs-settings-btn === 1`, and `subs-manage-downloads === 0` when `downloadedCount === 0` | **PASS** |
| 5 | **Req #4b (Mobile `zh-CN`) — Top-Right `subs-settings-btn` Navigation** | Clicking `subs-settings-btn` navigated directly to `settings-screen` (`[data-settings-row]` count === `9`) | **PASS** |
| 6 | **Req #1a (Mobile `zh-CN`) — `EpisodeRow` Swipe-Left Edge Hint (`下一首播放`)** | Swiping left (`-36px` -> `-100px`) revealed sibling `swipe-hint-left-*` (`下一首播放`) anchored at the right edge, transitioned `data-swipe-armed` from `"false"` to `"true"` (`.is-armed`, `translateX = -75px`, `0` `<button>` inside row), and queued episode on release | **PASS** |
| 7 | **Req #1b (Mobile `zh-CN`) — `EpisodeRow` Swipe-Right Edge Hint (`标为已播`)** | Swiping right (`+36px` -> `+100px`) revealed sibling `swipe-hint-right-*` (`标为已播`) anchored at the left edge, transitioned `data-swipe-armed` from `"false"` to `"true"` (`translateX = +75px`), and marked `PLAYED` + dismissed on release | **PASS** |
| 8 | **Req #4c & #1c (Mobile `zh-CN`) — Conditional `subs-manage-downloads` & `DownloadsPage` Swipe-Left (`删除已下载文件`)** | Downloading an episode surfaced `subs-manage-downloads` in the Subscriptions header; clicking it opened `downloads-screen`; swiping left revealed `m-swipe-hint--danger` (`删除已下载文件`, `data-swipe-armed="true"`), deleted the download, and hid `subs-manage-downloads` again | **PASS** |
| 9 | **Req #3a (Mobile `zh-CN`) — Queue Top-Right Menu Removed** | Verified `[data-testid="queue-overflow-btn"]` count is `0` on the Queue screen | **PASS** |
| 10 | **Req #2a (Mobile `zh-CN`) — Live Queue Drag Moving Item + Shifting Neighbors** | Dragging `queue-handle-*` (`pointerdown` -> `pointermove` before `pointerup`) translated `queue-row-0` along Y (`data-drag-offset-y = 140`, `translateY = 140.0px`), shifted crossed neighbors `queue-row-1` & `queue-row-2` (`data-shift-y = -65`, `translateY = -65.0px`), had `0px` `border-top` drop line, and committed the new order on `pointerup` | **PASS** |
| 11 | **Req #1d (Mobile `zh-CN`) — `QueueList` Swipe-Left Edge Hint (`从队列移除`)** | Swiping left (`-36px` -> `-100px`) on `queue-row-0` revealed `swipe-hint-left-*` (`从队列移除`, `m-swipe-hint--danger`, `unarmed="false" -> armed="true"`) and removed the row on release | **PASS** |
| 12 | **Req #5c (Desktop `en-US`) — Zero Duplicate Upstream Image Downloads Across Screen Navigation** | Navigating `Subscriptions -> PodcastDetail -> Queue -> Subscriptions -> PodcastDetail` made **`0` new upstream image downloads** (`newUpstreamHits = {}`), kept all `<ArtworkImage>` elements warm (`loading="eager"`, `decoding="sync"`, `naturalWidth === 64`), and remembered `/api/image-proxy` for hotlink-protected artwork | **PASS** |
| 13 | **Req #1e (Desktop `en-US`) — English `EpisodeRow` Swipe Edge Hints** | Verified `swipe-hint-left-*` (`"Play next"`, `data-swipe-armed="true"`) and `swipe-hint-right-*` (`"Mark played"`, `data-swipe-armed="true"`) on `PodcastDetail` | **PASS** |
| 14 | **Req #1f, #2b & #3b (Desktop `en-US`) — Queue `'Remove'` Hint, Live Handle Drag & Zero Overflow Menu** | Verified `queue-overflow-btn === 0`, swipe-left hint `"Remove"` (`data-swipe-armed="true"`), and live handle drag (`dragOffsetY = 79px`, `neighborShiftY = -65px`) | **PASS** |
| 15 | **Req #4d (Desktop `en-US`) — Grid-Only Subscriptions, `subs-settings-btn`, 9-Row Settings & `v0.1.6` About Dialog** | Verified `subs-list === 0`, `subs-overflow-btn === 0`, clicking `subs-settings-btn` opened Settings (`[data-settings-row] === 9`), and `settings-about-dialog` displayed `"Podcasts"` + `"0.1.6"` | **PASS** |

---

## 3. Standalone Android APK (`v0.1.6`) & Adaptive Icon / Background Playback / Native Artwork Cache Verification

Built via `pnpm build:apk:ci` (`cap sync android && ./gradlew assembleRelease`) and published to GitHub Release `v0.1.6`:

- **Release Artifact (`app-release.apk` & GitHub Release `minipod-v0.1.6.apk`)**:
  - Local Path: `packages/host-android/android/app/build/outputs/apk/release/app-release.apk`
  - Live Download URL: `https://github.com/codescv/minipod/releases/download/v0.1.6/minipod-v0.1.6.apk`
  - Size: `7,125,400` bytes (`6.80 MiB`)
  - SHA-256: `fe87ec263fd6d5e8016b6b55b33eaaa5c5912d49e31f6524c37309c1e0fc8822`
- **PC Standalone Release Bundle (`minipod-v0.1.6-pc.tar.gz`)**:
  - Live Download URL: `https://github.com/codescv/minipod/releases/download/v0.1.6/minipod-v0.1.6-pc.tar.gz`
- **Manifest, Adaptive Day/Night Icon, `PlaybackService`, `FileProvider`, Native WebView Artwork Cache & DEX Verification (`aapt2 dump badging`, `aapt2 dump resources`, `aapt2 dump xmltree`)**:
  - Package & Display Label: `dev.minipod.app` (**`application-label:'Podcasts'`**, **`versionCode='7'`**, **`versionName='0.1.6'`**, `minSdkVersion='26'`, `targetSdkVersion='36'`), `assets/capacitor.config.json` `appName: "Podcasts"`
  - Native WebView Artwork Cache (`MainActivity.java`): `BridgeWebViewClient.shouldInterceptRequest` intercepts remote artwork and `/api/image-proxy?url=...` requests, caching image bytes on disk under `getCacheDir()/artwork-cache/<sha256>.{bin,mime}` with per-hash lock deduplication, OkHttp (`User-Agent: Podcasts/0.1.6`), and `Cache-Control: public, max-age=31536000, immutable`
  - System-Theme-Adaptive Launcher Icon (**7A Light / 7B Dark**):
    - `color/ic_launcher_background`: default `() #fff4f1ea` (**7A `#F4F1EA`**), `(night) #ff18181b` (**7B `#18181B`**)
    - `color/ic_launcher_arcs`: default `() #ff1c1917` (**7A `#1C1917`**), `(night) #fff4f4f5` (**7B `#F4F4F5`**)
    - `color/ic_launcher_dot`: `() #ffff4f00` (**`#FF4F00`**)
    - `mipmap-anydpi-v26/ic_launcher{,_round}.xml`: `<adaptive-icon>` wiring `@color/ic_launcher_background`, `@drawable/ic_launcher_foreground_vector` (`108dp × 108dp`, `0.66` safe-zone group scale), and `@drawable/ic_launcher_monochrome` (`#ffffffff` Android 13+ themed icon)
    - Raster Mipmap Fallbacks: both default (`mdpi`..`xxxhdpi`, **7A**) and night (`night-mdpi`..`night-xxxhdpi`, **7B**) PNG sets present across `mipmap/ic_launcher`, `mipmap/ic_launcher_round`, and `mipmap/ic_launcher_foreground`
    - Bundled Capacitor Web Assets: `assets/public/favicon.svg`, `assets/public/icon-light-192.png`, and `assets/public/icon-dark-192.png`
  - Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `WAKE_LOCK`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, `REQUEST_INSTALL_PACKAGES`
  - `PlaybackService` Manifest Entry: `dev.minipod.app.PlaybackService` (`android:exported="true"`, `android:stopWithTask="false"`, `android:foregroundServiceType="0x00000002"` / `mediaPlayback`, channel `"Podcasts Playback"`)
  - `FileProvider` Manifest Entry: `androidx.core.content.FileProvider` (`android:authorities="dev.minipod.app.fileprovider"`, `android:exported="false"`, `android:grantUriPermissions="true"`) backed by `@xml/file_paths` (`<cache-path name="apk_updates" path="updates/" />`)
- **Signature Verification (`apksigner verify --verbose`)**:
  - `Verifies` — `Verified using v2 scheme (APK Signature Scheme v2): true`, `Number of signers: 1`

---

## 4. Integration Fixes Applied Across Releases

1. **Unsubscribed Preview Stub Materialization (`@minipod/host-node` & `@minipod/host-android`)**:
   - Updated `cachePreviewResult` in `packages/host-node/src/server/context.ts`, `packages/host-android/src/capacitor-host.ts`, and `packages/host-android/src/storage/IdbSyncStore.ts` so previewing an unsubscribed feed (`feeds.preview` / `search.resolveUrl`, including `401` Basic Auth retries) materializes a hidden `subscribed: false` (`markSyncDirty: false`) feed + episode stub in SQLite/IndexedDB.
2. **GitHub Actions Android SDK Package Configuration (`.github/workflows/ci.yml`)**:
   - Configured `android-actions/setup-android@v3` with explicit `packages: 'platform-tools platforms;android-36 build-tools;35.0.0'` so `sdkmanager` on `ubuntu-latest` (`cmdline-tools/16.0`) does not request the deprecated `tools` package during CI APK builds.
3. **Android Capacitor Vite `publicDir` Precedence (`packages/host-android/web/vite.config.ts`)**:
   - Prioritized `packages/host-android/web/public` over the empty `packages/ui/public` directory so `favicon.svg`, `icon-light-192.png`, and `icon-dark-192.png` are copied into `packages/host-android/www` and `assets/public/` inside `app-release.apk`.
