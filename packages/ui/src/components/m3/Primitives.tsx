/**
 * Lightweight Material Design 3 primitives (Button, IconButton, FAB, Chip, Switch,
 * Dialog, BottomSheet, SideSheet, Menu, SnackbarHost) wired to LIFO back navigation.
 */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerBackInterceptor } from '../../app/back';
import { useSnackbarStore } from '../../stores/snackbar';
import { Icon, type IconName } from './Icon';

export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'filled' | 'tonal' | 'outlined' | 'text' | undefined;
  readonly icon?: IconName | undefined;
}

export function Button({ variant = 'filled', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('m-btn', `m-btn--${variant}`, className)} {...rest}>
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
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    return registerBackInterceptor(() => {
      setOpen(false);
      return true;
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

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
      {open && (
        <div className="m-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              data-testid={item.testId}
              className="m-menu__item"
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
      )}
    </div>
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
