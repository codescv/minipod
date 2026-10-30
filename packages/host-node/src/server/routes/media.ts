/**
 * `/media/:episodeKey` route mounting the HTTP 206 Byte-Range media proxy (`ARCHITECTURE.md §3.2`).
 */
import { Hono } from 'hono';
import type { MediaProxy } from '../../net/range-proxy';

export function createMediaRoutes(mediaProxy: MediaProxy): Hono {
  const media = new Hono();

  media.on(['GET', 'HEAD'], '/:episodeKey', (c) => {
    const episodeKey = c.req.param('episodeKey');
    const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
    return mediaProxy.handleEpisodeMedia({
      episodeKey,
      method,
      rangeHeader: c.req.header('range'),
      ifRangeHeader: c.req.header('if-range'),
      signal: c.req.raw.signal,
    });
  });

  return media;
}
