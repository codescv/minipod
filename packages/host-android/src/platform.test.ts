import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { resolveCapacitorHostDeps } from './default-deps';
import type { MiniPodPlugin } from './plugin-types';
import { createMemoryPreferences } from './storage/idb';
import { androidOsLabel, iosOsLabel, isDocumentUri, isIosRuntime } from './platform';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('platform helpers (Android + iOS Capacitor shells)', () => {
  it('treats Android SAF content:// and iOS minipod-saf:// as document URIs', () => {
    expect(isDocumentUri('content://com.android.externalstorage.documents/tree/x')).toBe(true);
    expect(isDocumentUri('minipod-saf://abc123/Podcasts/ep1.mp3')).toBe(true);
    expect(isDocumentUri('/data/user/0/dev.minipod.app/files/downloads/a.mp3')).toBe(false);
    expect(isDocumentUri('file:///var/mobile/x.mp3')).toBe(false);
    expect(isDocumentUri(undefined)).toBe(false);
    expect(isDocumentUri('')).toBe(false);
  });

  it('detects the iOS runtime from Capacitor.getPlatform() first, then the user agent', () => {
    expect(isIosRuntime('ios', ANDROID_UA)).toBe(true);
    expect(isIosRuntime('android', IPHONE_UA)).toBe(false);
    expect(isIosRuntime('web', IPHONE_UA)).toBe(true);
    expect(isIosRuntime('web', IPAD_UA)).toBe(true);
    expect(isIosRuntime('web', ANDROID_UA)).toBe(false);
    expect(isIosRuntime(undefined, 'Node.js/22')).toBe(false);
  });

  it('formats iOS / Android OS labels', () => {
    expect(iosOsLabel(IPHONE_UA)).toBe('iOS 18.0');
    expect(iosOsLabel(IPAD_UA)).toBe('iOS 17.4');
    expect(iosOsLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('iOS');
    expect(iosOsLabel(undefined)).toBe('iOS');
    expect(androidOsLabel(ANDROID_UA)).toBe('Android 15');
    expect(androidOsLabel('')).toBe('Android');
  });
});

describe('resolveCapacitorHostDeps platform labels', () => {
  const baseOverrides = {
    plugin: {} as MiniPodPlugin,
    preferences: createMemoryPreferences(),
    appVersion: '0.1.32',
    onAppLifecycle: () => () => undefined,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps Android defaults outside iOS', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.stubGlobal('navigator', { userAgent: ANDROID_UA, onLine: true });
    const deps = await resolveCapacitorHostDeps(baseOverrides);
    expect(deps.osLabel).toBe('Android 15');
    expect(deps.defaultDeviceName).toBe('Android');
    expect(deps.runtime).toBe('android');
  });

  it('labels the iOS WKWebView host as iOS', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, onLine: true });
    const deps = await resolveCapacitorHostDeps(baseOverrides);
    expect(deps.osLabel).toBe('iOS 18.0');
    expect(deps.defaultDeviceName).toBe('iOS');
    expect(deps.runtime).toBe('ios');
  });

  it('falls back to the iOS user agent when Capacitor reports web', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    vi.stubGlobal('navigator', { userAgent: IPAD_UA, onLine: true });
    const deps = await resolveCapacitorHostDeps(baseOverrides);
    expect(deps.osLabel).toBe('iOS 17.4');
    expect(deps.defaultDeviceName).toBe('iOS');
  });

  it('honours explicit overrides', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
    const deps = await resolveCapacitorHostDeps({
      ...baseOverrides,
      osLabel: 'Custom OS',
      defaultDeviceName: 'Phone',
      runtime: 'android',
    });
    expect(deps.osLabel).toBe('Custom OS');
    expect(deps.defaultDeviceName).toBe('Phone');
    expect(deps.runtime).toBe('android');
  });
});
