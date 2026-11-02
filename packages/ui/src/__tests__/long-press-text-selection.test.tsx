/**
 * v0.1.25 "长按时有时选中按钮文字": long-press / context menus and buttons must never let the
 * Android WebView select button / menu item text.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Chip, ContextMenu, FAB, IconButton } from '../components/m3/Primitives';
import { clearTextSelection, suppressNativeContextMenu } from '../lib/text-selection';
import { renderMiniPod } from './test-helpers';

const stylesCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../theme/styles.css'),
  'utf8',
);

interface CssRule {
  readonly selectors: readonly string[];
  readonly body: string;
}

function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments)) !== null) {
    const selectors = m[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    rules.push({ selectors, body: m[2]! });
  }
  return rules;
}

function lastUserSelectFor(rules: readonly CssRule[], selector: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const decl = /(?:^|[;\s])user-select:\s*([a-z-]+)/.exec(rule.body);
    if (decl) value = decl[1];
  }
  return value;
}

/** Selects the text content of `node` (simulates the Android WebView long-press selection). */
function selectTextOf(node: Node): void {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.addRange(range);
}

describe('v0.1.25 long-press text selection guards', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  it('styles.css disables text selection + touch callout on chrome, buttons and menus but keeps inputs/shownotes selectable', () => {
    const rules = parseRules(stylesCss);
    const noSelect = [
      'body',
      'button',
      '[role="button"]',
      '[role="menuitem"]',
      '.m-btn',
      '.m-icon-btn',
      '.m-chip',
      '.m-fab',
      '.m-menu',
      '.m-menu__item',
      '.m-nav-bar',
      '.m-nav-rail',
      '.m-nav-item',
      '.m-appbar',
      '.m-mini-player',
      '.m-desktop-bar',
      '.m-expanded-player',
      '.m-settings-row',
      '.m-subs-expand-btn',
      '.m-inline-undo',
      '.m-snackbar',
    ];
    for (const selector of noSelect) {
      const rule = rules.find(
        (r) =>
          r.selectors.includes(selector) &&
          /(?:^|[;\s])user-select:\s*none/.test(r.body) &&
          /-webkit-user-select:\s*none/.test(r.body) &&
          /-webkit-touch-callout:\s*none/.test(r.body),
      );
      expect(rule, `${selector} must set user-select/-webkit-user-select/-webkit-touch-callout: none`).toBeDefined();
    }
    for (const selector of ['input', 'textarea', '[contenteditable="true"]', '.m-shownotes']) {
      expect(lastUserSelectFor(rules, selector), `${selector} stays selectable`).toBe('text');
      const rule = rules.find((r) => r.selectors.includes(selector) && /-webkit-user-select:\s*text/.test(r.body));
      expect(rule).toBeDefined();
    }
  });

  it('clearTextSelection removes active ranges and never throws without a Selection API', () => {
    const p = document.createElement('p');
    p.textContent = '删除已下载文件';
    document.body.appendChild(p);
    selectTextOf(p);
    expect(window.getSelection()!.toString()).toBe('删除已下载文件');
    clearTextSelection();
    expect(window.getSelection()!.rangeCount).toBe(0);
    p.remove();

    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      throw new Error('unsupported');
    });
    expect(() => clearTextSelection()).not.toThrow();
  });

  it('Button, IconButton, FAB and Chip suppress the native contextmenu (and still run custom handlers)', () => {
    const custom = vi.fn();
    render(
      <div>
        <Button data-testid="btn">删除已下载文件</Button>
        <Button data-testid="btn-custom" onContextMenu={custom}>
          Custom
        </Button>
        <IconButton icon="more" label="More" data-testid="icon-btn" />
        <FAB label="Add" onClick={() => {}} testId="fab" />
        <Chip onClick={() => {}} testId="chip">
          All
        </Chip>
      </div>,
    );
    for (const id of ['btn', 'btn-custom', 'icon-btn', 'fab', 'chip']) {
      // fireEvent returns false when the event's default action was prevented.
      expect(fireEvent.contextMenu(screen.getByTestId(id)), id).toBe(false);
    }
    expect(custom).toHaveBeenCalledTimes(1);

    const handler = vi.fn();
    const wrapped = suppressNativeContextMenu(handler);
    const preventDefault = vi.fn();
    wrapped({ defaultPrevented: false, preventDefault } as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ContextMenu clears an in-progress selection on open, guards selectionchange, and blocks contextmenu on .m-menu__item', () => {
    const p = document.createElement('p');
    p.textContent = 'Episode title under the finger';
    document.body.appendChild(p);
    selectTextOf(p);
    expect(window.getSelection()!.rangeCount).toBe(1);

    const onSelect = vi.fn();
    render(
      <ContextMenu
        open
        x={120}
        y={160}
        onClose={() => {}}
        testId="ctx"
        items={[{ key: 'del', label: '删除已下载文件', testId: 'ctx-del', onSelect }]}
      />,
    );
    expect(window.getSelection()!.rangeCount).toBe(0);

    const item = screen.getByTestId('ctx-del');
    expect(item).toHaveClass('m-menu__item');
    expect(fireEvent.contextMenu(item)).toBe(false);
    expect(fireEvent.contextMenu(screen.getByTestId('ctx'))).toBe(false);

    // Native long-press selection arriving after the menu opened is dropped.
    selectTextOf(item);
    expect(window.getSelection()!.rangeCount).toBe(1);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(window.getSelection()!.rangeCount).toBe(0);
    p.remove();
  });

  it('queue row long-press (useRowGestures) clears the selection before queue-context-menu opens', async () => {
    renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const row = screen.getByTestId('queue-row-1');

    const removeAllRanges = vi.spyOn(Selection.prototype, 'removeAllRanges');
    vi.useFakeTimers();
    fireEvent(
      row,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 220 }),
    );
    selectTextOf(row);
    removeAllRanges.mockClear();
    act(() => {
      vi.advanceTimersByTime(460);
    });
    expect(removeAllRanges).toHaveBeenCalled();
    expect(window.getSelection()!.rangeCount).toBe(0);
    fireEvent(
      row,
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 220 }),
    );
    vi.useRealTimers();
    expect(screen.getByTestId('queue-context-menu')).toBeInTheDocument();
  });

  it('subscriptions grid tile long-press clears the selection before subs-context-menu opens', async () => {
    const { host } = renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    const feeds = await host.feeds.list();
    const tile = screen.getByTestId(`feed-tile-${feeds[0]!.feedKey}`);

    vi.useFakeTimers();
    fireEvent(
      tile,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 240, clientY: 180 }),
    );
    selectTextOf(tile);
    expect(window.getSelection()!.rangeCount).toBe(1);
    act(() => {
      vi.advanceTimersByTime(460);
    });
    expect(window.getSelection()!.rangeCount).toBe(0);
    fireEvent(
      tile,
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 240, clientY: 180 }),
    );
    vi.useRealTimers();
    expect(screen.getByTestId('subs-context-menu')).toBeInTheDocument();
  });

  it('right-click on an episode row clears the selection and blocks the native menu', async () => {
    renderMiniPod({ width: 1024 });
    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));
    const row = screen.getByTestId('queue-row-0');
    selectTextOf(row);
    expect(fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })).toBe(false);
    expect(window.getSelection()!.rangeCount).toBe(0);
    expect(screen.getByTestId('queue-context-menu')).toBeInTheDocument();
  });
});
