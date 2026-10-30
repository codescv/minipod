# MiniPod

**MiniPod** is an ultra-minimalist, open-source podcast player that ships as both a **standalone Android APK** and a **cross-platform PC Web App** (macOS, Linux, Windows).

It preserves **100% of AntennaPod's podcast discovery, feed parsing, authentication, local folder, OPML, and 5-format chapter capabilities**, strips away every non-essential screen and setting, and syncs subscriptions, playback queue, and millisecond episode progress across all your devices through a **single JSON file (`minipod-sync.v1.json`) in your own cloud storage** — with **zero backend servers**, **zero accounts**, and **zero native `.node` C++/Rust addons**.

- **GitHub Repository**: <https://github.com/codescv/minipod>
- **Latest Release (`v0.1.2`)**: <https://github.com/codescv/minipod/releases/tag/v0.1.2>
  - **Android APK (`dev.minipod.app`, `versionCode 3`)**: [`minipod-v0.1.2.apk`](https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2.apk) (`6.67 MiB`, APK Signature v2)
  - **PC Web App Bundle**: [`minipod-v0.1.2-pc.tar.gz`](https://github.com/codescv/minipod/releases/download/v0.1.2/minipod-v0.1.2-pc.tar.gz) (`521.86 KiB`, Node.js `>= 22.5.0`)

---

## Highlights

- **Every AntennaPod Source & Feed Format**:
  - **Discovery**: Apple Podcasts / iTunes Search + Country Top Charts + `/lookup` URL translation (with `CombinedSearcher` title+author fallback when Apple omits `feedUrl`), PodcastIndex.org (SHA-1 signed headers), fyyd, gpodder.net, and parallel harmonic-ranked `CombinedSearcher` with scheme-less canonical `feedKey` deduplication.
  - **Syndication & Discovery**: RSS 2.0 / 0.91 / 0.92 (with `<itunes:*>`, `<podcast:*>`, `<psc:chapters>`, `<content:encoded>`), Atom 1.0 (including RFC 5005 `<link rel="next">` paged archive loading), RDF / RSS 1.0, HTML `<link rel="alternate">` single-feed auto-follow & multi-feed picker, custom schemes (`itpc://`, `pcast://`, `feed://`, `antennapod-subscribe://`, `subscribeonandroid.com`), HTTP `301`/`308` permanent redirect updating, HTTP `401` Basic Auth (ISO-8859-1 -> UTF-8 challenge retry + cross-host redirect re-injection), OPML 2.0 import/export, and **Local Folder virtual podcasts** (Desktop path or Android SAF `content://` tree).
  - **5-Format Chapter Merger**: Podlove Simple Chapters (`<psc:chapters>`), Podcasting 2.0 JSON Chapters (`<podcast:chapters>`), ID3v2.3/2.4 `CHAP`/`CTOC` (including on-demand `APIC` chapter artwork byte-slicing), Vorbis Comments (`CHAPTERxxx` in Ogg Opus/Vorbis & native FLAC), and MP4/M4A QuickTime/Nero `moov.udta.chpl`.
- **Ultra-Minimalist Material Design 3 UI**:
  - Strictly **2 primary tabs on mobile** (`Subscriptions`, `Queue`) and a **3-item `NavRail` on desktop** (`Subscriptions`, `Queue`, `Settings` + `+ Add` FAB), with **zero unread counter badges**, **strictly 9 Settings rows**, dynamic seed-color M3 theming (Light / Dark / System), and full **English + Simplified Chinese (`zh-CN`)** localization.
  - **Stream Without Subscribing**: Tap `▶` on any search/preview episode to stream immediately via the HTTP `206 Partial Content` Range proxy with chapters and progress tracking before deciding to subscribe.
  - **Thoughtful Playback**: `-10s` / `+30s` transport, `0.5x–3.0x` pitch-preserved speed presets & slider, Sleep Timer (`15m` / `30m` / `45m` / `60m` / `End of episode` / `End of chapter` with 60s linear volume fade-out), 5-second + immediate pause/`pagehide` millisecond persistence, and automatic **3-second rewind** when resuming `IN_PROGRESS` episodes.
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
    │                        #   UpdateBanner, HtmlAudioEngine, MockPlatformHost, EN + zh-CN i18n
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
- `MainActivity.java` — Registers `MiniPodPlugin`, handles hardware back navigation (`window.__minipodHandleBack()`), forwards `itpc://` / `pcast://` / `feed://` / `antennapod-subscribe://` intents, and resumes pending APK updates (`MiniPodPlugin.resumePendingApkInstall`) when returning from Android's unknown-sources settings screen.
- `MiniPodPlugin.java` — Native CORS-free HTTP/Range client (`redirect: manual` hop recorder), Android SAF directory picker (`pickFolder`, `listFolder`, `statFile`, `readFileRange`, `writeFileAtomic`), signed APK auto-downloader/installer (`downloadAndInstallApk`, `installApkFile` via `FileProvider` `dev.minipod.app.fileprovider`), and playback bridge.
- `PlaybackService.java` — Foreground `MediaSessionService` backed by `androidx.media3:media3-exoplayer` (`1.5.1`) with lock-screen/Bluetooth media controls, audio focus, becoming-noisy pause, gapless queue auto-advance, and native sleep timer.

---

## Cloud File Auto-Sync Setup

Open **Settings → Sync provider** on each device and choose the same shared location:

1. **Cloud-synced folder (Recommended — zero credentials)**:
   - *Desktop*: Pick any folder synced by Syncthing, iCloud Drive, Dropbox, OneDrive, Google Drive for Desktop, or Nextcloud. MiniPod writes `minipod-sync.v1.json` atomically (`write .tmp` -> `fsync` -> `rename`).
   - *Android*: Pick the corresponding synced folder via Android's Storage Access Framework (SAF) folder picker (compatible with Syncthing-Fork, Round Sync, FolderSync, Nextcloud, etc.).
2. **Google Drive**: Uses either hidden `appDataFolder` (`drive.appdata` scope) or a visible `MiniPod/minipod-sync.v1.json` file (`drive.file` scope) with `md5Checksum` conditional probing and automatic duplicate-file self-healing.
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
