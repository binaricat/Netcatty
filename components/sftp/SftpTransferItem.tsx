/**
 * SFTP Transfer item component for transfer queue
 */

import {
    ArrowDown,
    ArrowRight,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    File,
    FolderUp,
    GripVertical,
    Loader2,
    RefreshCw,
    X,
    XCircle,
} from 'lucide-react';
import React, { memo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { getParentPath } from '../../application/state/sftp/utils';
import { cn } from '../../lib/utils';
import { TransferTask } from '../../types';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { formatSpeed, formatTransferBytes } from './utils';

interface SftpTransferItemProps {
    task: TransferTask;
    isChild?: boolean;
    childNameColumnWidth?: number;
    onResizeNameColumn?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onCancel: () => void;
    onRetry: () => void;
    onDismiss: () => void;
    canRevealTarget?: boolean;
    onRevealTarget?: () => void;
    canToggleChildren?: boolean;
    isExpanded?: boolean;
    visibleChildCount?: number;
    onToggleChildren?: () => void;
}

const TruncatedTextWithTooltip: React.FC<{
    text: string;
    className?: string;
}> = ({ text, className }) => (
    <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <Tooltip>
            <TooltipTrigger asChild>
                <span className={cn("truncate", className)}>
                    {text}
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-md break-all">
                {text}
            </TooltipContent>
        </Tooltip>
    </TooltipProvider>
);

const SftpTransferItemInner: React.FC<SftpTransferItemProps> = ({
    task,
    isChild = false,
    childNameColumnWidth = 260,
    onResizeNameColumn,
    onCancel,
    onRetry,
    onDismiss,
    canRevealTarget = false,
    onRevealTarget,
    canToggleChildren = false,
    isExpanded = false,
    visibleChildCount: _visibleChildCount = 0,
    onToggleChildren,
}) => {
    const { t } = useI18n();

    const progressMode = task.progressMode ?? 'bytes';
    const isDirParent = task.isDirectory && !task.parentTaskId && progressMode === 'files';
    const hasKnownTotal = task.totalBytes > 0 || (!isDirParent && !!task.sourceLastModified);
    const progress = hasKnownTotal
        ? Math.min((task.transferredBytes / task.totalBytes) * 100, 100)
        : 0;
    const isIndeterminate = task.status === 'transferring' && !hasKnownTotal;
    const effectiveSpeed = task.status === 'transferring'
        ? (Number.isFinite(task.speed) && task.speed > 0 ? task.speed : 0)
        : 0;

    const bytesDisplay = isDirParent
        ? ''
        : task.status === 'transferring' && hasKnownTotal
            ? `${formatTransferBytes(task.transferredBytes)} / ${formatTransferBytes(task.totalBytes)}`
            : task.status === 'transferring'
                ? formatTransferBytes(task.transferredBytes)
                : task.status === 'completed' && hasKnownTotal
                    ? formatTransferBytes(task.totalBytes)
                    : '';

    const fileCountDisplay = isDirParent && task.status === 'transferring'
        ? (task.totalBytes > 0
            ? t('sftp.transfers.filesProgress', { current: task.transferredBytes, total: task.totalBytes })
            : t('sftp.transfers.filesCount', { count: task.transferredBytes }))
        : isDirParent && task.status === 'completed' && task.totalBytes > 0
            ? t('sftp.transfers.filesCount', { count: task.totalBytes })
            : '';

    const speedFormatted = effectiveSpeed > 0 ? formatSpeed(effectiveSpeed) : '';
    const targetDirectoryPath = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);

    const progressOverlayText = task.status === 'pending'
        ? t('sftp.task.waiting')
        : isIndeterminate
            ? t('sftp.transfer.preparing')
            : isDirParent
                ? (fileCountDisplay
                    ? `${fileCountDisplay}${hasKnownTotal ? ` • ${Math.round(progress)}%` : ''}`
                    : hasKnownTotal
                        ? `${Math.round(progress)}%`
                        : '...')
                : bytesDisplay
                    ? `${bytesDisplay}${hasKnownTotal ? ` • ${Math.round(progress)}%` : ''}`
                    : hasKnownTotal
                        ? `${Math.round(progress)}%`
                        : '...';

    const progressBarWidth = task.status === 'pending' || (task.status === 'transferring' && !hasKnownTotal) || isIndeterminate
        ? (task.status === 'pending' || !hasKnownTotal ? '100%' : `${progress}%`)
        : `${progress}%`;

    const statusIcon = task.status === 'transferring'
        ? <Loader2 size={12} className="animate-spin text-primary" />
        : task.status === 'pending'
            ? (task.isDirectory
                ? <FolderUp size={12} className="text-muted-foreground animate-pulse" />
                : <ArrowDown size={12} className="text-muted-foreground animate-bounce" />)
            : task.status === 'completed'
                ? <CheckCircle2 size={12} className="text-green-500" />
                : <XCircle size={12} className={task.status === 'failed' ? "text-destructive" : "text-muted-foreground"} />;

    const childProgressBar = (
        <div className="relative h-full overflow-hidden border border-border/60 bg-secondary/70">
            <div
                className={cn(
                    "h-full relative overflow-hidden",
                    task.status === 'pending' || (task.status === 'transferring' && !hasKnownTotal)
                        ? "bg-muted-foreground/35 animate-pulse"
                        : isIndeterminate
                            ? "bg-primary/60 animate-pulse"
                            : task.status === 'completed'
                                ? "bg-emerald-500/80"
                                : task.status === 'failed'
                                    ? "bg-destructive/70"
                                    : task.status === 'cancelled'
                                        ? "bg-muted-foreground/45"
                                        : "bg-gradient-to-r from-primary via-primary/90 to-primary"
                )}
                style={{
                    width: progressBarWidth,
                    transition: 'width 150ms ease-out',
                }}
            >
                {task.status === 'transferring' && (
                    <div
                        className="absolute inset-0 w-1/2 h-full"
                        style={{
                            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.32) 50%, transparent 100%)',
                            animation: 'progress-shimmer 1.5s ease-in-out infinite',
                        }}
                    />
                )}
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2">
                <span className="truncate whitespace-nowrap text-[10px] font-medium text-foreground">
                    {progressOverlayText}
                </span>
            </div>
        </div>
    );

    const progressSummaryText = task.status === 'transferring' || task.status === 'pending'
        ? [speedFormatted, progressOverlayText].filter(Boolean).join(' • ')
        : '';
    const showTransferSizeCalculation = task.status === 'transferring' && !hasKnownTotal && !isDirParent;
    const showFailedError = task.status === 'failed' && !!task.error;
    const hasFooterContent = showTransferSizeCalculation || showFailedError;

    const actionButtons = (
        <div className="flex items-center gap-1 shrink-0">
            {task.status === 'failed' && task.retryable !== false && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRetry} title="Retry">
                    <RefreshCw size={12} />
                </Button>
            )}
            {(task.status === 'pending' || task.status === 'transferring') && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={onCancel} title="Cancel">
                    <X size={12} />
                </Button>
            )}
            {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss} title="Dismiss">
                    <X size={12} />
                </Button>
            )}
        </div>
    );

    if (isChild) {
        return (
            <div
                className="grid h-7 items-stretch border-t border-border/20 bg-background/20 px-3"
                style={{
                    gridTemplateColumns: `24px ${childNameColumnWidth}px 10px minmax(0, 1fr) 24px`,
                }}
            >
                <div className="flex h-full items-center justify-center text-muted-foreground">
                    {task.isDirectory ? <FolderUp size={12} /> : <File size={12} />}
                </div>
                <div className="flex min-w-0 items-center pr-2">
                    <TruncatedTextWithTooltip
                        text={task.fileName}
                        className="min-w-0 text-[11px] font-medium text-foreground/90"
                    />
                </div>
                <div
                    className="flex h-full cursor-col-resize items-center justify-center text-muted-foreground/35 hover:text-foreground/70"
                    onMouseDown={onResizeNameColumn}
                    title="Resize file name column"
                >
                    <GripVertical size={10} />
                </div>
                <div className="min-w-0">
                    {childProgressBar}
                </div>
                <div className="flex h-full items-center justify-center">
                    {actionButtons}
                </div>
            </div>
        );
    }

    const showBelowParentProgress = task.status === 'transferring' || task.status === 'pending';

    const titleBlock = (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TruncatedTextWithTooltip
                text={task.fileName}
                className="text-[12px] font-medium leading-5"
            />
            <ArrowRight size={11} className="shrink-0 text-muted-foreground/70" />
            <TruncatedTextWithTooltip
                text={targetDirectoryPath}
                className={cn(
                    "min-w-0 text-[11px]",
                    canRevealTarget ? "text-primary/80" : "text-muted-foreground",
                )}
            />
            {canToggleChildren && (
                <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={onToggleChildren}
                    title={isExpanded ? t('sftp.transfers.collapseChildList') : t('sftp.transfers.expandChildList')}
                >
                    {isExpanded ? t('sftp.transfers.collapseChildList') : t('sftp.transfers.expandChildList')}
                    {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </button>
            )}
        </div>
    );

    return (
        <div className="border-t border-border/40 bg-background/60 px-3 py-2.5 backdrop-blur-sm">
            <div className="flex items-center gap-1">
                <div className="flex h-5 w-5 items-center justify-center shrink-0 -translate-y-px">
                    {statusIcon}
                </div>

                {canRevealTarget && onRevealTarget ? (
                    <button
                        type="button"
                        className="flex min-w-0 flex-1 rounded-sm text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                        onClick={onRevealTarget}
                    >
                        {titleBlock}
                    </button>
                ) : (
                    <div className="min-w-0 flex-1">
                        {titleBlock}
                    </div>
                )}

                {progressSummaryText && (
                    <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted-foreground font-mono">
                        {progressSummaryText}
                    </span>
                )}

                {actionButtons}
            </div>

            {showBelowParentProgress && (
                <div className="mt-2 ml-7">
                    <div className="h-1.5 overflow-hidden bg-secondary/80">
                        <div
                            className={cn(
                                "h-full relative overflow-hidden",
                                task.status === 'pending' || (task.status === 'transferring' && !hasKnownTotal)
                                    ? "bg-muted-foreground/50 animate-pulse"
                                    : isIndeterminate
                                        ? "bg-primary/60 animate-pulse"
                                        : "bg-gradient-to-r from-primary via-primary/90 to-primary",
                            )}
                            style={{
                                width: progressBarWidth,
                                transition: 'width 150ms ease-out',
                            }}
                        >
                            {task.status === 'transferring' && (
                                <div
                                    className="absolute inset-0 w-1/2 h-full"
                                    style={{
                                        background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.32) 50%, transparent 100%)',
                                        animation: 'progress-shimmer 1.5s ease-in-out infinite',
                                    }}
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}

            {hasFooterContent && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
                {showTransferSizeCalculation && (
                    <span className="text-muted-foreground">{t('sftp.transfers.calculatingTotal')}</span>
                )}
                {showFailedError && (
                    <span className="text-destructive">{task.error}</span>
                )}
                </div>
            )}
        </div>
    );
};

