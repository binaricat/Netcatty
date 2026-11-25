import { ArrowLeft, MoreVertical, X } from 'lucide-react';
import React, { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { cn } from '../../lib/utils';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ScrollArea } from './scroll-area';

export const DEFAULT_ASIDE_INLINE_WIDTH_PX = 380;
const MIN_ASIDE_INLINE_WIDTH_PX = 320;
const MAX_ASIDE_INLINE_WIDTH_PX = 720;

export function clampAsideInlineWidth(width: number): number {
    return Math.max(MIN_ASIDE_INLINE_WIDTH_PX, Math.min(MAX_ASIDE_INLINE_WIDTH_PX, width));
}

export interface AsidePanelResizeProps {
    resizable?: boolean;
    persistWidthStorageKey?: string;
    resizeAriaLabel?: string;
}

function parseInlineWidthPx(width: string): number {
    const arbitraryWidthMatch = width.match(/w-\[(.+)\]/);
    if (arbitraryWidthMatch) {
        const raw = arbitraryWidthMatch[1].trim();
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed)) return clampAsideInlineWidth(parsed);
    }

    switch (width) {
        case 'w-full':
        case 'w-screen':
            return DEFAULT_ASIDE_INLINE_WIDTH_PX;
        default:
            return DEFAULT_ASIDE_INLINE_WIDTH_PX;
    }
}

function readPersistedAsideWidth(storageKey: string | undefined, fallback: number): number {
    if (!storageKey) return fallback;
    const stored = localStorageAdapter.readNumber(storageKey);
    if (stored === null) return fallback;
    return clampAsideInlineWidth(stored);
}

const AsideActionMenuContext = createContext<(() => void) | null>(null);

// Props
interface AsidePanelProps extends AsidePanelResizeProps {
    open: boolean;
    onClose: () => void;
    title?: string;
    subtitle?: string;
    actions?: ReactNode;
    showBackButton?: boolean;
    onBack?: () => void;
    children: ReactNode;
    className?: string;
    headerClassName?: string;
    width?: string;
    layout?: AsidePanelLayout;
    /**
     * Optional stable identifier emitted as `data-section` on the panel
     * root. Used as a targeting hook for Custom CSS (Settings → Appearance).
     */
    dataSection?: string;
}

interface AsidePanelHeaderProps {
    title: string;
    subtitle?: string;
    actions?: ReactNode;
    onBack?: () => void;
    onClose: () => void;
    showBackButton?: boolean;
    className?: string;
}

// Header Component
const AsidePanelHeader: React.FC<AsidePanelHeaderProps> = ({
    title,
    subtitle,
    actions,
    onBack,
    onClose,
    showBackButton = false,
    className,
}) => {
    return (
        <div className={cn("px-4 py-3 flex items-center justify-between border-b border-border/60 app-no-drag shrink-0", className)}>
            <div className="flex items-center gap-2 min-w-0">
                {showBackButton && onBack && (
                    <button
                        onClick={onBack}
                        className="p-1 hover:bg-muted rounded-md transition-colors cursor-pointer shrink-0"
                    >
                        <ArrowLeft size={18} />
                    </button>
                )}
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold truncate">{title}</h3>
                    {subtitle && (
                        <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
                {actions}
                <button
                    onClick={onClose}
                    className="p-1.5 hover:bg-muted rounded-md transition-colors cursor-pointer"
                >
                    <X size={18} />
                </button>
            </div>
        </div>
    );
};

// Content Component (wraps children with scroll)
export const AsidePanelContent: React.FC<{ children: ReactNode; className?: string; scrollMode?: "custom" | "native" }> = ({
    children,
    className,
    scrollMode = "custom",
}) => {
    if (scrollMode === "native") return (
        <div data-aside-scroll-viewport className={cn("flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-y-contain host-tree-notes-scroll", className)}>
            <div className="p-4 space-y-4 min-w-0 overflow-hidden">{children}</div>
        </div>
    );
    return (
        <ScrollArea className={cn("flex-1 min-w-0 [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]>div]:!min-w-0", className)}>
            <div className="p-4 space-y-4 min-w-0 overflow-hidden">
                {children}
            </div>
        </ScrollArea>
    );
};

// Footer Component
export const AsidePanelFooter: React.FC<{ children: ReactNode; className?: string }> = ({
    children,
    className,
}) => {
    return (
        <div className={cn("px-4 py-3 border-t border-border/60 shrink-0", className)}>
            {children}
        </div>
    );
};

// Action Menu Component (for the ... button)
interface AsideActionMenuProps {
    children: ReactNode;
    triggerClassName?: string;
    ariaLabel?: string;
}

export const AsideActionMenu: React.FC<AsideActionMenuProps> = ({ children, triggerClassName, ariaLabel }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button aria-label={ariaLabel} className={cn("p-1.5 hover:bg-muted rounded-md transition-colors cursor-pointer", triggerClassName)}>
                    <MoreVertical size={18} />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="end">
                <AsideActionMenuContext.Provider value={close}>
                    {children}
                </AsideActionMenuContext.Provider>
            </PopoverContent>
        </Popover>
    );
};

export const invokeAsideActionMenuItemClick = (
    closeMenu: (() => void) | null,
    onClick?: () => void,
) => {
    closeMenu?.();
    onClick?.();
};

// Action Menu Item
export const AsideActionMenuItem: React.FC<{
    icon?: ReactNode;
    children: ReactNode;
    onClick?: () => void;
    variant?: 'default' | 'destructive';
}> = ({ icon, children, onClick, variant = 'default' }) => {
    const closeMenu = useContext(AsideActionMenuContext);

    return (
        <button
            onClick={() => invokeAsideActionMenuItemClick(closeMenu, onClick)}
            className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors cursor-pointer",
                variant === 'destructive'
                    ? "text-destructive hover:bg-destructive/10"
                    : "hover:bg-muted"
            )}
        >
            {icon}
            {children}
        </button>
    );
};

