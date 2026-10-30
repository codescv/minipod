import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.minipod.app',
  appName: 'MiniPod',
  // Output of `vite build web` (see web/vite.config.ts).
  webDir: 'www',
  android: {
    // Legacy RSS feeds commonly serve cover / chapter art over plain http://;
    // with androidScheme 'https' Chromium would block those as mixed content.
    allowMixedContent: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // All network I/O goes through MiniPodPlugin.http (manual redirect chain,
    // Basic Auth retry, Range); CapacitorHttp would hide redirects and
    // base64-encode bodies, so it stays disabled.
    CapacitorHttp: { enabled: false },
    // MainActivity keeps the WebView edge-to-edge and injects --m-safe-* insets.
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