const arePropsEqual = (
    prevProps: SftpTransferItemProps,
    nextProps: SftpTransferItemProps,
): boolean => {
    const prev = prevProps.task;
    const next = nextProps.task;

    if (prev.status !== next.status) return false;
    if (prev.error !== next.error) return false;
    if (prev.fileName !== next.fileName) return false;
    if (prev.targetPath !== next.targetPath) return false;
    if (prev.totalBytes !== next.totalBytes) return false;
    if ((prevProps.canRevealTarget ?? false) !== (nextProps.canRevealTarget ?? false)) return false;
    if ((prevProps.isChild ?? false) !== (nextProps.isChild ?? false)) return false;
    if ((prevProps.childNameColumnWidth ?? 260) !== (nextProps.childNameColumnWidth ?? 260)) return false;
    if ((prevProps.canToggleChildren ?? false) !== (nextProps.canToggleChildren ?? false)) return false;
    if ((prevProps.isExpanded ?? false) !== (nextProps.isExpanded ?? false)) return false;
    if ((prevProps.visibleChildCount ?? 0) !== (nextProps.visibleChildCount ?? 0)) return false;

    if (next.status === 'transferring') {
        if (next.totalBytes <= 0 && prev.transferredBytes !== next.transferredBytes) return false;

        const prevProgress = prev.totalBytes > 0 ? (prev.transferredBytes / prev.totalBytes) * 100 : 0;
        const nextProgress = next.totalBytes > 0 ? (next.transferredBytes / next.totalBytes) * 100 : 0;
        if (Math.abs(nextProgress - prevProgress) >= 0.1) return false;

        if (next.speed !== prev.speed) return false;
    }

    if (next.status === 'pending') {
        return true;
    }

    return true;
};

export const SftpTransferItem = memo(SftpTransferItemInner, arePropsEqual);
SftpTransferItem.displayName = 'SftpTransferItem';
