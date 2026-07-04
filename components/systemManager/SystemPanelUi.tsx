import { Loader2, RefreshCw, Search, Unplug } from 'lucide-react';
import React, { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

function splitPanelMessage(message: string): string[] {
  return message.match(/[^。.!?]+[。.!?]?/g)?.map((line) => line.trim()).filter(Boolean) ?? [message];
}

function SystemPanelMessage({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  const lines = splitPanelMessage(message);
  if (lines.length <= 1) {
    return <span className={className}>{message}</span>;
  }
  return (
    <span className={className}>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

export const SystemPanelShell = memo(function SystemPanelShell({
  children,
  section,
  className,
}: {
  children: ReactNode;
  section?: string;
  className?: string;
}) {
  return (
    <div
      className={cn('h-full flex flex-col bg-background overflow-hidden', className)}
      data-section={section}
    >
      {children}
    </div>
  );
});

export const SystemPanelToolbar = memo(function SystemPanelToolbar({
  children,
  trailing,
}: {
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="shrink-0 px-2 py-1.5 border-b border-border/50 flex items-center gap-1.5">
      <div className="flex flex-1 min-w-0 items-center gap-1.5">{children}</div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
    </div>
  );
});

export const SystemPanelSearch = memo(function SystemPanelSearch({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onEnter?: () => void;
}) {
  return (
    <div className="relative flex-1 min-w-0">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 pl-7 text-xs bg-muted/30 border-none"
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
      />
    </div>
  );
});

export const SystemPanelIconButton = memo(function SystemPanelIconButton({
  title,
  onClick,
  disabled,
  destructive,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={title}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              'shrink-0 h-7 w-7 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none',
              destructive
                ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            )}
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
});

export const SystemPanelRefreshButton = memo(function SystemPanelRefreshButton({
  title,
  loading,
  onClick,
}: {
  title: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <SystemPanelIconButton title={title} onClick={onClick} disabled={loading}>
      <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
    </SystemPanelIconButton>
  );
});

export const SystemPanelSegmented = memo(function SystemPanelSegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border/30 overflow-x-auto">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            'shrink-0 px-2 py-0.5 rounded text-[10px] transition-colors whitespace-nowrap',
            value === option.id
              ? 'bg-muted text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
});

export const SystemPanelMetaBar = memo(function SystemPanelMetaBar({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/30 min-h-[28px]">
      <div className="flex-1 min-w-0 truncate">{children}</div>
      {trailing}
    </div>
  );
});

export const SystemPanelEmpty = memo(function SystemPanelEmpty({
  icon: Icon,
  message,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-muted-foreground text-center">
      <Icon size={24} className="opacity-40 mb-2" />
      <SystemPanelMessage message={message} className="max-w-[260px] text-xs leading-5" />
    </div>
  );
});

export const SystemPanelLoading = memo(function SystemPanelLoading({
  message,
}: {
  message: string;
}) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center px-4 py-10 text-center text-xs text-muted-foreground">
      <Loader2 size={18} className="mb-2 animate-spin opacity-70" />
      <span>{message}</span>
    </div>
  );
});

export const SystemPanelError = memo(function SystemPanelError({
  message,
  onRetry,
  retryLabel,
  loading,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-6 py-10 text-center text-muted-foreground">
      <Unplug size={24} className="mb-2 opacity-40" />
      <SystemPanelMessage message={message} className="max-w-[260px] break-words text-xs leading-5" />
      {onRetry && retryLabel && (
        <button
          type="button"
          onClick={onRetry}
          disabled={loading}
          className="mt-3 inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          {retryLabel}
        </button>
      )}
    </div>
  );
});

export const SystemPanelInlineError = memo(function SystemPanelInlineError({
  message,
  onRetry,
  retryLabel,
  loading,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  loading?: boolean;
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground border-b border-border/30 bg-muted/20">
      <Unplug size={12} className="shrink-0 opacity-60" />
      <span className="min-w-0 truncate">{message}</span>
      {onRetry && retryLabel && (
        <button
          type="button"
          onClick={onRetry}
          disabled={loading}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw size={10} className={cn(loading && 'animate-spin')} />
          {retryLabel}
        </button>
      )}
    </div>
  );
});

export const SystemPanelList = memo(function SystemPanelList({
  children,
}: {
  children: ReactNode;
}) {
  // No divide-y here: the collapsible wrapper stays mounted at zero height
  // during its exit animation, and a divider on it would add a moving 1px
  // seam. Rows carry their own border-b instead.
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {children}
    </div>
  );
});

