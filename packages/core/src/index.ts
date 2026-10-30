/**
 * @minipod/core public barrel.
 *
 * Sub-module barrels are created by coder-core; each must keep this root barrel
 * compiling. Planned sub-modules (ARCHITECTURE.md §2.1 / §4):
 *   ./util       sha1Hex · base64 · gzip · url · time
 *   ./http       BasicAuth helper · RedirectRecorder · userAgent
 *   ./discovery  UrlNormalizer · searchers · CombinedSearcher · registry · FeedUrlResolver · ItunesTopListLoader
 *   ./feed       xml tokenizer · TypeDetector · SyndParser + namespaces · HtmlFeedDiscoverer · Opml · identity
 *   ./chapters   sniff · id3 · vorbis · mp4 · psc · podcastindex-json · ChapterMerger · ChapterLoader
 *   ./sync       schema · hlc · fractional-index · merge · gc · SyncEngine · SyncScheduler · providers/*
 *   ./queue      queue ops over SyncStore shapes
 *   ./progress   ProgressRecorder policy · resume rule · AutoAdvancePolicy
 */
export * from './types';
export * from './errors';