export type AsidePanelLayout = 'overlay' | 'inline';

// Simple Panel Component (no stack)
export const AsidePanel: React.FC<AsidePanelProps> = ({
    open,
    onClose,
    title,
    subtitle,
    actions,
    showBackButton,
    onBack,
    children,
    className,
    headerClassName,
    width = 'w-[380px]',
    layout = 'overlay',
    resizable = false,
    persistWidthStorageKey,
    resizeAriaLabel,
    dataSection,
}) => {
    const fallbackWidthPx = parseInlineWidthPx(width);
    const [panelWidthPx, setPanelWidthPx] = useState(() =>
        resizable ? readPersistedAsideWidth(persistWidthStorageKey, fallbackWidthPx) : fallbackWidthPx,
    );
    const [isResizing, setIsResizing] = useState(false);
    const resizeCleanupRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => () => resizeCleanupRef.current?.(), [open]);
    const effectivePanelWidthPx = resizable ? panelWidthPx : fallbackWidthPx;
    // Only containers opting into this constraint limit the rendered width.
    // Keep the animation's final minimum on the same cap as its width.
    const renderedWidth = resizable && layout === 'inline'
        ? `min(${effectivePanelWidthPx}px, var(--aside-inline-max-width, ${effectivePanelWidthPx}px))`
        : `${effectivePanelWidthPx}px`;
    // Resizable panels always use pixel width so overlay and inline share the same drag path.
    const usesPixelWidth = resizable || layout === 'inline';

    const panelStyle = usesPixelWidth
        ? ({
            width: renderedWidth,
            ['--aside-inline-width' as string]: renderedWidth,
        } as React.CSSProperties)
        : undefined;

    const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!resizable) return;

        event.preventDefault();
        event.stopPropagation();
        resizeCleanupRef.current?.();

        const startX = event.clientX;
        const startWidth = layout === 'inline'
            ? event.currentTarget.parentElement?.getBoundingClientRect().width || panelWidthPx
            : panelWidthPx;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        setIsResizing(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        let rafId: number | null = null;
        let pendingWidth: number | null = null;

        const cancelPendingFrame = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame?.(rafId);
                rafId = null;
            }
            pendingWidth = null;
        };

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const nextWidth = moveEvent.clientX === startX
                ? panelWidthPx
                : clampAsideInlineWidth(startWidth + startX - moveEvent.clientX);
            if (typeof window.requestAnimationFrame !== 'function') {
                setPanelWidthPx(nextWidth);
                return;
            }
            pendingWidth = nextWidth;
            if (rafId !== null) return;
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                if (pendingWidth !== null) {
                    const committedWidth = pendingWidth;
                    pendingWidth = null;
                    setPanelWidthPx(committedWidth);
                }
            });
        };
        const handlePointerUp = (upEvent: PointerEvent) => {
            cleanup();
            // A handle click is not a request to forget a larger preference.
            if (upEvent.clientX === startX) return;
            const nextWidth = clampAsideInlineWidth(startWidth + startX - upEvent.clientX);
            setPanelWidthPx(nextWidth);
            if (persistWidthStorageKey) {
                localStorageAdapter.writeNumber(persistWidthStorageKey, nextWidth);
            }
        };
        const cleanup = () => {
            resizeCleanupRef.current = null;
            cancelPendingFrame();
            setPanelWidthPx(panelWidthPx);
            setIsResizing(false);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', cleanup);
        };

        resizeCleanupRef.current = cleanup;
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', cleanup);
    }, [layout, panelWidthPx, persistWidthStorageKey, resizable]);

    if (!open) return null;

    return (
        <div className={cn(
            layout === 'inline'
                ? "relative split-panel-enter shrink-0 h-full min-h-0 max-w-full border-l border-border/60 bg-background flex flex-col app-no-drag overflow-hidden shadow-[-16px_0_32px_hsl(var(--foreground)/0.08)]"
                : "absolute right-0 top-0 bottom-0 max-w-full border-l border-border/60 bg-background z-30 flex flex-col app-no-drag overflow-hidden",
            layout === 'overlay' && !usesPixelWidth && width,
            isResizing && 'transition-none',
            className,
        )}
        style={panelStyle}
        data-section={dataSection}
        // Overlay panels float above content; native views (host browser)
        // must yield where they overlap instead of drawing over the panel.
        data-native-view-occluder={layout === 'overlay' ? '' : undefined}>
            {resizable ? (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={resizeAriaLabel}
                    className={cn(
                        'absolute left-0 top-0 z-40 h-full w-2 -translate-x-1/2 cursor-col-resize',
                        'after:absolute after:left-1/2 after:top-2 after:h-[calc(100%-16px)] after:w-px after:-translate-x-1/2 after:bg-border/0 after:transition-colors',
                        'hover:after:bg-border/70',
                        isResizing && 'after:bg-primary/70',
                    )}
                    onPointerDown={handleResizeStart}
                />
            ) : null}
            {title && (
                <AsidePanelHeader
                    title={title}
                    className={headerClassName}
                    subtitle={subtitle}
                    actions={actions}
                    onClose={onClose}
                    showBackButton={showBackButton}
                    onBack={onBack}
                />
            )}
            {children}
        </div>
    );
};

export default AsidePanel;
