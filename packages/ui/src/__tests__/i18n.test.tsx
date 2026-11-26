import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DICTIONARIES, resolveLocale, type MessageKey } from '../i18n';
import { en } from '../i18n/en';
import { ja } from '../i18n/ja';
import { zhCN } from '../i18n/zh-CN';
import { formatHumanDuration, formatRelativeMinutes } from '../lib/format';
import { renderMiniPod } from './test-helpers';

/**
 * Keys whose values are intentionally identical between English and Japanese
 * (brand/protocol names, placeholders, or self-names).
 */
const ALLOWED_IDENTICAL_JA_EN_KEYS = new Set<MessageKey>([
  'app.name',
  'add.sourceApple',
  'add.sourcePodcastIndex',
  'add.sourceFyyd',
  'add.sourceGpodder',
  'settings.providerDrive',
  'settings.providerWebdav',
  'settings.providerGist',
  'settings.languageZhCN',
  'settings.languageEn',
  'settings.languageJa',
  'feedback.emailPlaceholder',
  'update.appliedStatus',
]);

describe('i18n Unification & Localization', () => {
  it('maintains 100% key parity across zh-CN, en, and ja with full Japanese translation coverage', () => {
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(en).sort();
    const jaKeys = Object.keys(ja).sort();

    expect(enKeys).toEqual(zhKeys);
    expect(jaKeys).toEqual(zhKeys);
    expect(Object.keys(DICTIONARIES).sort()).toEqual(['en', 'ja', 'zh-CN']);

    const untranslatedJa: string[] = [];
    for (const key of zhKeys as MessageKey[]) {
      expect(ja[key].trim().length, `ja[${key}] must not be empty`).toBeGreaterThan(0);
      expect(en[key].trim().length, `en[${key}] must not be empty`).toBeGreaterThan(0);
      expect(zhCN[key].trim().length, `zhCN[${key}] must not be empty`).toBeGreaterThan(0);
      if (ja[key] === en[key] && !ALLOWED_IDENTICAL_JA_EN_KEYS.has(key)) {
        untranslatedJa.push(key);
      }
    }
    expect(untranslatedJa).toEqual([]);
  });

  it('resolves explicit overrides and falls back to English for unsupported OS languages', () => {
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('ja', 'en-US')).toBe('ja');

    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-TW')).toBe('zh-CN');
    expect(resolveLocale('system', 'ja-JP')).toBe('ja');
    expect(resolveLocale('system', 'ja')).toBe('ja');
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale('system', 'fr-FR')).toBe('en');
    expect(resolveLocale('system', 'de-DE')).toBe('en');
    expect(resolveLocale('system', 'es-ES')).toBe('en');
    expect(resolveLocale('system', '')).toBe('en');
  });

  it('localizes formatHumanDuration and formatRelativeMinutes for en, zh-CN, and ja', () => {
    expect(formatHumanDuration(80 * 60_000, 'en')).toBe('1h 20m');
    expect(formatHumanDuration(60 * 60_000, 'en')).toBe('1h');
    expect(formatHumanDuration(48 * 60_000, 'en')).toBe('48 min');

    expect(formatHumanDuration(80 * 60_000, 'zh-CN')).toBe('1 小时 20 分钟');
    expect(formatHumanDuration(60 * 60_000, 'zh-CN')).toBe('1 小时');
    expect(formatHumanDuration(48 * 60_000, 'zh-CN')).toBe('48 分钟');

    expect(formatHumanDuration(80 * 60_000, 'ja')).toBe('1時間20分');
    expect(formatHumanDuration(60 * 60_000, 'ja')).toBe('1時間');
    expect(formatHumanDuration(48 * 60_000, 'ja')).toBe('48分');

    const now = 1_700_000_000_000;
    expect(formatRelativeMinutes(now - 10_000, now, 'en')).toBe('just now');
    expect(formatRelativeMinutes(now - 2 * 60_000, now, 'en')).toBe('2 min ago');
    expect(formatRelativeMinutes(now - 3 * 3_600_000, now, 'en')).toBe('3 h ago');
    expect(formatRelativeMinutes(now - 2 * 86_400_000, now, 'en')).toBe('2 d ago');

    expect(formatRelativeMinutes(now - 10_000, now, 'zh-CN')).toBe('刚刚');
    expect(formatRelativeMinutes(now - 2 * 60_000, now, 'zh-CN')).toBe('2 分钟前');
    expect(formatRelativeMinutes(now - 3 * 3_600_000, now, 'zh-CN')).toBe('3 小时前');
    expect(formatRelativeMinutes(now - 2 * 86_400_000, now, 'zh-CN')).toBe('2 天前');

    expect(formatRelativeMinutes(now - 10_000, now, 'ja')).toBe('たった今');
    expect(formatRelativeMinutes(now - 2 * 60_000, now, 'ja')).toBe('2分前');
    expect(formatRelativeMinutes(now - 3 * 3_600_000, now, 'ja')).toBe('3時間前');
    expect(formatRelativeMinutes(now - 2 * 86_400_000, now, 'ja')).toBe('2日前');
  });

  it('switches UI language immediately from SettingsPage without reload and updates document.documentElement.lang and About dialog labels', async () => {
    const { host } = renderMiniPod({
      width: 1024,
      hostOptions: {
        initialSettings: { uiLanguage: 'en' },
      },
    });

    await screen.findByText('Syntax & Signal');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByTestId('desktop-nav-rail')).toHaveAttribute('aria-label', 'Main navigation');

    fireEvent.click(screen.getByTestId('nav-rail-settings'));
    const langSelect = (await screen.findByTestId('settings-language-select')) as HTMLSelectElement;
    expect(langSelect.value).toBe('en');
    const optionValues = Array.from(langSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(['system', 'zh-CN', 'en', 'ja']);

    // Switch to Japanese: immediate update across nav, settings, html[lang], and About dialog
    fireEvent.change(langSelect, { target: { value: 'ja' } });
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ja');
      expect(screen.getByTestId('nav-rail-subscriptions')).toHaveTextContent('登録番組');
      expect(screen.getByTestId('nav-rail-queue')).toHaveTextContent('キュー');
      expect(screen.getByTestId('nav-rail-settings')).toHaveTextContent('設定');
      expect(screen.getByTestId('desktop-nav-rail')).toHaveAttribute(
        'aria-label',
        'メインナビゲーション',
      );
    });
    expect((await host.settings.get()).uiLanguage).toBe('ja');

    fireEvent.click(screen.getByTestId('settings-row-about'));
    const aboutJa = await screen.findByTestId('settings-about-dialog');
    expect(aboutJa).toHaveTextContent('プラットフォーム:');
    expect(aboutJa).toHaveTextContent('デバイス ID:');
    expect(aboutJa).not.toHaveTextContent('Platform:');
    expect(aboutJa).not.toHaveTextContent('Device ID:');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));

    // Switch to Simplified Chinese: immediate update
    fireEvent.change(langSelect, { target: { value: 'zh-CN' } });
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(screen.getByTestId('nav-rail-subscriptions')).toHaveTextContent('订阅');
      expect(screen.getByTestId('desktop-nav-rail')).toHaveAttribute('aria-label', '主导航');
    });

    fireEvent.click(screen.getByTestId('settings-row-about'));
    const aboutZh = await screen.findByTestId('settings-about-dialog');
    expect(aboutZh).toHaveTextContent('平台：');
    expect(aboutZh).toHaveTextContent('设备 ID：');
  });
});
