# MiniPod

Ultra-minimalist podcast app for **Android** and the **PC (macOS / Linux / Windows) as a local Web App** — every AntennaPod discovery & feed source, one-tenth of its UI, and zero-cost cloud file sync.

- Product & UX: [DESIGN.md](DESIGN.md)
- Build contract: [ARCHITECTURE.md](ARCHITECTURE.md)
- AntennaPod source inventory: [docs/ANTENNAPOD_SOURCES.md](docs/ANTENNAPOD_SOURCES.md)

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm check:native
pnpm start        # PC Web App (Node >= 22.5, no native addons)
pnpm build:apk    # Android APK (Capacitor 8)
```
