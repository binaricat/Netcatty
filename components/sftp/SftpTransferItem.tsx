/**
 * SFTP Transfer item component for transfer queue
 */

import {
    ArrowDown,
    ArrowRight,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    ClipboardCopy,
    File,
    FolderOpen,
    FolderUp,
    GripVertical,
    Loader2,
    Pause,
    Play,
    RefreshCw,
    X,
    XCircle,
} from 'lucide-react';
import React, { memo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { getParentPath } from '../../application/state/sftp/utils';
import { useSftpTransferTask, useSftpTransferResuming } from '../../application/state/sftpTransferCenterStore';
import { cn } from '../../lib/utils';
import { TransferTask } from '../../types';
import {
    buildGlobalTransferProgressDisplay,
    isDirectoryParentTask,
} from '../GlobalSftpTransferCenter';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { formatSpeed, formatTransferBytes } from './utils';

/** Child rows need room for Pause + Cancel (2×24px icons + gap). */
const CHILD_ACTIONS_COLUMN_PX = 56;

interface SftpTransferItemProps {
    task: TransferTask;
    isChild?: boolean;
    childNameColumnWidth?: number;
    onResizeNameColumn?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onCancel: () => void;
    onPause?: () => void;
    onResume?: () => void;
    onRetry: () => void;
    onDismiss: () => void;
    canRevealTarget?: boolean;
    onRevealTarget?: () => void;
    canCopyTargetPath?: boolean;
    onCopyTargetPath?: () => void;
    canToggleChildren?: boolean;
    isExpanded?: boolean;
    visibleChildCount?: number;
    onToggleChildren?: () => void;
    onSetNameColumnWidth?: (width: number) => void;
    childNameColumnMinWidth?: number;
    childNameColumnMaxWidth?: number;
    childListId?: string;
    resizeHandleTabIndex?: number;
}

const TruncatedTextWithTooltip: React.FC<{
    text: string;
    className?: string;
}> = ({ text, className }) => (
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
);

const IconButtonWithTooltip: React.FC<{
    label: string;
    children: React.ReactElement;
}> = ({ label, children }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            {children}
        </TooltipTrigger>
        <TooltipContent side="top" className="pointer-events-none">{label}</TooltipContent>
    </Tooltip>
);

/** Pointer activates on pointerdown (Tooltip/parent may eat click); keyboard uses click detail 0. */
const oncePerActivationHandlers = (activate: () => void) => ({
    onPointerDown: (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
    },
    onClick: (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        // Mouse/touch already ran on pointerdown; only keyboard click (detail 0) remains.
        if (event.detail > 0) return;
        activate();
    },
});

const SftpTransferItemInner: React.FC<SftpTransferItemProps> = ({
    task: propsTask,
    isChild = false,
    childNameColumnWidth = 260,
    onResizeNameColumn,
    onCancel,
    onPause,
    onResume,
    onRetry,
    onDismiss,
    canRevealTarget = false,
    onRevealTarget,
    canCopyTargetPath = false,
    onCopyTargetPath,
    canToggleChildren = false,
    isExpanded = false,
    visibleChildCount: _visibleChildCount = 0,
    onToggleChildren,
    onSetNameColumnWidth,
    childNameColumnMinWidth = 160,
    childNameColumnMaxWidth = 480,
    childListId,
    resizeHandleTabIndex = 0,
}) => {
    const { t } = useI18n();
    // Progress bytes live in the center store (patchTask). Avoid depending on
    // panel setTransfersState for every tick — that re-rendered the whole SFTP
    // tree and pegged the renderer during large copies.
    const task = useSftpTransferTask(propsTask.id, propsTask);

    // Same progress model as the global transfer center (done · found for folders).
    const isDirParent = isDirectoryParentTask(task);
    const centerProgress = buildGlobalTransferProgressDisplay(task, t);
    const hasKnownTotal = isDirParent
        ? task.totalBytes > 0 && task.transferredBytes > 0 && task.phase !== 'scanning'
        : task.totalBytes > 0 || !!task.sourceLastModified;
    const progress = isDirParent
        ? centerProgress.percent
        : hasKnownTotal
            ? Math.min((task.transferredBytes / task.totalBytes) * 100, 100)
            : 0;
    const isIndeterminate = isDirParent
        ? centerProgress.indeterminate && (task.status === 'transferring' || task.status === 'pending' || task.status === 'queued' || task.status === 'pausing')
        : task.status === 'transferring' && !hasKnownTotal;
    const isActiveTransfer = task.status === 'transferring' || task.status === 'pausing';
    // Reconnect / dedicated resume window — keep the action slot as a spinner
    // until the first real progress clears reconnectRequired.
    const storeResuming = task.reconnectRequired === true
        && ['pending', 'queued', 'transferring'].includes(task.status)
        && !task.error;
    const sharedResuming = useSftpTransferResuming(task.id);
    const isResuming = sharedResuming || storeResuming;
    const effectiveSpeed = task.status === 'transferring'
        ? (Number.isFinite(task.speed) && task.speed > 0 ? task.speed : 0)
        : 0;

    const isPausedLike = task.status === 'paused' || task.status === 'interrupted';
    const bytesDisplay = isDirParent
        ? ''
        : (isActiveTransfer || isPausedLike) && hasKnownTotal
            ? `${formatTransferBytes(task.transferredBytes)} / ${formatTransferBytes(task.totalBytes)}`
            : isActiveTransfer || isPausedLike
                ? formatTransferBytes(task.transferredBytes)
                : task.status === 'completed' && hasKnownTotal
                    ? formatTransferBytes(task.totalBytes)
                    : '';

    // Prefer the transfer-center detail string so the panel never lags behind
    // "N done · M found" while status is still pending during progressive walks.
    const fileCountDisplay = isDirParent ? centerProgress.detail : '';

    const speedFormatted = effectiveSpeed > 0 ? formatSpeed(effectiveSpeed) : '';
    const targetDirectoryPath = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);

    // Pausing must show explicit copy — spinner-only looked like a no-op while
    // the backend drained in-flight chunks ("finish current step").
    const pausingLabel = t('sftp.transferCenter.status.pausing');
    const resumingLabel = t('sftp.transferCenter.status.resuming');
    const isLiveScanning = task.phase === 'scanning'
        && (task.status === 'pending' || task.status === 'queued' || task.status === 'transferring');
    const progressOverlayText = isResuming
        ? resumingLabel
        : isLiveScanning
        ? (fileCountDisplay
            ? `${t('sftp.transferCenter.phase.scanning')} · ${fileCountDisplay}`
            : t('sftp.transferCenter.phase.scanning'))
        : task.status === 'pausing'
            ? pausingLabel
            : isDirParent
                ? (fileCountDisplay
                    || (task.status === 'pending' || task.status === 'queued'
                        ? t('sftp.task.waiting')
                        : isIndeterminate
                            ? '...'
                            : `${Math.round(progress)}%`))
                : task.status === 'pending'
                    ? t('sftp.task.waiting')
                    : isIndeterminate
                        ? t('sftp.transfer.preparing')
                        : bytesDisplay
                            ? `${bytesDisplay}${hasKnownTotal ? ` • ${Math.round(progress)}%` : ''}`
                            : hasKnownTotal
                                ? `${Math.round(progress)}%`
                                : '...';

    const progressBarWidth = isDirParent
        ? (centerProgress.indeterminate || isLiveScanning
            ? '100%'
            : `${progress}%`)
        : task.status === 'pending'
            || (task.status === 'transferring' && !hasKnownTotal)
            || isIndeterminate
            ? (task.status === 'pending' || !hasKnownTotal ? '100%' : `${progress}%`)
            : `${progress}%`;

    const statusIcon = isResuming
        ? <Loader2 size={12} className="animate-spin text-primary" />
        : task.status === 'pausing'
        ? <Loader2 size={12} className="animate-spin text-amber-500" />
        : task.status === 'transferring'
        ? <Loader2 size={12} className="animate-spin text-primary" />
        : task.status === 'pending' || task.status === 'queued'
            ? (task.isDirectory
                ? <FolderUp size={12} className="text-muted-foreground animate-pulse" />
                : <ArrowDown size={12} className="text-muted-foreground animate-bounce" />)
            : task.status === 'completed'
                ? <CheckCircle2 size={12} className="text-green-500" />
                : task.status === 'paused' || task.status === 'interrupted' || task.status === 'attention'
                    ? <Pause size={12} className="text-amber-500" />
                : <XCircle size={12} className={task.status === 'failed' ? "text-destructive" : "text-muted-foreground"} />;

    const childProgressBar = (
        <div
            className="relative h-full overflow-hidden border border-border/60 bg-secondary/70"
        >
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
                                        : task.status === 'paused' || task.status === 'interrupted'
                                            ? "bg-amber-500/80"
                                            : "bg-gradient-to-r from-primary via-primary/90 to-primary"
                )}
                style={{
                    width: progressBarWidth,
                    // Match ~200ms IPC ticks so the bar eases between samples.
                    transition: 'width 220ms linear',
                }}
            >
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2">
                <span className="truncate whitespace-nowrap text-[10px] font-medium text-foreground">
                    {progressOverlayText}
                </span>
            </div>
        </div>
    );

    const progressSummaryText = isResuming
        || isActiveTransfer
        || isPausedLike
        || task.status === 'pending'
        || task.status === 'queued'
        || (isDirParent && !!fileCountDisplay)
        ? [speedFormatted, progressOverlayText].filter(Boolean).join(' • ')
        : '';
    const showTransferSizeCalculation = task.status === 'transferring' && !hasKnownTotal && !isDirParent;
    const showFailedError = task.status === 'failed' && !!task.error;
    // Surface hard pause misses (e.g. "cannot be paused yet") so the panel
    // pause button never looks dead when the backend refuses.
    const showPauseUnavailable = !!task.pauseUnavailableReason
        && (task.status === 'transferring' || task.status === 'queued' || task.status === 'pending');
    const hasFooterContent = showTransferSizeCalculation || showFailedError || showPauseUnavailable;
    const retryActionLabel = t('sftp.transfers.retryAction');
    const cancelActionLabel = t('common.cancel');
    const pauseActionLabel = t('sftp.transferCenter.pause');
    const resumeActionLabel = t('sftp.transferCenter.resume');
    const dismissActionLabel = t('sftp.transfers.dismissAction');
    const resizeNameColumnLabel = t('sftp.transfers.resizeNameColumn');
    const toggleChildrenLabel = isExpanded ? t('sftp.transfers.collapseChildList') : t('sftp.transfers.expandChildList');
    const revealTargetLabel = t('sftp.transfers.openTargetFolder');
    const copyTargetPathLabel = t('sftp.transfers.copyTargetPath');
    const actionButtonClass = "h-6 w-6 focus-visible:ring-1 focus-visible:ring-primary/50";
    const actionAriaLabel = (label: string) => `${label}: ${task.fileName}`;

    const setNameColumnWidth = (width: number) => {
        const nextWidth = Math.max(childNameColumnMinWidth, Math.min(childNameColumnMaxWidth, width));
        onSetNameColumnWidth?.(nextWidth);
    };

    const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!onSetNameColumnWidth) return;

        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            setNameColumnWidth(childNameColumnWidth - step);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            setNameColumnWidth(childNameColumnWidth + step);
        } else if (event.key === 'Home') {
            event.preventDefault();
            setNameColumnWidth(childNameColumnMinWidth);
        } else if (event.key === 'End') {
            event.preventDefault();
            setNameColumnWidth(childNameColumnMaxWidth);
        }
    };

    const actionButtons = (
        <div className="flex items-center gap-1 shrink-0">
            {canRevealTarget && onRevealTarget && (
                <IconButtonWithTooltip label={revealTargetLabel}>
                    <Button variant="ghost" size="icon" className={actionButtonClass} onClick={onRevealTarget} aria-label={actionAriaLabel(revealTargetLabel)}>
                        <FolderOpen size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {canCopyTargetPath && onCopyTargetPath && (
                <IconButtonWithTooltip label={copyTargetPathLabel}>
                    <Button variant="ghost" size="icon" className={actionButtonClass} onClick={onCopyTargetPath} aria-label={actionAriaLabel(copyTargetPathLabel)}>
                        <ClipboardCopy size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {task.status === 'failed' && task.retryable !== false && (
                <IconButtonWithTooltip label={retryActionLabel}>
                    <Button variant="ghost" size="icon" className={actionButtonClass} onClick={onRetry} aria-label={actionAriaLabel(retryActionLabel)}>
                        <RefreshCw size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {task.status === 'transferring' && task.resumable !== false && onPause && !isResuming && (
                <IconButtonWithTooltip label={pauseActionLabel}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={actionButtonClass}
                        data-action="pause-transfer"
                        {...oncePerActivationHandlers(onPause)}
                        aria-label={actionAriaLabel(pauseActionLabel)}
                    >
                        <Pause size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {task.status === 'pausing' && (
                <IconButtonWithTooltip label={pausingLabel}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={actionButtonClass}
                        disabled
                        aria-label={actionAriaLabel(pausingLabel)}
                        aria-busy="true"
                    >
                        <Loader2 size={12} className="animate-spin text-amber-500" />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {isResuming && (
                <IconButtonWithTooltip label={resumingLabel}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={actionButtonClass}
                        disabled
                        aria-label={actionAriaLabel(resumingLabel)}
                        aria-busy="true"
                    >
                        <Loader2 size={12} className="animate-spin text-primary" />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {(task.status === 'paused' || task.status === 'interrupted') && onResume && !isResuming && (
                <IconButtonWithTooltip label={resumeActionLabel}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={actionButtonClass}
                        data-action="resume-transfer"
                        {...oncePerActivationHandlers(() => {
                            onResume();
                        })}
                        aria-label={actionAriaLabel(resumeActionLabel)}
                    >
                        <Play size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {(['pending', 'queued', 'transferring', 'pausing', 'paused', 'interrupted', 'attention'] as const).includes(task.status as never) && (
                <IconButtonWithTooltip label={cancelActionLabel}>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(actionButtonClass, "text-destructive hover:text-destructive")}
                        data-action="cancel-transfer"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onCancel();
                        }}
                        aria-label={actionAriaLabel(cancelActionLabel)}
                    >
                        <X size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
            {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                <IconButtonWithTooltip label={dismissActionLabel}>
                    <Button variant="ghost" size="icon" className={actionButtonClass} onClick={onDismiss} aria-label={actionAriaLabel(dismissActionLabel)}>
                        <X size={12} />
                    </Button>
                </IconButtonWithTooltip>
            )}
        </div>
    );

    const content = isChild ? (
            <div
                className="grid h-7 items-stretch border-t border-border/20 bg-background/20 px-3"
                data-section="terminal-sftp-transfer-row"
                data-transfer-status={task.status}
                data-transfer-direction={task.direction}
                style={{
                    // Last column reserves space for Pause + Cancel so the
                    // progress bar never paints under the action buttons.
                    gridTemplateColumns: `24px ${childNameColumnWidth}px 10px minmax(0, 1fr) ${CHILD_ACTIONS_COLUMN_PX}px`,
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
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div
                            className="flex h-full cursor-col-resize items-center justify-center text-muted-foreground/35 hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                            onMouseDown={onResizeNameColumn}
                            onKeyDown={handleResizeKeyDown}
                            role="separator"
                            aria-label={resizeNameColumnLabel}
                            aria-orientation="vertical"
                            aria-valuemin={childNameColumnMinWidth}
                            aria-valuemax={childNameColumnMaxWidth}
                            aria-valuenow={childNameColumnWidth}
                            tabIndex={resizeHandleTabIndex}
                        >
                            <GripVertical size={10} />
                        </div>
                    </TooltipTrigger>
                    <TooltipContent side="top">{resizeNameColumnLabel}</TooltipContent>
                </Tooltip>
                <div className="min-w-0 overflow-hidden">
                    {childProgressBar}
                </div>
                <div className="flex h-full min-w-0 items-center justify-end gap-0.5 pl-1">
                    {actionButtons}
                </div>
            </div>
    ) : (() => {
        // Keep the bar visible while paused/interrupted so checkpoint progress
        // stays readable; shimmer only runs on active/resuming states.
        const showBelowParentProgress = isResuming
            || task.status === 'transferring'
            || task.status === 'pausing'
            || task.status === 'pending'
            || task.status === 'paused'
            || task.status === 'interrupted';

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
        </div>
        );

        const toggleChildrenButton = canToggleChildren ? (
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                        onClick={onToggleChildren}
                        aria-label={toggleChildrenLabel}
                        aria-expanded={isExpanded}
                        aria-controls={childListId}
                    >
                        {toggleChildrenLabel}
                        {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top">{toggleChildrenLabel}</TooltipContent>
            </Tooltip>
        ) : null;

        return (
        <div
            className="border-t border-border/40 bg-background/60 px-3 py-2.5 supports-[backdrop-filter]:backdrop-blur-sm"
            data-section="terminal-sftp-transfer-row"
            data-transfer-status={task.status}
            data-transfer-direction={task.direction}
        >
            <div className="flex items-center gap-1">
                <div className="flex h-5 w-5 items-center justify-center shrink-0 -translate-y-px">
                    {statusIcon}
                </div>

                {canRevealTarget && onRevealTarget ? (
                    <button
                        type="button"
                        className="flex min-w-0 flex-1 rounded-sm text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                        onClick={onRevealTarget}
                        aria-label={actionAriaLabel(revealTargetLabel)}
                    >
                        {titleBlock}
                    </button>
                ) : (
                    <div className="min-w-0 flex-1">
                        {titleBlock}
                    </div>
                )}

                {toggleChildrenButton}

                {progressSummaryText && (
                    <span className="ml-auto min-w-0 max-w-[50%] truncate whitespace-nowrap text-right text-[10px] text-muted-foreground font-mono">
                        {progressSummaryText}
                    </span>
                )}

                {/* Keep pause/cancel outside the progress summary so long
                    "N done · M found" labels never crowd the action buttons. */}
                <div className="ml-1 shrink-0">
                    {actionButtons}
                </div>
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
                                        : isPausedLike
                                            ? "bg-amber-500/80"
                                            : "bg-gradient-to-r from-primary via-primary/90 to-primary",
                            )}
                            style={{
                                width: progressBarWidth,
                                // Match ~200ms IPC ticks so the bar eases between samples.
                    transition: 'width 220ms linear',
                            }}
                        />
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
                {showPauseUnavailable && (
                    <span className="text-amber-600 dark:text-amber-400">{task.pauseUnavailableReason}</span>
                )}
                </div>
            )}
        </div>
        );
    })();

    return (
        <TooltipProvider delayDuration={300} skipDelayDuration={100}>
            {content}
        </TooltipProvider>
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
    if (prev.pauseUnavailableReason !== next.pauseUnavailableReason) return false;
    if (prev.reconnectRequired !== next.reconnectRequired) return false;
    if (prev.resumable !== next.resumable) return false;
    if (prev.fileName !== next.fileName) return false;
    if (prev.targetPath !== next.targetPath) return false;
    if (prev.totalBytes !== next.totalBytes) return false;
    if (prev.transferredBytes !== next.transferredBytes) return false;
    if (prev.phase !== next.phase) return false;
    if (prev.progressMode !== next.progressMode) return false;
    if ((prevProps.canRevealTarget ?? false) !== (nextProps.canRevealTarget ?? false)) return false;
    if ((prevProps.canCopyTargetPath ?? false) !== (nextProps.canCopyTargetPath ?? false)) return false;
    if ((prevProps.isChild ?? false) !== (nextProps.isChild ?? false)) return false;
    if ((prevProps.childNameColumnWidth ?? 260) !== (nextProps.childNameColumnWidth ?? 260)) return false;
    if ((prevProps.canToggleChildren ?? false) !== (nextProps.canToggleChildren ?? false)) return false;
    if ((prevProps.isExpanded ?? false) !== (nextProps.isExpanded ?? false)) return false;
    if ((prevProps.visibleChildCount ?? 0) !== (nextProps.visibleChildCount ?? 0)) return false;
    if ((prevProps.childNameColumnMinWidth ?? 160) !== (nextProps.childNameColumnMinWidth ?? 160)) return false;
    if ((prevProps.childNameColumnMaxWidth ?? 480) !== (nextProps.childNameColumnMaxWidth ?? 480)) return false;
    if ((prevProps.childListId ?? '') !== (nextProps.childListId ?? '')) return false;
    if ((prevProps.resizeHandleTabIndex ?? 0) !== (nextProps.resizeHandleTabIndex ?? 0)) return false;

    if (next.status === 'transferring' || next.status === 'pausing' || next.status === 'pending' || next.status === 'queued') {
        if (next.speed !== prev.speed) return false;
    }

    return true;
};

export const SftpTransferItem = memo(SftpTransferItemInner, arePropsEqual);
SftpTransferItem.displayName = 'SftpTransferItem';
