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
  'update.newBadge': '新着',
  'update.updateNow': '今すぐ更新',
  'update.checkForUpdates': 'アップデートを確認',
};
