# Podcasts

**Podcasts** (`codescv/minipod`) is an ultra-minimalist, open-source podcast player that ships as both a **standalone Android APK** and a **cross-platform PC Web App** (macOS, Linux, Windows).

It preserves **100% of AntennaPod's podcast discovery, feed parsing, authentication, local folder, OPML, and 5-format chapter capabilities**, strips away every non-essential screen and setting, and syncs subscriptions, playback queue, and millisecond episode progress across all your devices through a **single JSON file (`minipod-sync.v1.json`) in your own cloud storage** — with **zero backend servers**, **zero accounts**, and **zero native `.node` C++/Rust addons**.

- **GitHub Repository**: <https://github.com/codescv/minipod>
- **Latest Release (`v0.1.12`)**: <https://github.com/codescv/minipod/releases/tag/v0.1.12>
  - **Android APK (`dev.minipod.app`, `application-label: 'Podcasts'`, `versionCode 13`)**: [`minipod-v0.1.12.apk`](https://github.com/codescv/minipod/releases/download/v0.1.12/minipod-v0.1.12.apk) (`6.80 MiB`, APK Signature v2, `SHA-1: f5d0cccfda49440bbb5422cb880fc8c68166a654`)
  - **PC Web App Bundle**: [`minipod-v0.1.12-pc.tar.gz`](https://github.com/codescv/minipod/releases/download/v0.1.12/minipod-v0.1.12-pc.tar.gz) (Node.js `>= 22.5.0`)

---

## Highlights

- **Every AntennaPod Source & Feed Format**:
  - **Discovery**: Apple Podcasts / iTunes Search + Country Top Charts + `/lookup` URL translation (with `CombinedSearcher` title+author fallback when Apple omits `feedUrl`), PodcastIndex.org (SHA-1 signed headers), fyyd, gpodder.net, and parallel harmonic-ranked `CombinedSearcher` with scheme-less canonical `feedKey` deduplication.
  - **Syndication & Discovery**: RSS 2.0 / 0.91 / 0.92 (with `<itunes:*>`, `<podcast:*>`, `<psc:chapters>`, `<content:encoded>`), Atom 1.0 (including RFC 5005 `<link rel="next">` paged archive loading), RDF / RSS 1.0, HTML `<link rel="alternate">` single-feed auto-follow & multi-feed picker, custom schemes (`itpc://`, `pcast://`, `feed://`, `antennapod-subscribe://`, `subscribeonandroid.com`), HTTP `301`/`308` permanent redirect updating, HTTP `401` Basic Auth (ISO-8859-1 -> UTF-8 challenge retry + cross-host redirect re-injection), OPML 2.0 import/export, and **Local Folder virtual podcasts** (Desktop path or Android SAF `content://` tree).
  - **5-Format Chapter Merger**: Podlove Simple Chapters (`<psc:chapters>`), Podcasting 2.0 JSON Chapters (`<podcast:chapters>`), ID3v2.3/2.4 `CHAP`/`CTOC` (including on-demand `APIC` chapter artwork byte-slicing), Vorbis Comments (`CHAPTERxxx` in Ogg Opus/Vorbis & native FLAC), and MP4/M4A QuickTime/Nero `moov.udta.chpl`.
- **Ultra-Minimalist Material Design 3 UI & System-Theme-Adaptive Identity**:
  - **Nordic Dot & Arcs Adaptive Icon**: Automatically switches between **7A Light** (`#F4F1EA` warm paper / `#1C1917` charcoal arcs / `#FF4F00` signal dot) and **7B Dark** (`#18181B` obsidian / `#F4F4F5` off-white arcs / `#FF4F00` signal dot) across Android Adaptive Icons (`values` & `values-night` + Android 13+ monochrome themed icon + `mipmap-night-*` raster fallbacks) and Web/Desktop (`favicon.svg` `@media (prefers-color-scheme: dark)` + `icon-light-192.png` / `icon-dark-192.png`).
  - Strictly **2 primary tabs on mobile** (`Subscriptions`, `Queue`) and a **3-item `NavRail` on desktop** (`Subscriptions`, `Queue`, `Settings` + `+ Add` FAB), with **zero unread counter badges**, **strictly 9 Settings rows**, dynamic seed-color M3 theming (Light / Dark / System), and full **English + Simplified Chinese (`zh-CN`) + Japanese (`ja`)** localization.
  - **Subscriptions Timeline, Flexible 2-Row Cover Grid & Direct Settings Button**: Responsive multi-column subscription cover grid (`computeSubscriptionsGridCols`: `4` cols on `360px–440px` phones like OnePlus 13T collapsing after `2` rows / `8` feeds; `6` cols on `1024px` desktop collapsing after `2` rows / `12` feeds; `8` cols at `1280px+`) with a direct top-right **Settings (`⚙`)** button (no layout-toggle clutter or top-right `⋮` overflow menu), viewport-clamped long-press/right-click context menus (`8px` safe margin, zero cluttering `⋮` buttons on covers), conditional header **Manage downloads (`管理下载`)** button when `>= 1` episode is downloaded, and an integrated **Latest Unplayed Episodes Timeline (`最新单集`)** below Subscriptions merging unplayed, unstarted, and unqueued episodes across all subscribed podcasts sorted by `pubDate` DESC (automatically removing episodes on tap-to-play or swipe-left `Play next` with in-place `Undo`).
  - **Gesture-Driven Minimalist Episode & Queue Rows with Live Edge Hints, In-Place Row Undo & Item-Following Reorder**:
    - **Episode Rows with Swipe Edge Hints & In-Place Row Undo (`.m-inline-undo`)**: Strictly 4 visual elements — `44×44` cover icon (with `<ArtworkImage>` `<itunes:image>` / `<podcast:images>` / `/api/image-proxy` / feed fallback), 2-line clamped title (`-webkit-line-clamp: 2`), publish date, and remaining time — with **zero inline buttons**. Tap/click plays directly, long-press (~450ms) or right-click opens a viewport-clamped context menu, **swipe left** reveals a right-edge **`Play next` (`下一首播放`)** action hint (or **`Delete download` (`删除已下载文件`)** on `DownloadsPage`) that arms (`data-swipe-armed="true"`) past `64px` and renders an in-place row overlay **`Undo` (`撤销`)** (`inline-undo-*`, zero bottom snackbar notification), and **swipe right** reveals a left-edge **`Mark played` (`标为已播`)** action hint that marks **Played** and replaces the row in-place with an inline **`Undo` (`撤销`)** bar for `4.5s` before detaching.
    - **Queue Rows, In-Place Slot Undo & Live Item-Following Drag Reorder**: Zero top-right `⋮` overflow menu and zero inline row buttons, tap-to-play, long-press context menu, **swipe left** with right-edge **`Remove` (`从队列移除`)** action hint that replaces the removed queue slot in-place with an inline **`Undo` (`撤销`)** bar (`data-queue-undo-idx`, restoring the item to its exact slot on click without a bottom snackbar), and a compact `20×36px` drag handle (`touch-action: none`) where the dragged row smoothly follows your finger/cursor (`translate3d(0, dy, 0) scale(1.015)` + M3 elevation) while crossed neighbor rows glide by `±rowHeight` in real time.
    - **3-Layer Channel & Episode Artwork Cache**:
      - **Layer 1 (UI In-Memory Pin Pool & Candidate Memory)**: Retains decoded `HTMLImageElement` instances in an LRU pool (`max 400`), remembers resolved candidate indices per URL set, and preloads channel/episode covers so navigating across `Subscriptions`, `PodcastDetail`, and `Queue` renders `loading="eager"` + `decoding="sync"` covers instantaneously with zero duplicate upstream downloads.
      - **Layer 2 (`@minipod/host-node` Disk + RAM Artwork Proxy Cache)**: `/api/image-proxy` caches fetched images in RAM (`256` entries) and persistently on disk (`<dataDir>/artwork-cache/<sha256>.{bin,json}`) with concurrent in-flight request deduplication, `Cache-Control: public, max-age=31536000, immutable`, and `ETag` (`304 Not Modified`).
      - **Layer 3 (`@minipod/host-android` Native WebView `shouldInterceptRequest` Cache)**: `BridgeWebViewClient` intercepts remote `http`/`https` cover art and `/api/image-proxy` requests, caching image bytes on disk under `getCacheDir()/artwork-cache/` with per-hash lock deduplication and OkHttp (`User-Agent: Podcasts/0.1.12`).
    - **Instant Stale-While-Revalidate (SWR) Tab & View Switching (`HostViewCache`)**: Per-host in-memory view cache (`WeakMap<PlatformHost, HostViewCache>`) synchronously populates `SubscriptionsGrid` (preserving expanded subscription grid state and timeline pagination), `QueueList`, `PodcastDetail` (instant frame-0 hero + episode render on open and synchronous `All` / `Unplayed` / `Downloaded` filter switching), `DownloadsPage`, `SettingsPage`, `TopCharts`, and `AddSearch` federated source chips (`All` / `Apple` / `PodcastIndex` / `fyyd` / `gpodder`) so switching tabs or filters never clears existing lists or flashes empty states while revalidating in the background.
  - **Stream Without Subscribing**: Tap any search/preview episode in `FeedPreview` to stream immediately via the HTTP `206 Partial Content` Range proxy with chapters and progress tracking before deciding to subscribe.
  - **Thoughtful Uninterrupted Background Playback**: Native Android `MediaSessionService` foreground notification (`addSession`, immediate `startForeground`, `onTaskRemoved` continuation, `WifiLock` network wake mode) and persistent Web media park, `-10s` / `+30s` transport, **3 pitch-preserved speed presets (`0.8×`, `1.0×`, `1.5×`)** cycling `1× -> 1.5× -> 0.8× -> 1×` on tap (or `[` / `]` keyboard shortcuts on desktop, with zero fine-grained slider clutter), Sleep Timer (`15m` / `30m` / `45m` / `60m` / `End of episode` / `End of chapter` with 60s linear volume fade-out), 5-second + immediate pause/`pagehide` millisecond persistence, and automatic **3-second rewind** when resuming `IN_PROGRESS` episodes.
- **Serverless CRDT Cloud File Auto-Sync**:
  - Syncs through a single `minipod-sync.v1.json` envelope stored in **any cloud-synced folder** (Syncthing, iCloud Drive, Dropbox, OneDrive, Nextcloud desktop client, or Android SAF folder), **Google Drive** (`appDataFolder` or visible Drive file), **WebDAV** (`ETag` + `If-Match` conditional writes, Basic & Digest Auth), or a **GitHub Secret Gist** (with automatic `gzip` + Base64 above 800 KB).
  - Conflict-free Hybrid Logical Clock (HLC) CRDT merge: Last-Write-Wins subscriptions with unsubscribe tombstones (never resurrecting deleted feeds), LexoRank-style base-62 fractional-index queue ordering (with embedded episode stubs so synced queue items stream immediately before RSS refresh), and monotonic/HLC episode progress with live `"Resumed from <device> at MM:SS — Undo"` snackbar.
- **100% Pure TypeScript / Built-in Node 22+ Runtime**:
  - Uses Node's built-in `node:sqlite` (WAL mode) and Web Crypto (`crypto.subtle`) — `onlyBuiltDependencies: []` in `pnpm-workspace.yaml` and enforced in CI via `pnpm check:native` (**0 `.node` binaries, 0 `node-gyp`, 0 Electron/Tauri**).
- **In-App Cross-Platform Auto-Updater**:
  - Automatically checks `codescv/minipod` GitHub Releases (`api.github.com/repos/codescv/minipod/releases/latest` with `/releases?per_page=5` and rate-limit-free `releases.atom` XML fallbacks) on startup (5-minute throttle) and via **Settings → About** (`Check for updates` / `Update to vX.Y.Z`, keeping the strict 9-row Settings invariant).
  - Surfaces a dismissible Material 3 `<UpdateBanner />` when a newer version is published.
  - **Android Native Auto-Installer**: `MiniPodPlugin.downloadAndInstallApk` follows cross-host HTTPS redirects (`github.com` → `release-assets.githubusercontent.com`, blocking `https → http` downgrades), streams into `<cacheDir>/updates/minipod-<version>.apk` via atomic `.tmp` rename with live `apkDownloadProgress` events, verifies ZIP magic (`PK\x03\x04`) and `PackageManager.getPackageArchiveInfo` (`dev.minipod.app` + non-downgrade `versionCode`), and launches the system package installer via `FileProvider` (`dev.minipod.app.fileprovider`), automatically resuming from `MainActivity.onResume()` if Android 8+ unknown-sources permission is newly granted.
  - **PC Web App Self-Updater**: Updates in-place via `git fetch origin --tags && git pull --ff-only` when running from a git checkout, or atomically downloads `minipod-v<version>-pc.tar.gz` into `<dataDir>/updates/` (`POST /api/update/apply` or `node packages/host-node/bin/minipod.mjs update [--check] [--force]`).

---

## Monorepo Architecture

```text
minipod/
├── .github/workflows/ci.yml # GitHub Actions CI (typecheck, test, check:native, build, APK & Release)
├── ARCHITECTURE.md          # Complete system & CRDT specification
├── DESIGN.md                # Material Design 3 UI/UX & anti-bloat specification
├── TEST_REPORT.md           # Full unit, property, Playwright E2E, sync, auto-update & APK test report
├── scripts/
│   ├── check-native-deps.mjs # Verifies 0 native .node/gyp addons in runtime tree
│   └── bump-version.mjs      # Syncs package.json + Android versionCode/versionName
└── packages/
    ├── core/                # @minipod/core — 0 external deps; searchers, XML/HTML/OPML parsers,
    │                        #   5-format chapters, HLC + CRDT sync engine, providers & release updater
    ├── ui/                  # @minipod/ui — Shared React 19 + M3 adaptive UI, Zustand stores,
    │                        #   UpdateBanner, HtmlAudioEngine, MockPlatformHost, EN + zh-CN + JA i18n
    ├── host-node/           # @minipod/host-node — Loopback Hono server (127.0.0.1), node:sqlite,
    │                        #   HTTP 206 Range media proxy, SSE events, sync & PC self-updater
    └── host-android/        # @minipod/host-android — Capacitor 8 Android app, IndexedDB store,
                             #   MiniPodPlugin.java (OkHttp/SAF/APK installer) & Media3 PlaybackService
```

---

## Quick Start — PC Web App (macOS / Linux / Windows)

### Prerequisites
- **Node.js `>= 22.5.0`** (tested on `v22.22.1`; required for built-in `node:sqlite`)
- **pnpm `>= 10`** (tested on `10.32.1`)

### Install, Build & Run

```bash
pnpm install
pnpm build
pnpm start
```

Or launch directly in a standalone chromeless app window (Chrome / Chromium / Edge / Brave `--app` mode):

```bash
pnpm start:app
```

### CLI Options (`packages/host-node/bin/minipod.mjs`)

```bash
node packages/host-node/bin/minipod.mjs [options] [podcast-url-or-deeplink]
node packages/host-node/bin/minipod.mjs update [--check] [--force] [--data-dir <dir>]

Options:
  --port <n>          Loopback port on 127.0.0.1 (default: 0 ephemeral, or 47821 with --dev)
  --data-dir <dir>    Custom data directory (default: ~/.minipod)
  --no-open           Start server without opening a browser tab
  --new-browser       Open in standalone chromeless --app=<url> window (alias: --app)
  --dev               Development mode on 127.0.0.1:47821
  --check             (with `update`) Check GitHub Releases without applying
  --force             (with `update`) Force re-apply / re-download latest release
```

Examples:

```bash
# Headless local server on fixed port with custom data directory
node packages/host-node/bin/minipod.mjs --port 47821 --data-dir ~/.minipod --no-open

# Open directly to a podcast deep-link preview
node packages/host-node/bin/minipod.mjs "itpc://atp.fm/rss"

# Check for or apply updates from GitHub Releases (codescv/minipod)
node packages/host-node/bin/minipod.mjs update --check
node packages/host-node/bin/minipod.mjs update
```

### Desktop Data Directory (`~/.minipod/`)

- `minipod.sqlite` — WAL-mode SQLite database (`feeds`, `episodes`, `queue`, `progress`, `sync_meta`)
- `config.json` — Non-secret app & sync settings
- `secrets.json` — `0600`-permissioned credential store (HTTP Basic Auth, WebDAV password, GitHub Gist PAT, Drive OAuth refresh token — **never written into sync files**)
- `downloads/` — Manual offline episode downloads
- `artwork-cache/` — Persistent SHA-256 keyed channel & episode cover art cache (`<hash>.bin` + `<hash>.json`)

---

## Building the Standalone Android APK

### Prerequisites
- **JDK 21** (`JAVA_HOME`)
- **Android SDK** (`ANDROID_HOME`, `compileSdk 36`, `minSdk 26`)

### Build Signed Release APK

```bash
pnpm build:apk
```

This bumps the synchronized version (`scripts/bump-version.mjs`), builds the Vite production web bundle (`packages/host-android/www`), syncs Capacitor Android assets (`cap sync android`), and runs `./gradlew assembleRelease` to produce a v2-signed standalone APK at:

```text
packages/host-android/android/app/build/outputs/apk/release/app-release.apk
```

For a debug APK without bumping the version:

```bash
pnpm --filter @minipod/host-android cap:sync
cd packages/host-android/android && ./gradlew assembleDebug
```

**Native Android Components (`dev.minipod.app`)**:
- `MainActivity.java` — Registers `MiniPodPlugin`, configures WebView mixed-content image loading (`MIXED_CONTENT_ALWAYS_ALLOW`), intercepts remote artwork and `/api/image-proxy` requests with a native persistent disk cache (`getCacheDir()/artwork-cache`, per-hash lock deduplication, OkHttp `User-Agent: Podcasts/0.1.12`), requests Android 13+ `POST_NOTIFICATIONS` permission, handles hardware back navigation (`window.__minipodHandleBack()`), forwards `itpc://` / `pcast://` / `feed://` / `antennapod-subscribe://` intents, and resumes pending APK updates (`MiniPodPlugin.resumePendingApkInstall`) when returning from Android's unknown-sources settings screen.
- `MiniPodPlugin.java` — Native CORS-free HTTP/Range client (`redirect: manual` hop recorder), Android SAF directory & cloud document picker (`pickFolder`, `listFolder`, `statFile`, `readFileRange`, `writeFileAtomic`, `safPickSyncFile`, `safStat`, `safRead`, `safWrite` via `ContentResolver.openOutputStream` `"wt"`/`"rwt"` for local & cloud `DocumentsProvider` compatibility), direct Android Google OAuth 2.0 token flow (`AccountManager.newChooseAccountIntent` + `GoogleAuthUtil.getToken` with `SharedPreferences` `google_account_email` & `accountHint` persistence, registered GCP Android OAuth Client ID `304560912778-cqrmg9l6ua7dhpvvr40sviie0ir9sjp3.apps.googleusercontent.com`, deterministic keystore `SHA-1: f5d0cccfda49440bbb5422cb880fc8c68166a654`, and Google Drive SAF `DocumentsProvider` fallback), signed APK auto-downloader/installer (`downloadAndInstallApk`, `installApkFile` via `FileProvider` `dev.minipod.app.fileprovider`), and playback bridge.
- `PlaybackService.java` — Foreground `MediaSessionService` (`android:stopWithTask="false"`) backed by `androidx.media3:media3-exoplayer` (`1.5.1`) with registered `MediaSession` (`addSession`), immediate `startForeground` (`FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`), background continuation across `onTaskRemoved`, lock-screen/Bluetooth media controls, audio focus, becoming-noisy pause, gapless queue auto-advance, and native sleep timer.

---

## Cloud File Auto-Sync Setup

Open **Settings → Sync provider** on each device and choose the same shared location:

1. **Cloud-synced folder (Recommended — zero credentials)**:
   - *Desktop*: Pick any folder synced by Syncthing, iCloud Drive, Dropbox, OneDrive, Google Drive for Desktop, or Nextcloud. MiniPod writes `minipod-sync.v1.json` atomically (`write .tmp` -> `fsync` -> `rename`).
   - *Android*: Pick the corresponding synced folder via Android's Storage Access Framework (SAF) folder picker (compatible with Syncthing-Fork, Round Sync, FolderSync, Nextcloud, etc.).
2. **Google Drive**: Uses either hidden `appDataFolder` (`drive.appdata` scope) or a visible `MiniPod/minipod-sync.v1.json` file (`drive.file` scope) with `md5Checksum` conditional probing and automatic duplicate-file self-healing. On Android, uses direct `AccountManager` + `GoogleAuthUtil.getToken` with the registered GCP Android OAuth 2.0 Client ID (`304560912778-cqrmg9l6ua7dhpvvr40sviie0ir9sjp3.apps.googleusercontent.com`, pinned release keystore `SHA-1: f5d0cccfda49440bbb5422cb880fc8c68166a654`), persists `accountHint` across restarts for silent background token refreshes, and retains Google Drive SAF `DocumentsProvider` (`com.google.android.apps.docs.storage`) fallback.
3. **WebDAV**: Point at any Nextcloud, ownCloud, Fastmail, Koofr, or self-hosted WebDAV file URL (`https://cloud.example.com/remote.php/dav/files/user/minipod-sync.v1.json`); uses `ETag` + `If-Match` atomic locking (`412` retry-merge) and supports both HTTP Basic and Digest authentication.
4. **GitHub Secret Gist**: Supply a fine-grained or classic Personal Access Token (`gist` scope). MiniPod creates or attaches to a secret gist containing `minipod-sync.v1.json`, uses `If-None-Match` (`304` free rate-limit checks), follows authenticated `raw_url` when truncated, and auto-compresses payloads `> 800 KB` with `gzip` + Base64.

---

## Development & Verification Commands

```bash
# Run isolated UI harness with MockPlatformHost + MockPlayerEngine
pnpm dev:ui

# Run host-node backend in watch mode (127.0.0.1:47821)
pnpm dev

# Type-check all 4 packages (strict TypeScript, 0 errors)
pnpm typecheck

# Run full Vitest suite across core, ui, host-node, and host-android
pnpm test

# Verify zero native .node / node-gyp addons in runtime dependency tree
pnpm check:native

# Build production bundles for host-node and host-android
pnpm build
```

---

## License

MIT
