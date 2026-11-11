/**
 * Detects the iOS Capacitor 8 `WKWebView` host (`//experimental/users/chii/ios/minipod`), which
 * runs this exact bundle with `host.info.platform === 'android'` (same `CapacitorPlatformHost`)
 * but cannot sideload APKs: update actions open the GitHub release page instead.
 */
interface CapacitorPlatformLike {
  getPlatform?: () => string;
}

export function isIosCapacitorRuntime(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorPlatformLike }).Capacitor;
  try {
    const platform = cap?.getPlatform?.();
    if (platform === 'ios') return true;
    if (platform === 'android') return false;
  } catch {
    // fall through to the user agent
  }
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
  return /iPhone|iPad|iPod/i.test(ua) && Boolean(cap);
}
