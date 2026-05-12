/**
 * SFTP Breadcrumb navigation component
 */

import { ChevronDown, ChevronRight, Home, MoreHorizontal } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
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
}

const SftpBreadcrumbInner: React.FC<SftpBreadcrumbProps> = ({
    path,
    onNavigate,
    onHome,
    maxVisibleParts = 4,
    isLocal,
    onListDrives,
}) => {
    const { t } = useI18n();

    const [drives, setDrives] = useState<string[]>([]);
    const [driveDropdownOpen, setDriveDropdownOpen] = useState(false);

    const handleDriveDropdownOpen = useCallback(async (open: boolean) => {
        setDriveDropdownOpen(open);
        if (open && onListDrives) {
            const result = await onListDrives();
            setDrives(result);
        }
    }, [onListDrives]);

    // Handle both Windows (C:\path) and Unix (/path) style paths
    const isWindowsPath = /^[A-Za-z]:/.test(path);
    const separator = isWindowsPath ? /[\\/]/ : /\//;
    const parts = path.split(separator).filter(Boolean);

    // For Windows, first part might be drive letter like "C:"
    const buildPath = (index: number) => {
        if (isWindowsPath) {
            const builtPath = parts.slice(0, index + 1).join('\\');
            // If this is just a drive letter (e.g., "C:"), add trailing backslash
            if (/^[A-Za-z]:$/.test(builtPath)) {
                return builtPath + '\\';
            }
            return builtPath;
        }
        return '/' + parts.slice(0, index + 1).join('/');
    };

    // Determine which parts to show (always truncate, no expansion)
    const { visibleParts, hiddenParts, needsTruncation } = useMemo(() => {
        if (parts.length <= maxVisibleParts) {
            return { 
                visibleParts: parts.map((part, idx) => ({ part, originalIndex: idx })), 
                hiddenParts: [] as { part: string; originalIndex: number }[], 
                needsTruncation: false 
            };
        }

        // Show first part + ellipsis + last (maxVisibleParts - 1) parts
        const firstPart = [{ part: parts[0], originalIndex: 0 }];
        const lastPartsCount = maxVisibleParts - 1;
        const lastParts = parts.slice(-lastPartsCount).map((part, idx) => ({
            part,
            originalIndex: parts.length - lastPartsCount + idx
        }));
        const hidden = parts.slice(1, -lastPartsCount).map((part, idx) => ({
            part,
            originalIndex: idx + 1
        }));

        return { 
            visibleParts: [...firstPart, ...lastParts], 
            hiddenParts: hidden, 
            needsTruncation: true 
        };
    }, [parts, maxVisibleParts]);

    const showDriveDropdown = isWindowsPath && isLocal && !!onListDrives;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-hidden cursor-default">
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
                    <ChevronRight size={12} className="opacity-40 shrink-0" />
                    {visibleParts.map(({ part, originalIndex }, displayIdx) => {
                        const partPath = buildPath(originalIndex);
                        const isLast = originalIndex === parts.length - 1;
                        const showEllipsisBefore = needsTruncation && displayIdx === 1;

                        return (
                            <React.Fragment key={partPath}>
                                {showEllipsisBefore && (
                                    <>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <span className="px-1 py-0.5 shrink-0 flex items-center text-muted-foreground cursor-default">
                                                    <MoreHorizontal size={14} />
                                                </span>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                                {`${t("sftp.showHiddenPaths")}: ${hiddenParts.map(h => h.part).join(' > ')}`}
                                            </TooltipContent>
                                        </Tooltip>
                                        <ChevronRight size={12} className="opacity-40 shrink-0" />
                                    </>
                                )}
                                {originalIndex === 0 && showDriveDropdown ? (
                                    <Dropdown open={driveDropdownOpen} onOpenChange={handleDriveDropdownOpen}>
                                        <DropdownTrigger asChild>
                                            <button className="hover:text-foreground px-1 py-0.5 rounded hover:bg-secondary/60 shrink-0 flex items-center gap-0.5">
                                                {part}
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
                                                        drive === part && "bg-secondary font-medium"
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
                                                onClick={() => onNavigate(partPath)}
                                                className={cn(
                                                    "hover:text-foreground px-1 py-0.5 rounded hover:bg-secondary/60 truncate max-w-[120px] shrink-0",
                                                    isLast && "text-foreground font-medium"
                                                )}
                                            >
                                                {part}
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>{part}</TooltipContent>
                                    </Tooltip>
                                )}
                                {!isLast && <ChevronRight size={12} className="opacity-40 shrink-0" />}
                            </React.Fragment>
                        );
                    })}
                </div>
            </TooltipTrigger>
            <TooltipContent>{path}</TooltipContent>
        </Tooltip>
    );
};

export const SftpBreadcrumb = memo(SftpBreadcrumbInner);
SftpBreadcrumb.displayName = 'SftpBreadcrumb';
