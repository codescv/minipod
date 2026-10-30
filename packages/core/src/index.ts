/**
 * @minipod/core public barrel.
 *
 * Sub-modules (ARCHITECTURE.md §2.1 / §4):
 *   ./util       sha1Hex · base64 · gzip · url · time
 *   ./http       BasicAuth helper · RedirectRecorder · userAgent
 *   ./discovery  UrlNormalizer · searchers · CombinedSearcher · registry · FeedUrlResolver · ItunesTopListLoader
 *   ./feed       xml tokenizer · TypeDetector · SyndParser + namespaces · HtmlFeedDiscoverer · Opml · identity
 *   ./chapters   sniff · id3 · vorbis · mp4 · psc · podcastindex-json · ChapterMerger · ChapterLoader · metadata
 *   ./sync       schema · hlc · fractional-index · merge · gc · SyncEngine · SyncScheduler · providers/*
 *   ./queue      queue ops over SyncStore shapes · AutoAdvancePolicy
 *   ./progress   ProgressRecorder policy · resume rule · completion rule
 */
export * from './types';
export * from './errors';
export * from './util';
export * from './http';
export * from './discovery';
export * from './feed';
export * from './chapters';
export * from './sync';
export * from './queue';
export * from './progress';
