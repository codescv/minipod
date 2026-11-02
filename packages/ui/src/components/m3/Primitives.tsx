/**
 * Lightweight Material Design 3 primitives (Button, IconButton, FAB, Chip, Switch,
 * Dialog, BottomSheet, SideSheet, Menu, SnackbarHost) wired to LIFO back navigation.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { registerBackInterceptor } from '../../app/back';
import {
  clearArtworkCacheForTests,
  getPinnedArtworkCount,
  getRememberedCandidateIndex,
  isArtworkLoaded,
  pinLoadedArtwork,
  preloadArtworkUrls,
  rememberResolvedCandidate,
} from '../../lib/artwork-cache';
import { clearTextSelection, suppressNativeContextMenu } from '../../lib/text-selection';
import { useSnackbarStore } from '../../stores/snackbar';
import { Icon, type IconName } from './Icon';

export {
  clearArtworkCacheForTests,
  getPinnedArtworkCount,
  getRememberedCandidateIndex,
  isArtworkLoaded,
  pinLoadedArtwork,
  preloadArtworkUrls,
  rememberResolvedCandidate,
};

export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'filled' | 'tonal' | 'outlined' | 'text' | undefined;
  readonly icon?: IconName | undefined;
}

export function Button({
  variant = 'filled',
  icon,
  className,
  children,
  type = 'button',
  onContextMenu,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('m-btn', `m-btn--${variant}`, className)}
      {...rest}
      onContextMenu={suppressNativeContextMenu(onContextMenu)}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: IconName;
  readonly label: string;
  readonly variant?: 'standard' | 'filled' | 'tonal' | undefined;
  readonly large?: boolean | undefined;
  readonly iconSize?: number | undefined;
  readonly iconClassName?: string | undefined;
}

export function IconButton({
  icon,
  label,
  variant = 'standard',
  large,
  iconSize,
  iconClassName,
  className,
  type = 'button',
  onContextMenu,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'm-icon-btn',
        variant !== 'standard' && `m-icon-btn--${variant}`,
        large && 'm-icon-btn--large',
        className,
      )}
      {...rest}
      onContextMenu={suppressNativeContextMenu(onContextMenu)}
    >
      <Icon name={icon} size={iconSize ?? (large ? 30 : 22)} className={iconClassName} />
    </button>
  );
}

export function FAB({
  icon = 'add',
  label,
  floating = false,
  onClick,
  testId,
}: {
  readonly icon?: IconName | undefined;
  readonly label: string;
  readonly floating?: boolean | undefined;
  readonly onClick: () => void;
  readonly testId?: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cx('m-fab', floating && 'm-fab--floating')}
      onClick={onClick}
      onContextMenu={suppressNativeContextMenu()}
    >
      <Icon name={icon} size={24} />
    </button>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  testId,
}: {
  readonly selected?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={Boolean(selected)}
      data-testid={testId}
      className={cx('m-chip', selected && 'is-selected')}
      onClick={onClick}
      onContextMenu={suppressNativeContextMenu()}
    >
      {selected && <Icon name="check" size={16} />}
      <span>{children}</span>
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cx('m-switch', checked && 'is-checked')}
      onClick={() => onChange(!checked)}
    >
      <span className="m-switch__thumb" />
    </button>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  testId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode | undefined;
  readonly testId?: string | undefined;
}) {
  useEffect(() => {
    if (!open) return;
    return registerBackInterceptor(() => {
      onClose();
      return true;
    });
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  const node = (
    <div className="m-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="m-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-testid={testId}
      >
        <h2 style={{ margin: 0, font: 'var(--md-sys-typescale-headline-small)' }}>{title}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
        {actions && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{actions}</div>}
      </div>
    </div>
  );
  return typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;
}

export function BottomSheet({
  open,
  onClose,
  title,
  fullHeight = false,
  registerBack = true,
  children,
  testId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string | undefined;
  readonly fullHeight?: boolean | undefined;
  readonly registerBack?: boolean | undefined;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  useEffect(() => {
    if (!open || !registerBack) return;
    return registerBackInterceptor(() => {
      onClose();
      return true;
    });
  }, [open, onClose, registerBack]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  const node = (
    <div className="m-scrim m-scrim--bottom" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={cx('m-bottom-sheet', fullHeight && 'm-bottom-sheet--full')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
  return typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;
}

export function SideSheet({
  open,
  onClose,
  title,
  headerActions,
  closeLabel = 'Close',
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly headerActions?: ReactNode | undefined;
  readonly closeLabel?: string | undefined;
  readonly children: ReactNode;
}) {
  if (!open) return null;
  return (
    <aside className="m-side-sheet" aria-label={typeof title === 'string' ? title : undefined} data-testid="desktop-side-sheet">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px 10px 16px',
          borderBottom: '1px solid var(--md-sys-color-outline-variant)',
        }}
      >
        <div style={{ flex: 1, font: 'var(--md-sys-typescale-title-medium)' }}>{title}</div>
        {headerActions}
        <IconButton icon="close" label={closeLabel} onClick={onClose} />
      </header>
      <div className="m-side-sheet__body">{children}</div>
    </aside>
  );
}

export interface MenuEntry {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName | undefined;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly onSelect: () => void;
}

const VIEWPORT_MARGIN_PX = 8;

function clampCoord(val: number, maxVal: number): number {
  const safeVal = Number.isFinite(val) ? val : VIEWPORT_MARGIN_PX;
  return Math.max(VIEWPORT_MARGIN_PX, Math.min(safeVal, Math.max(VIEWPORT_MARGIN_PX, maxVal)));
}

export function Menu({
  label,
  items,
  icon = 'more',
  testId,
}: {
  readonly label: string;
  readonly items: readonly MenuEntry[];
  readonly icon?: IconName | undefined;
  readonly testId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ readonly left: number; readonly top: number }>({
    left: VIEWPORT_MARGIN_PX,
    top: VIEWPORT_MARGIN_PX,
  });
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    clearTextSelection();
    return registerBackInterceptor(() => {
      setOpen(false);
      return true;
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const menuEl = menuRef.current;

    // Measure natural unconstrained size inside viewport first
    menuEl.style.left = `${VIEWPORT_MARGIN_PX}px`;
    menuEl.style.top = `${VIEWPORT_MARGIN_PX}px`;
    const menuRect = menuEl.getBoundingClientRect();

    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

    const left = clampCoord(anchorRect.right - menuRect.width, vw - menuRect.width - VIEWPORT_MARGIN_PX);
    let desiredTop = anchorRect.bottom + 4;
    if (desiredTop + menuRect.height > vh - VIEWPORT_MARGIN_PX) {
      const aboveTop = anchorRect.top - menuRect.height - 4;
      desiredTop =
        aboveTop >= VIEWPORT_MARGIN_PX
          ? aboveTop
          : vh - menuRect.height - VIEWPORT_MARGIN_PX;
    }
    const top = clampCoord(desiredTop, vh - menuRect.height - VIEWPORT_MARGIN_PX);

    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    setCoords((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const onOutsideDown = (e: Event) => {
      const target = e.target as Node | null;
      if (
        target &&
        !anchorRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      setOpen(false);
    };
    const onResize = () => setOpen(false);

    document.addEventListener('pointerdown', onOutsideDown);
    document.addEventListener('mousedown', onOutsideDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onOutsideDown);
      document.removeEventListener('mousedown', onOutsideDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const popup = open ? (
    <div
      ref={menuRef}
      className="m-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        right: 'auto',
        bottom: 'auto',
        zIndex: 200,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
        overflowY: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={suppressNativeContextMenu()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          data-testid={item.testId}
          className="m-menu__item"
          onContextMenu={suppressNativeContextMenu()}
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
        >
          {item.icon && <Icon name={item.icon} size={18} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="m-menu-anchor" ref={anchorRef}>
      <IconButton
        icon={icon}
        label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {popup && (typeof document !== 'undefined' && document.body ? createPortal(popup, document.body) : popup)}
    </div>
  );
}

export interface ContextMenuProps {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  readonly items: readonly MenuEntry[];
  readonly testId?: string | undefined;
}

export function ContextMenu({ open, x, y, onClose, items, testId }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // v0.1.25: the menu portals under the still-pressed finger after a long press; clear any
  // selection Android WebView already started so no handles appear on the menu items.
  useLayoutEffect(() => {
    if (open) clearTextSelection();
  }, [open, x, y]);

  // The WebView's native long-press (~500 ms) can still fire after the menu opened (~450 ms):
  // drop any selection that lands inside the menu while it is open.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onSelectionChange = () => {
      try {
        const sel = window.getSelection?.();
        const anchor = sel?.anchorNode ?? null;
        if (sel && !sel.isCollapsed && anchor && menuRef.current?.contains(anchor)) {
          clearTextSelection();
        }
      } catch {
        // Selection API unavailable.
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [open]);
  const [coords, setCoords] = useState<{ readonly left: number; readonly top: number }>({
    left: Math.max(VIEWPORT_MARGIN_PX, x),
    top: Math.max(VIEWPORT_MARGIN_PX, y),
  });

  useEffect(() => {
    if (!open) return;
    return registerBackInterceptor(() => {
      onClose();
      return true;
    });
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const menuEl = menuRef.current;

    menuEl.style.left = `${VIEWPORT_MARGIN_PX}px`;
    menuEl.style.top = `${VIEWPORT_MARGIN_PX}px`;
    const menuRect = menuEl.getBoundingClientRect();

    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

    const left = clampCoord(x, vw - menuRect.width - VIEWPORT_MARGIN_PX);
    const top = clampCoord(y, vh - menuRect.height - VIEWPORT_MARGIN_PX);

    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    setCoords((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [open, x, y, items.length]);

  useEffect(() => {
    if (!open) return;
    const onOutsideDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && !menuRef.current?.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      onClose();
    };
    const onResize = () => onClose();

    document.addEventListener('pointerdown', onOutsideDown);
    document.addEventListener('mousedown', onOutsideDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onOutsideDown);
      document.removeEventListener('mousedown', onOutsideDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, onClose]);

  if (!open) return null;

  const node = (
    <div
      ref={menuRef}
      className="m-menu"
      role="menu"
      data-testid={testId}
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        right: 'auto',
        bottom: 'auto',
        zIndex: 200,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
        overflowY: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={suppressNativeContextMenu()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          data-testid={item.testId}
          className="m-menu__item"
          onContextMenu={suppressNativeContextMenu()}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon && <Icon name={item.icon} size={18} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );

  return typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;
}

export function nonEmptyUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function shouldUseImageProxy(platform?: string): boolean {
  return platform === 'desktop' || platform === 'node' || platform === 'android';
}

export function buildArtworkCandidates(
  src?: string | null,
  fallbackSrc?: string | null,
  allowProxyFallback = false,
  extraFallbackSrc?: string | null,
): readonly string[] {
  const candidates: string[] = [];
  const pushWithOptionalProxy = (raw?: string | null) => {
    const clean = nonEmptyUrl(raw);
    if (!clean) return;
    if (!candidates.includes(clean)) {
      candidates.push(clean);
    }
    if (allowProxyFallback && /^https?:\/\//i.test(clean)) {
      const proxied = `/api/image-proxy?url=${encodeURIComponent(clean)}`;
      if (!candidates.includes(proxied)) {
        candidates.push(proxied);
      }
    }
  };

  pushWithOptionalProxy(src);
  pushWithOptionalProxy(extraFallbackSrc);
  pushWithOptionalProxy(fallbackSrc);
  return candidates;
}

export interface ArtworkImageProps {
  readonly src?: string | null | undefined;
  readonly fallbackSrc?: string | null | undefined;
  readonly extraFallbackSrc?: string | null | undefined;
  readonly allowProxyFallback?: boolean | undefined;
  readonly placeholder: ReactNode;
  readonly alt?: string | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly title?: string | undefined;
  readonly loading?: 'lazy' | 'eager' | undefined;
  readonly draggable?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly onClick?: ((e: ReactMouseEvent<HTMLImageElement>) => void) | undefined;
}

export function ArtworkImage({
  src,
  fallbackSrc,
  extraFallbackSrc,
  allowProxyFallback = false,
  placeholder,
  alt = '',
  className,
  style,
  title,
  loading,
  draggable,
  testId,
  onClick,
}: ArtworkImageProps) {
  const candidates = buildArtworkCandidates(src, fallbackSrc, allowProxyFallback, extraFallbackSrc);
  const candidatesKey = candidates.join('\n');
  const rememberedIdx = getRememberedCandidateIndex(candidatesKey) ?? 0;
  const defaultIdx =
    rememberedIdx >= 0 && rememberedIdx < candidates.length ? rememberedIdx : 0;

  const [errorState, setErrorState] = useState<{ readonly key: string; readonly index: number }>({
    key: candidatesKey,
    index: defaultIdx,
  });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  const activeIdx = errorState.key === candidatesKey ? errorState.index : defaultIdx;
  const activeSrc = candidates[activeIdx];

  if (!activeSrc) {
    return <>{placeholder}</>;
  }

  const cached = loadedSrc === activeSrc || isArtworkLoaded(activeSrc);

  return (
    <img
      src={activeSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      className={className}
      style={style}
      title={title}
      loading={cached ? 'eager' : loading}
      decoding={cached ? 'sync' : 'async'}
      draggable={draggable}
      data-testid={testId}
      data-artwork-cached={cached ? 'true' : 'false'}
      onClick={onClick}
      onLoad={() => {
        pinLoadedArtwork(activeSrc);
        rememberResolvedCandidate(candidatesKey, activeIdx);
        setLoadedSrc(activeSrc);
      }}
      onError={() => {
        setErrorState((prev) => {
          const curIdx = prev.key === candidatesKey ? prev.index : defaultIdx;
          return { key: candidatesKey, index: curIdx + 1 };
        });
      }}
    />
  );
}

export function SnackbarHost() {
  const head = useSnackbarStore((s) => s.queue[0]);
  const dismiss = useSnackbarStore((s) => s.dismiss);

  useEffect(() => {
    if (!head) return;
    const ms = head.durationMs ?? (head.action ? 7000 : 4000);
    const timer = setTimeout(() => dismiss(head.id), ms);
    return () => clearTimeout(timer);
  }, [head, dismiss]);

  if (!head) return null;
  return (
    <div className="m-snackbar" role="status" aria-live="polite" data-testid="snackbar">
      <span className="m-snackbar__text">{head.text}</span>
      {head.action && (
        <button
          type="button"
          className="m-snackbar__action"
          data-testid="snackbar-action"
          onClick={() => {
            head.action?.run();
            dismiss(head.id);
          }}
        >
          {head.action.label}
        </button>
      )}
      <IconButton
        icon="close"
        label="Dismiss"
        onClick={() => dismiss(head.id)}
        style={{ width: 36, height: 36, color: 'var(--md-sys-color-inverse-on-surface)' }}
      />
    </div>
  );
}
