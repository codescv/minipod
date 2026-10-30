/**
 * Japanese (`ja`) dictionary matching `MessageKey`.
 */
import { en } from './en';
import type { Messages } from './zh-CN';

export const ja: Messages = {
  ...en,
  'nav.subscriptions': '登録番組',
  'nav.queue': 'キュー',
  'nav.settings': '設定',
  'nav.add': '番組を追加',
  'subs.title': '登録番組',
  'subs.emptyTitle': '登録番組はまだありません',
  'subs.findPodcasts': '番組を探す',
  'queue.title': 'キュー',
  'settings.title': '設定',
  'player.chapters': 'チャプター',
  'player.shownotes': '概要',
  'sleep.title': 'スリープタイマー',
};
