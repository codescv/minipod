/**
 * Fetch-stream SSE client for `/api/events` (`HostEvent` frames).
 *
 * Uses streaming `fetch` rather than browser-only `EventSource` so it works identically
 * in real browsers AND in Node/Vitest integration tests via injected `fetchImpl`.
 */
import type { HostEvent, Unsubscribe } from '@minipod/core';

export class SseParser {
  private buffer = '';
  private currentDataLines: string[] = [];

  feed(chunk: string, onEvent: (data: string) => void): void {
    this.buffer += chunk;
    for (;;) {
      const nlIdx = this.buffer.indexOf('\n');
      if (nlIdx < 0) break;
      let line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (line === '') {
        if (this.currentDataLines.length > 0) {
          const payload = this.currentDataLines.join('\n');
          this.currentDataLines = [];
          onEvent(payload);
        }
        continue;
      }

      if (line.startsWith(':')) {
        continue; // comment / keep-alive
      }

      if (line.startsWith('data:')) {
        const val = line.slice('data:'.length);
        this.currentDataLines.push(val.startsWith(' ') ? val.slice(1) : val);
      }
    }
  }
}

export interface HostEventStreamOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly reconnectDelayMs?: number;
}

export class HostEventStream {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly reconnectDelayMs: number;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: HostEventStreamOptions) {
    this.url = options.url;
    this.fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_500;
  }

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    if (!this.disposed && !this.abortController) {
      this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopConnection();
      }
    };
  }

  emitLocal(event: HostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failure
      }
    }
  }

  private connect(): void {
    if (this.disposed || this.abortController) return;
    const ac = new AbortController();
    this.abortController = ac;

    void this.pump(ac.signal).catch(() => {
      if (this.abortController === ac) {
        this.abortController = null;
      }
      if (!this.disposed && this.listeners.size > 0) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelayMs);
        (this.reconnectTimer as unknown as { unref?: () => void })?.unref?.();
      }
    });
  }

  private async pump(signal: AbortSignal): Promise<void> {
    const resp = await this.fetchFn(this.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`SSE HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const text = decoder.decode(value, { stream: true });
      parser.feed(text, (jsonStr) => {
        try {
          const event = JSON.parse(jsonStr) as HostEvent;
          this.emitLocal(event);
        } catch {
          // ignore malformed frame
        }
      });
    }
  }

  private stopConnection(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopConnection();
    this.listeners.clear();
  }
}
