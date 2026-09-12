/**
 * SFTP Breadcrumb navigation component
 */

import { ChevronDown, ChevronRight, Home, MoreHorizontal } from 'lucide-react';
import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { getSftpBreadcrumbSegments, getSftpPathRoot, isWindowsPath, isWindowsRoot } from '../../application/state/sftp/utils';
import type { SftpWindowsPathOptions } from '../../application/state/sftp/utils';
import { Dropdown, DropdownContent, DropdownTrigger } from '../ui/dropdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';

interface SftpBreadcrumbProps {
    path: string;
    onNavigate: (path: string) => void;
    onHome: () => void;
    /** Maximum number of visible path segments before truncation (default: 4) */
    maxVisibleParts?: number;
    isLocal?: boolean;
    onListDrives?: () => Promise<string[]>;
    /** When true, treat //host/share as Windows UNC (Windows-style panes). */
    acceptForwardSlashUnc?: boolean;
}

type BreadcrumbSegment = ReturnType<typeof getSftpBreadcrumbSegments>['segments'][number];

export type SftpBreadcrumbVisiblePart = {
    segment: BreadcrumbSegment;
    originalIndex: number;
};

/** Clamp the visible-segment budget to a positive integer. */
export function normalizeSftpBreadcrumbMaxVisibleParts(maxVisibleParts: number): number {
    if (!Number.isFinite(maxVisibleParts)) return 1;
    return Math.max(1, Math.floor(maxVisibleParts));
}

/**
 * Prefer the path tail when truncating, but always keep the first segment so the
 * root / drive / UNC share stays clickable. Budget of 1 shows only the first segment.
 */
export function resolveSftpBreadcrumbVisibleParts({
    segments,
    maxVisibleParts,
}: {
    segments: BreadcrumbSegment[];
    maxVisibleParts: number;
}): {
    visibleParts: SftpBreadcrumbVisiblePart[];
    hiddenParts: SftpBreadcrumbVisiblePart[];
    needsTruncation: boolean;
} {
    const budget = normalizeSftpBreadcrumbMaxVisibleParts(maxVisibleParts);
    if (segments.length <= budget) {
        return {
            visibleParts: segments.map((segment, idx) => ({ segment, originalIndex: idx })),
            hiddenParts: [],
            needsTruncation: false,
        };
    }

    if (budget === 1) {
        return {
            visibleParts: [{ segment: segments[0], originalIndex: 0 }],
            hiddenParts: segments.slice(1).map((segment, idx) => ({
                segment,
                originalIndex: idx + 1,
            })),
            needsTruncation: true,
        };
    }

    const lastPartsCount = budget - 1;
    const lastParts = segments.slice(-lastPartsCount).map((segment, idx) => ({
        segment,
        originalIndex: segments.length - lastPartsCount + idx,
    }));
    const hiddenParts = segments.slice(1, -lastPartsCount).map((segment, idx) => ({
        segment,
        originalIndex: idx + 1,
    }));

    return {
        visibleParts: [{ segment: segments[0], originalIndex: 0 }, ...lastParts],
        hiddenParts,
        needsTruncation: true,
    };
}

/** Split pinned leading chrome from the scrollable trailing chips. */
export function splitSftpBreadcrumbPinnedParts(visibleParts: SftpBreadcrumbVisiblePart[]): {
    leadingPart: SftpBreadcrumbVisiblePart | null;
    trailingParts: SftpBreadcrumbVisiblePart[];
} {
    if (visibleParts.length === 0) {
        return { leadingPart: null, trailingParts: [] };
    }
    return {
        leadingPart: visibleParts[0],
        trailingParts: visibleParts.slice(1),
    };
}

/** True when truncated middle segments need an ellipsis affordance. */
export function shouldShowSftpBreadcrumbEllipsis({
    needsTruncation,
    hiddenPartsCount,
}: {
    needsTruncation: boolean;
    hiddenPartsCount: number;
}): boolean {
    return needsTruncation && hiddenPartsCount > 0;
}

/** Scroll a breadcrumb viewport so overflow keeps the trailing path visible. */
export function scrollSftpBreadcrumbViewportToTail(viewport: HTMLElement | null): void {
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
}

