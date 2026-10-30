/**
 * Minimalist i18n dictionary & hook (`zh-CN` default/auto + `en` + `ja`).
 */
import { useMemo } from 'react';
import type { AppSettings } from '@minipod/core';
import { useSettingsStore } from '../stores/settings';
import { en } from './en';
import { ja } from './ja';
import { zhCN, type MessageKey, type Messages } from './zh-CN';

export type { MessageKey, Messages } from './zh-CN';
export type ConcreteLocale = 'zh-CN' | 'en' | 'ja';

export const DICTIONARIES: Readonly<Record<ConcreteLocale, Messages>> = {
  'zh-CN': zhCN,
  en,
  ja,
};

export function resolveLocale(setting: AppSettings['uiLanguage']): ConcreteLocale {
  if (setting === 'zh-CN' || setting === 'en' || setting === 'ja') {
    return setting;
  }
  const navLang = typeof navigator !== 'undefined' ? (navigator.language || '').toLowerCase() : '';
  if (navLang.startsWith('zh')) return 'zh-CN';
  if (navLang.startsWith('ja')) return 'ja';
  if (navLang.startsWith('en')) return 'en';
  return 'zh-CN';
}

export type TranslateVars = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;

export function translate(locale: ConcreteLocale, key: MessageKey, vars?: TranslateVars): string {
  const dict = DICTIONARIES[locale] ?? zhCN;
  const template = dict[key] ?? zhCN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function createTranslator(locale: ConcreteLocale): Translate {
  return (key, vars) => translate(locale, key, vars);
}

export function useLocale(): ConcreteLocale {
  const uiLanguage = useSettingsStore((s) => s.settings.uiLanguage);
  return useMemo(() => resolveLocale(uiLanguage), [uiLanguage]);
}

export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => createTranslator(locale), [locale]);
}
