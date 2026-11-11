/**
 * Runtime platform helpers shared by the Android and iOS Capacitor shells.
 *
 * The exact same `@minipod/host-android` bundle runs inside Android's Capacitor WebView and the
 * iOS Capacitor 8 `WKWebView` host (`//experimental/users/chii/ios/minipod`). Both expose the
 * same `MiniPod` native plugin; these helpers cover the few places where labels or URI schemes
 * differ.
 */

/** iOS SAF stand-in (`minipod-saf://<rootId>/<path>`) used by the iOS `MiniPod` plugin. */
export const IOS_DOCUMENT_URI_PREFIX = 'minipod-saf://';

/**
 * Document URIs that must go through `MiniPod.saf*` instead of `readLocalFileRange` /
 * `deleteLocalFile`: Android SAF `content://` and iOS security-scoped `minipod-saf://`.
 */
export function isDocumentUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return uri.startsWith('content://') || uri.startsWith(IOS_DOCUMENT_URI_PREFIX);
}

const IOS_UA_RE = /iPhone|iPad|iPod|iOS/i;

/** `true` inside the iOS Capacitor host (`Capacitor.getPlatform() === 'ios'` or an iOS UA). */
export function isIosRuntime(platform?: string, userAgent?: string): boolean {
  if (platform === 'ios') return true;
  if (platform === 'android') return false;
  return IOS_UA_RE.test(userAgent ?? '');
}

/** `iOS 18.0` from a WebKit user agent (`CPU iPhone OS 18_0 like Mac OS X`), else `iOS`. */
export function iosOsLabel(userAgent?: string): string {
  const m = /(?:iPhone|CPU)(?: iPhone)? OS (\d+(?:_\d+)*)/i.exec(userAgent ?? '');
  if (!m?.[1]) return 'iOS';
  return `iOS ${m[1].split('_').slice(0, 2).join('.')}${m[1].includes('_') ? '' : '.0'}`;
}

/** `Android 15` from a Chromium user agent, else `Android`. */
export function androidOsLabel(userAgent?: string): string {
  return /Android\s+([0-9.]+)/i.exec(userAgent ?? '')?.[0] ?? 'Android';
}