const SftpBreadcrumbInner: React.FC<SftpBreadcrumbProps> = ({
    path,
    onNavigate,
    onHome,
    maxVisibleParts = 4,
    isLocal,
    onListDrives,
    acceptForwardSlashUnc = false,
}) => {
    const { t } = useI18n();

    const [drives, setDrives] = useState<string[]>([]);
    const [driveDropdownOpen, setDriveDropdownOpen] = useState(false);
    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);

    const handleDriveDropdownOpen = useCallback(async (open: boolean) => {
        setDriveDropdownOpen(open);
        if (open && onListDrives) {
            const result = await onListDrives();
            setDrives(result);
        }
    }, [onListDrives]);

    const pathOptions = useMemo<SftpWindowsPathOptions>(
        () => ({ acceptForwardSlashUnc }),
        [acceptForwardSlashUnc],
    );

    const { segments, isWindowsDrive } = useMemo(
        () => getSftpBreadcrumbSegments(path, pathOptions),
        [path, pathOptions],
    );

    const { visibleParts, hiddenParts, needsTruncation } = useMemo(
        () =>
            resolveSftpBreadcrumbVisibleParts({
                segments,
                maxVisibleParts,
            }),
        [segments, maxVisibleParts],
    );

    const { leadingPart, trailingParts } = useMemo(
        () => splitSftpBreadcrumbPinnedParts(visibleParts),
        [visibleParts],
    );

    const showEllipsis = shouldShowSftpBreadcrumbEllipsis({
        needsTruncation,
        hiddenPartsCount: hiddenParts.length,
    });

    const syncTailScroll = useCallback(() => {
        scrollSftpBreadcrumbViewportToTail(viewportRef.current);
    }, []);

    useLayoutEffect(() => {
        syncTailScroll();
        const viewport = viewportRef.current;
        if (!viewport || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => syncTailScroll());
        ro.observe(viewport);
        const track = trackRef.current;
        if (track) ro.observe(track);
        return () => ro.disconnect();
    }, [syncTailScroll, path, trailingParts, showEllipsis]);

    const showDriveDropdown = isWindowsDrive && isLocal && !!onListDrives;

    // Dedicated "go to filesystem root" target: "/" on POSIX, drive / share root on Windows.
    const rootPath = useMemo(
        () => getSftpPathRoot(path, pathOptions),
        [path, pathOptions],
    );
    const atRoot = useMemo(() => {
        if (rootPath === null) return false;
        return isWindowsPath(path, pathOptions)
            ? isWindowsRoot(path, pathOptions)
            : path === rootPath;
    }, [path, pathOptions, rootPath]);

    const renderSegmentButton = (
        part: SftpBreadcrumbVisiblePart,
        { showTrailingChevron }: { showTrailingChevron: boolean },
    ) => {
        const { segment, originalIndex } = part;
        const isLast = originalIndex === segments.length - 1;
        const node = originalIndex === 0 && showDriveDropdown ? (
            <Dropdown open={driveDropdownOpen} onOpenChange={handleDriveDropdownOpen}>
                <DropdownTrigger asChild>
                    <button className="hover:text-foreground px-1 py-0.5 rounded hover:bg-secondary/60 shrink-0 flex items-center gap-0.5">
                        {segment.label}
                        <ChevronDown size={10} className="opacity-60" />
                    </button>
                </DropdownTrigger>
                <DropdownContent align="start" className="w-16 p-1">
                    {drives.map(drive => (
                        <button
                            key={drive}
                            onClick={() => { onNavigate(drive + '\\'); setDriveDropdownOpen(false); }}
                            className={cn(
                                "w-full text-left px-2 py-1 text-xs rounded hover:bg-secondary/60",
                                drive === segment.label && "bg-secondary font-medium"
                            )}
                        >
                            {drive}
                        </button>
                    ))}
                </DropdownContent>
            </Dropdown>
        ) : (
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        onClick={() => onNavigate(segment.path)}
                        className={cn(
                            "hover:text-foreground px-1 py-0.5 rounded hover:bg-secondary/60 truncate max-w-[160px] shrink-0",
                            isLast && "text-foreground font-medium"
                        )}
                    >
                        {segment.label}
                    </button>
                </TooltipTrigger>
                <TooltipContent>{segment.label}</TooltipContent>
            </Tooltip>
        );

        return (
            <React.Fragment key={segment.path}>
                {node}
                {showTrailingChevron && <ChevronRight size={12} className="opacity-40 shrink-0" />}
            </React.Fragment>
        );
    };

    // Pin Home + leading root + ellipsis outside the scrollport so narrow panes
    // can still navigate prefixes while the trailing chips scroll toward the end.
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex w-full min-w-0 items-center gap-1 text-xs text-muted-foreground cursor-default">
                    <div className="flex items-center gap-1 shrink-0">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    onClick={onHome}
                                    className="hover:text-foreground p-1 rounded hover:bg-secondary/60 shrink-0"
                                >
                                    <Home size={12} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>{t("sftp.goHome")}</TooltipContent>
                        </Tooltip>
                        {rootPath && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        onClick={() => onNavigate(rootPath)}
                                        disabled={atRoot}
                                        className="hover:text-foreground p-1 rounded hover:bg-secondary/60 shrink-0 text-[10px] leading-none font-semibold disabled:pointer-events-none disabled:opacity-40"
                                    >
                                        /
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{t("sftp.goRoot")}</TooltipContent>
                            </Tooltip>
                        )}
                        <ChevronRight size={12} className="opacity-40 shrink-0" />
                        {leadingPart && renderSegmentButton(leadingPart, {
                            showTrailingChevron: showEllipsis || trailingParts.length > 0,
                        })}
                        {showEllipsis && (
                            <>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span className="px-1 py-0.5 shrink-0 flex items-center text-muted-foreground cursor-default">
                                            <MoreHorizontal size={14} />
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {`${t("sftp.showHiddenPaths")}: ${hiddenParts.map(h => h.segment.label).join(' > ')}`}
                                    </TooltipContent>
                                </Tooltip>
                                {trailingParts.length > 0 && (
                                    <ChevronRight size={12} className="opacity-40 shrink-0" />
                                )}
                            </>
                        )}
                    </div>

                    {trailingParts.length > 0 && (
                        <div
                            ref={viewportRef}
                            className="min-w-0 flex-1 overflow-hidden"
                        >
                            <div
                                ref={trackRef}
                                className="flex w-max max-w-none items-center gap-1"
                            >
                                {trailingParts.map((part, idx) =>
                                    renderSegmentButton(part, {
                                        showTrailingChevron: idx < trailingParts.length - 1,
                                    }),
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </TooltipTrigger>
            <TooltipContent>{path}</TooltipContent>
        </Tooltip>
    );
};

export const SftpBreadcrumb = memo(SftpBreadcrumbInner);
SftpBreadcrumb.displayName = 'SftpBreadcrumb';