export const SystemPanelRow = memo(function SystemPanelRow({
  selected,
  onClick,
  depth = 0,
  leading,
  title,
  subtitle,
  trailing,
  actions,
  className,
}: {
  selected?: boolean;
  onClick?: () => void;
  depth?: number;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const content = (
    <>
      {leading}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">{title}</div>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground truncate mt-0.5">{subtitle}</div>
        )}
      </div>
      {trailing}
      {actions && (
        <div
          className="flex shrink-0 items-center justify-end gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </>
  );

  const rowClassName = cn(
    'group flex items-center gap-2.5 pr-2.5 py-2.5 min-h-[44px] border-b border-border/30',
    selected && 'bg-accent/30',
    onClick && 'cursor-pointer hover:bg-accent/50',
    className,
  );
  const style = { paddingLeft: 12 + depth * 14 };

  if (onClick) {
    // Not a <button>: trailing/actions hold real buttons, and interactive
    // content may not nest inside a button element.
    return (
      <div
        role="button"
        tabIndex={0}
        className={cn('w-full text-left', rowClassName)}
        style={style}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <div className={rowClassName} style={style}>
      {content}
    </div>
  );
});

export const SystemPanelDetailStrip = memo(function SystemPanelDetailStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-b border-border/40 bg-muted/20 px-3 py-2', className)}>
      {children}
    </div>
  );
});

const COLLAPSE_MS = 180;

/**
 * Expand/collapse with a height animation (grid-template-rows 0fr→1fr, no
 * measuring). Children mount on open and unmount after the exit transition;
 * the last rendered children are kept during exit so collapse animates even
 * when the parent clears them together with the open flag.
 */
export function SystemPanelCollapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const lastChildrenRef = useRef<ReactNode>(children);
  if (open) lastChildrenRef.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames so the 0fr state paints before transitioning to 1fr.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setExpanded(false);
    const timer = setTimeout(() => {
      setMounted(false);
      lastChildrenRef.current = null;
    }, COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] ease-out motion-reduce:transition-none',
        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
      style={{ transitionDuration: `${COLLAPSE_MS}ms` }}
    >
      <div className="min-h-0 overflow-hidden">
        {open ? children : lastChildrenRef.current}
      </div>
    </div>
  );
}

export const SystemPanelActionChip = memo(function SystemPanelActionChip({
  title,
  onClick,
  destructive,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-6 px-2 inline-flex items-center gap-1 rounded text-[10px] transition-colors disabled:opacity-40',
        destructive
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/70',
      )}
    >
      {children}
    </button>
  );
});

export const SystemPanelMiniButton = memo(function SystemPanelMiniButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={title}
            disabled={disabled}
            onClick={onClick}
            className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors disabled:opacity-40"
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
});

/** Solid bright status pill — same palette as the vault entity icons. */
export const SystemPanelStatusBadge = memo(function SystemPanelStatusBadge({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'muted';
  children: ReactNode;
}) {
  return (
    <span className={cn(
      // h-6 matches SystemPanelRoundButton so pills and round buttons align.
      'inline-flex shrink-0 min-w-[52px] h-6 items-center justify-center text-[10px] font-medium px-2 rounded-full tabular-nums',
      tone === 'success' && 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950',
      tone === 'warning' && 'bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950',
      tone === 'muted' && 'bg-slate-500 text-white dark:bg-slate-400 dark:text-slate-950',
    )}>
      {children}
    </span>
  );
});

/** Always-visible round icon button for list-row quick actions. */
export const SystemPanelRoundButton = memo(function SystemPanelRoundButton({
  title,
  onClick,
  disabled,
  destructive,
  loading,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Shows a spinner instead of the icon and disables the button. */
  loading?: boolean;
  children: ReactNode;
}) {
  const isDisabled = disabled || loading;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={title}
            disabled={isDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            className={cn(
              'h-6 w-6 shrink-0 rounded-full flex items-center justify-center bg-muted/60 text-muted-foreground transition-colors disabled:opacity-40',
              destructive
                ? 'hover:bg-destructive/20 hover:text-destructive'
                : 'hover:bg-muted hover:text-foreground',
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
});

/** Small uppercase section divider inside expanded details. */
export const SystemPanelSectionHeader = memo(function SystemPanelSectionHeader({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/30 bg-muted/10">
      <div className="flex-1 min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </div>
      {trailing}
    </div>
  );
});

export const SystemPanelInspectBlock = memo(function SystemPanelInspectBlock({
  title,
  data,
  onClose,
  closeLabel,
}: {
  title: string;
  data: Record<string, unknown>;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <SystemPanelDetailStrip>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-medium">{title}</span>
        {onClose && closeLabel && (
          <button type="button" onClick={onClose} className="text-[10px] text-muted-foreground hover:text-foreground">
            {closeLabel}
          </button>
        )}
      </div>
      <pre className="font-mono text-[10px] text-muted-foreground overflow-auto max-h-40 whitespace-pre-wrap break-all leading-relaxed">
        {JSON.stringify(data, null, 2)}
      </pre>
    </SystemPanelDetailStrip>
  );
});
