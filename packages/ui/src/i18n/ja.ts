/**
 * Japanese (`ja`) dictionary matching `MessageKey`.
 */
import { en } from './en';
import type { Messages } from './zh-CN';

export const ja: Messages = {
  ...en,
  'app.name': 'Podcasts',
  'nav.subscriptions': '登録番組',
  'nav.queue': 'キュー',
  'nav.settings': '設定',
  'nav.add': '番組を追加',
  'subs.title': '登録番組',
  'subs.emptyTitle': '登録番組はまだありません',
  'subs.findPodcasts': '番組を探す',
  'subs.timelineTitle': '最新のエピソード',
  'subs.expandAll': 'すべて表示 ({count})',
  'subs.collapse': '折りたたむ',
  'subs.loadMoreTimeline': 'もっと読み込む',
  'subs.longPressHint': '長押しまたは右クリックでメニューを表示',
  'queue.title': 'キュー',
  'settings.title': '設定',
  'player.chapters': 'チャプター',
  'player.shownotes': '概要',
  'sleep.title': 'スリープタイマー',
  'update.newBadge': '新着',
  'update.bannerTitle': 'Podcasts v{version} が利用可能です',
  'update.applyingUpdate': 'Podcasts を更新しています…',
  'update.upToDateSnack': 'Podcasts v{version} は最新です',
  'update.updateNow': '今すぐ更新',
  'update.checkForUpdates': 'アップデートを確認',
};
