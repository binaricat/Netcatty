import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  FolderOpen,
  FolderUp,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useI18n } from "../application/i18n/I18nProvider";
import {
  sftpTransferCenterStore,
  useSftpTransferCenterBadge,
  type SftpTransferCenterSnapshot,
} from "../application/state/sftpTransferCenterStore";
import { transferRuntime } from "../application/state/sftp/transferRuntime";
import { useGlobalSftpTransferActions } from "../application/state/useGlobalSftpTransferActions";
export { getGlobalTransferBatchEligibility } from "../domain/sftpTransferActions";
import type { FileConflictAction, TransferTask } from "../domain/models";
import { canReplaceSftpConflict } from "../domain/sftpConflict";
import { estimateTransferEtaSeconds, formatFileSize, formatTransferEta } from "../application/state/sftp/utils";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Stable empty snapshot while the popover is closed — progress ticks must not
 * re-render TopTabs just to update hidden list rows. */
const CLOSED_TRANSFER_CENTER_SNAPSHOT: SftpTransferCenterSnapshot = {
  tasks: [],
  activeCount: 0,
  queuedCount: 0,
  attentionCount: 0,
};

/**
 * Full transfer-center list only while the popover is open. When closed, the
 * getter always returns the same CLOSED snapshot so progress store notifies do
 * not re-render this TopTabs child (badge uses a separate stable subscription).
 */
function useSftpTransferCenterWhenOpen(open: boolean): SftpTransferCenterSnapshot {
  const openRef = useRef(open);
  openRef.current = open;
  return useSyncExternalStore(
    (onStoreChange) => {
      // Lifecycle + progress: when the popover is open the list must move with
      // bytes; when closed getSnapshot returns a stable CLOSED constant so
      // progress ticks are cheap no-ops for this subscriber.
      const unsubLifecycle = sftpTransferCenterStore.subscribe(onStoreChange);
      const unsubProgress = sftpTransferCenterStore.subscribeProgress(onStoreChange);
      return () => {
        unsubLifecycle();
        unsubProgress();
      };
    },
    () => (
      openRef.current
        ? sftpTransferCenterStore.getSnapshot()
        : CLOSED_TRANSFER_CENTER_SNAPSHOT
    ),
    () => CLOSED_TRANSFER_CENTER_SNAPSHOT,
  );
}

export type GlobalTransferBucket = "all" | "active" | "queued" | "paused" | "attention" | "completed";

export function getGlobalTransferBucket(task: Pick<TransferTask, "status" | "reconnectRequired">): GlobalTransferBucket {
  // Reconnect/resume preparation should stay visible with the unfinished work.
  if (task.status === "pending" && task.reconnectRequired) return "attention";
  if (task.status === "transferring" || task.status === "pausing") return "active";
  if (task.status === "pending" || task.status === "queued") return "queued";
  if (task.status === "paused") return "paused";
  if (task.status === "interrupted" || task.status === "attention" || task.status === "failed") return "attention";
  return "completed";
}

export function getGlobalTransferBadge(tasks: readonly TransferTask[]) {
  const topLevelTasks = tasks.filter((task) => !task.parentTaskId);
  return {
    count: topLevelTasks.filter((task) =>
      ["pending", "queued", "transferring", "pausing", "paused", "interrupted"].includes(task.status)
    ).length,
    // Interrupted after restart and conflict attention both need the user.
    hasAttention: topLevelTasks.some((task) =>
      task.status === "attention"
      || task.status === "failed"
      || task.status === "interrupted"
      || task.reconnectRequired === true
    ),
  };
}

export function splitBackgroundTransfers(tasks: readonly TransferTask[]) {
  const collapsed = tasks.filter((task) => task.background && task.status === "completed");
  const collapsedIds = new Set(collapsed.map((task) => task.id));
  return {
    visible: tasks.filter((task) => !collapsedIds.has(task.id)),
    collapsed,
  };
}

export function getGlobalTransferStatusOverride(task: Pick<TransferTask, "error" | "pauseUnavailableReason">) {
  return task.error || task.pauseUnavailableReason;
}

export function getGlobalConflictActionPresentation(
  action: FileConflictAction,
  destructiveDirectoryReplace: boolean,
) {
  const safeMerge = destructiveDirectoryReplace && action === "merge";
  const destructiveReplace = destructiveDirectoryReplace && action === "replace";
  return {
    variant: safeMerge || (!destructiveDirectoryReplace && action === "replace") ? "default" : "outline",
    destructiveReplace,
  } as const;
}

const BUCKETS: readonly GlobalTransferBucket[] = ["all", "active", "queued", "paused", "attention", "completed"];

export function getTasksForGlobalTransferBucket(
  tasks: readonly TransferTask[],
  bucket: GlobalTransferBucket,
): TransferTask[] {
  return tasks.filter((task) => !task.parentTaskId && (bucket === "all" || getGlobalTransferBucket(task) === bucket));
}

/** Folder parent rows use file-count progress (same model as the SFTP side queue). */
export function isDirectoryParentTask(
  task: Pick<TransferTask, "isDirectory" | "parentTaskId" | "progressMode">,
): boolean {
  if (!task.isDirectory || task.parentTaskId) return false;
  // Explicit bytes mode would be aggregate size; default folder uploads use files.
  return task.progressMode !== "bytes";
}

export function listChildTasksForParent(
  tasks: readonly TransferTask[],
  parentId: string,
): TransferTask[] {
  return tasks
    .filter((task) => task.parentTaskId === parentId && task.status !== "cancelled")
    .sort((a, b) => a.startTime - b.startTime);
}

/**
 * Prefer live children, then queued — for the collapsed "current file" summary.
 * Callers must not use this for paused/interrupted parents (those hide the row).
 */
export function pickActiveChildSummaries(
  children: readonly TransferTask[],
  limit = 2,
): TransferTask[] {
  const live = children.filter((task) => task.status === "transferring" || task.status === "pausing");
  if (live.length > 0) return live.slice(0, limit);
  const waiting = children.filter((task) => task.status === "pending" || task.status === "queued");
  if (waiting.length > 0) return waiting.slice(0, limit);
  return [];
}

/** Collapsed mini-rows only while the folder is actively moving or soft-draining. */
export function shouldShowCollapsedActiveChildren(
  parentStatus: TransferTask["status"],
): boolean {
  return parentStatus === "transferring" || parentStatus === "pausing";
}

export function getGlobalTransferProgressPercent(
  task: Pick<TransferTask, "status" | "totalBytes" | "transferredBytes">,
): number {
  if (task.status === "completed") return 100;
  if (task.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, (task.transferredBytes / task.totalBytes) * 100));
}

export type GlobalTransferProgressDisplay = {
  percent: number;
  /** Right-side progress label (file count or bytes). */
  detail: string;
  /** True when the bar should pulse (total still unknown). */
  indeterminate: boolean;
};

/**
 * Build progress labels for a top-level row. Directory parents use file counts
 * so we never show "1 Bytes / 12 Bytes" for n/m files.
 *
 * Folder walks interleave discovery with transfer: totalBytes is "found so far",
 * not a fixed grand total. Active rows use progressive copy so the UI does not
 * look like a lying overall percentage.
 */
export function buildGlobalTransferProgressDisplay(
  task: Pick<TransferTask, "status" | "isDirectory" | "parentTaskId" | "progressMode" | "totalBytes" | "transferredBytes" | "speed" | "phase">,
  t: (key: string, params?: Record<string, string | number>) => string,
): GlobalTransferProgressDisplay {
  const isDirParent = isDirectoryParentTask(task);
  const percent = getGlobalTransferProgressPercent(task);
  const hasTotal = task.totalBytes > 0;
  const discovered = Math.max(task.totalBytes, task.transferredBytes);

  if (isDirParent) {
    const isActive = task.status === "transferring"
      || task.status === "pausing"
      || task.status === "queued"
      || task.status === "pending";
    // Still discovering, or no completed files yet — pulse rather than freeze a fake %.
    const indeterminate = isActive && (
      task.phase === "scanning"
      || !hasTotal
      || task.transferredBytes <= 0
    );
    let detail = "";
    if (isActive) {
      if (discovered > 0) {
        detail = t("sftp.transfers.filesDiscoveredProgress", {
          completed: task.transferredBytes,
          discovered,
        });
      }
    } else if (task.status === "completed" && hasTotal) {
      detail = t("sftp.transfers.filesCount", { count: task.totalBytes });
    } else if (discovered > 0) {
      detail = t("sftp.transfers.filesDiscoveredProgress", {
        completed: task.transferredBytes,
        discovered,
      });
    }
    // Soft percent of files found so far (discovered may still grow).
    const softPercent = discovered > 0
      ? Math.min(100, (task.transferredBytes / discovered) * 100)
      : 0;
    return {
      percent: task.status === "completed" ? 100 : softPercent,
      detail,
      indeterminate,
    };
  }

  const detailParts: string[] = [];
  if (hasTotal) {
    detailParts.push(`${formatFileSize(task.transferredBytes)} / ${formatFileSize(task.totalBytes)}`);
  } else if (task.transferredBytes > 0) {
    detailParts.push(formatFileSize(task.transferredBytes));
  }
  if (task.status === "transferring" && task.speed > 0) {
    detailParts.push(`${formatFileSize(task.speed)}/s`);
  }
  if (task.status === "transferring" && task.speed > 0 && hasTotal) {
    const eta = formatTransferEta(estimateTransferEtaSeconds(task.totalBytes - task.transferredBytes, task.speed));
    if (eta) detailParts.push(eta);
  }
  return {
    percent,
    detail: detailParts.join(" · "),
    indeterminate: task.status === "transferring" && !hasTotal,
  };
}

function formatChildByteProgress(task: Pick<TransferTask, "totalBytes" | "transferredBytes" | "status">): string {
  if (task.totalBytes > 0) {
    return `${formatFileSize(task.transferredBytes)} / ${formatFileSize(task.totalBytes)}`;
  }
  if (task.transferredBytes > 0) return formatFileSize(task.transferredBytes);
  return "";
}

function statusLabelKey(status: TransferTask["status"]): string {
  return `sftp.transferCenter.status.${status}`;
}

function TransferAction({ label, onClick, children, destructive = false }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", destructive && "text-destructive hover:text-destructive")}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Truncated label with hover tooltip for the full text (paths, names, errors). */
function TruncatedTextWithTooltip({
  text,
  tooltip,
  className,
  as: Tag = "span",
}: {
  text: string;
  /** Defaults to `text`. Use when the visible label differs from the full string. */
  tooltip?: string;
  className?: string;
  as?: "span" | "div";
}) {
  if (!text) return null;
  const tip = tooltip || text;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Tag className={cn("min-w-0 truncate", className)}>{text}</Tag>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-sm break-all">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

function formatTransferPathLine(task: Pick<TransferTask, "sourcePath" | "targetPath" | "sourceHostLabel" | "targetHostLabel">): string {
  const source = `${task.sourceHostLabel ? `${task.sourceHostLabel}: ` : ""}${task.sourcePath}`;
  const target = `${task.targetHostLabel ? `${task.targetHostLabel}: ` : ""}${task.targetPath}`;
  return `${source} → ${target}`;
}

function TransferRow({
  task,
  childTasks = [],
}: {
  task: TransferTask;
  childTasks?: readonly TransferTask[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const folderReplaceWarningId = React.useId();
  // Optimistic spinner from click until store status moves off paused/interrupted.
  const [resumeClicked, setResumeClicked] = useState(false);
  const isDirParent = isDirectoryParentTask(task);
  const showCollapsedChildren = isDirParent && shouldShowCollapsedActiveChildren(task.status);
  const activeChildren = useMemo(
    () => (showCollapsedChildren ? pickActiveChildSummaries(childTasks, 2) : []),
    [childTasks, showCollapsedChildren],
  );
  // Soft-drain still completes ranges / children after Pause. Snapshot the
  // visible parent bar + child mini-rows on first "pausing" paint so the row
  // does not twitch (file-count bumps, child list swaps, width animation).
  // When the parent reaches "paused", hide the mini-rows entirely — partial
  // children flipping paused↔transferring used to blink the report line.
  const pausingSnapshotRef = useRef<{
    task: TransferTask;
    children: TransferTask[];
  } | null>(null);
  if (task.status === "pausing") {
    if (!pausingSnapshotRef.current) {
      pausingSnapshotRef.current = {
        task: { ...task },
        children: activeChildren.map((child) => ({ ...child })),
      };
    }
  } else if (pausingSnapshotRef.current) {
    pausingSnapshotRef.current = null;
  }
  const displayTask = task.status === "pausing" && pausingSnapshotRef.current
    ? { ...pausingSnapshotRef.current.task, status: "pausing" as const, speed: 0, phase: undefined }
    : task;
  const displayChildren = !showCollapsedChildren
    ? []
    : (task.status === "pausing" && pausingSnapshotRef.current
      ? pausingSnapshotRef.current.children
      : activeChildren);
  const progress = buildGlobalTransferProgressDisplay(displayTask, t);
  const canToggleChildren = isDirParent && childTasks.length > 0;
  const canControl = sftpTransferCenterStore.canControl(task.id);
  // Keep the play button as a spinner for the whole reconnect window, not only
  // the brief "pending" status before a dedicated session opens.
  const storeResuming = task.reconnectRequired === true
    && ["pending", "queued", "transferring"].includes(task.status)
    && !task.error;
  const isResuming = storeResuming
    || (resumeClicked && ["paused", "interrupted", "attention", "pending", "queued"].includes(task.status) && !task.error);
  // Clear optimistic click once the store has left the idle-resume surface or failed.
  useEffect(() => {
    if (!resumeClicked) return;
    if (
      storeResuming
      || task.status === "transferring"
      || task.status === "completed"
      || task.status === "failed"
      || task.status === "cancelled"
      || !!task.error
    ) {
      setResumeClicked(false);
    }
  }, [resumeClicked, storeResuming, task.status, task.error]);
  const canPause = task.resumable !== false && task.status === "transferring" && canControl && !isResuming;
  // Orphaned tasks after app restart (interrupted / attention / paused without a
  // live panel owner) must still expose resume/cancel from the global center.
  // Conflict rows must use resolveConflict — Resume would overwrite blindly.
  // Non-resumable attention rows (e.g. duplicate-destination refusals) are
  // terminal: resuming them would start a second writer on the same path.
  // Do not show Resume during soft-drain "pausing" — play + spinner together
  // makes the row twitch as buttons appear/disappear mid-drain.
  const canResume = !isResuming && !task.conflict && (
    ["paused", "interrupted"].includes(task.status)
    || (task.status === "attention" && task.resumable !== false)
    || (task.status === "failed" && task.resumable !== false && (task.checkpointBytes ?? 0) > 0)
  ) && canControl;
  const isPausing = task.status === "pausing";
  const canCancel = ["pending", "queued", "transferring", "pausing", "paused", "interrupted", "attention"].includes(task.status) && canControl;
  const canRetry = task.status === "failed" && task.retryable !== false && canControl;
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.status);
  // Status line is for lifecycle/error only — not pause capability notes.
  // "cannot be paused safely" used to render here during healthy progress and
  // looked like a failure even while bytes were flowing.
  const statusText = (() => {
    const override = getGlobalTransferStatusOverride(task);
    if (override) return override;
    if (isResuming) return t("sftp.transferCenter.status.resuming");
    // Lifecycle pause labels beat phase ("transferring") so pausing never reads
    // as 传输中 while soft-drain finishes the current range.
    if (task.status === "pausing" || task.status === "paused" || task.status === "interrupted") {
      return t(statusLabelKey(task.status));
    }
    // Scanning runs as pending/transferring; never override terminal statuses
    // (cancelled/failed/completed) that still carry a stale phase value.
    if (
      task.phase === "scanning"
      && (task.status === "pending" || task.status === "queued" || task.status === "transferring")
    ) {
      return t("sftp.transferCenter.phase.scanning");
    }
    if (task.phase && task.status === "transferring") {
      return t(`sftp.transferCenter.phase.${task.phase}`);
    }
    return t(statusLabelKey(task.status));
  })();
  const directionIcon = isDirParent
    ? <FolderUp size={15} />
    : task.direction === "download"
      ? <ArrowDownToLine size={15} />
      : <ArrowUpFromLine size={15} />;

  const openTarget = (forResume = false) => {
    window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
      detail: { task, forResume },
    }));
  };
  const resumeTask = () => {
    setResumeClicked(true);
    // Dedicated resume opens vault sessions for local↔remote and SFTP↔SFTP.
    // Only force-open the panel when the row still needs a live owner/adoption
    // (e.g. conflict) — not on every remote-to-remote resume click.
    if (task.conflict || (task.status === "attention" && !task.reconnectRequired && task.direction === "remote-to-remote")) {
      openTarget(true);
    }
    // Single process-level resume (soft live walk / hard reconnect internal).
    void transferRuntime.resume(task.id);
  };

  const barWidth = progress.indeterminate
    ? "100%"
    : `${displayTask.status === "completed" ? 100 : progress.percent}%`;

  return (
    <div
      className="border-b border-border/40 px-3 py-2.5 last:border-b-0 hover:bg-muted/30"
      data-section="global-sftp-transfer-row"
      data-transfer-status={task.status}
      data-directory-parent={isDirParent ? "true" : undefined}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          {directionIcon}
        </div>
        <button type="button" className="min-w-0 flex-1 overflow-hidden text-left" onClick={() => openTarget()}>
          <div className="flex min-w-0 items-center gap-1.5">
            <TruncatedTextWithTooltip text={task.fileName} className="text-xs font-medium" />
            {task.background && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {t("sftp.transferCenter.background")}
              </span>
            )}
          </div>
          <TruncatedTextWithTooltip
            as="div"
            text={formatTransferPathLine(task)}
            className="mt-0.5 text-[10px] text-muted-foreground"
          />
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {canToggleChildren && (
            <TransferAction
              label={expanded ? t("sftp.transfers.collapseChildren") : t("sftp.transfers.expandChildren")}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </TransferAction>
          )}
          {isResuming && (
            <div className="flex h-8 w-8 items-center justify-center" role="status" aria-label={t("sftp.transferCenter.status.resuming")}>
              <Loader2 size={13} className="animate-spin text-primary" />
            </div>
          )}
          {canPause && (
            <TransferAction label={t("sftp.transferCenter.pause")} onClick={() => { void transferRuntime.pause(task.id); }}>
              <Pause size={13} />
            </TransferAction>
          )}
          {task.status === "pausing" && (
            <div className="flex h-8 w-8 items-center justify-center" role="status" aria-label={t("sftp.transferCenter.status.pausing")}>
              <Loader2 size={13} className="animate-spin text-amber-500" />
            </div>
          )}
          {canResume && (
            <TransferAction label={t("sftp.transferCenter.resume")} onClick={resumeTask}>
              <Play size={13} />
            </TransferAction>
          )}
          {task.status === "queued" && canControl && (
            <TransferAction label={t("sftp.transferCenter.prioritize")} onClick={() => { void sftpTransferCenterStore.prioritize(task.id); }}>
              <ArrowUpFromLine size={13} />
            </TransferAction>
          )}
          {canRetry && (
            <TransferAction label={t("sftp.transfers.retryAction")} onClick={() => { void sftpTransferCenterStore.retry(task.id); }}>
              <RefreshCw size={13} />
            </TransferAction>
          )}
          {isTerminal && (
            <TransferAction label={t("sftp.transfers.dismissAction")} onClick={() => sftpTransferCenterStore.dismiss(task.id)}>
              <Trash2 size={13} />
            </TransferAction>
          )}
          {canCancel && (
            <TransferAction destructive label={t("common.cancel")} onClick={() => { void transferRuntime.cancel(task.id); }}>
              <X size={13} />
            </TransferAction>
          )}
          <TransferAction label={t("sftp.transfers.copyTargetPath")} onClick={() => { void navigator.clipboard.writeText(task.targetPath); }}>
            <ClipboardCopy size={13} />
          </TransferAction>
          <TransferAction label={t("sftp.transfers.openTargetFolder")} onClick={() => openTarget()}>
            <FolderOpen size={13} />
          </TransferAction>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-label={task.fileName}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.indeterminate ? undefined : Math.round(progress.percent)}
        >
          <div
            className={cn(
              "h-full rounded-full",
              // Animate only while actively transferring — soft-drain width
              // freezes still looked like a twitch with transition.
              !isPausing && task.status !== "paused" && task.status !== "interrupted"
                && "transition-[width] duration-200 ease-linear",
              progress.indeterminate && "animate-pulse bg-primary/60",
              !progress.indeterminate && (
                task.status === "failed"
                  ? "bg-destructive"
                  : task.status === "paused" || task.status === "interrupted" || isPausing
                    ? "bg-amber-500"
                    : "bg-primary"
              ),
            )}
            style={{ width: barWidth }}
          />
        </div>
        <span className="w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {progress.indeterminate ? "…" : displayTask.totalBytes > 0 || displayTask.status === "completed" ? `${progress.percent.toFixed(1)}%` : "—"}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <TruncatedTextWithTooltip
          text={statusText}
          className={cn(
            "min-w-0 flex-1",
            (task.status === "failed" || task.status === "attention") && "text-destructive",
          )}
        />
        <span className="min-w-0 shrink truncate text-right font-mono" title={progress.detail || undefined}>
          {progress.detail}
        </span>
      </div>

      {/* Collapsed: show currently transferring child file(s) without expanding the whole tree. */}
      {isDirParent && !expanded && displayChildren.length > 0 && (
        <div
          className={cn(
            "mt-1.5 space-y-1 border-l-2 pl-2",
            isPausing || task.status === "paused" ? "border-amber-500/40" : "border-primary/30",
          )}
          data-section="global-sftp-transfer-active-children"
        >
          {displayChildren.map((child) => {
            const childPercent = getGlobalTransferProgressPercent(child);
            const childDetail = formatChildByteProgress(child);
            const childFrozen = isPausing
              || task.status === "paused"
              || child.status === "pausing"
              || child.status === "paused";
            return (
              <div key={child.id} className="min-w-0">
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <TruncatedTextWithTooltip text={child.fileName} className="flex-1 text-muted-foreground" />
                  <span className="shrink-0 font-mono">
                    {childDetail || (child.totalBytes > 0 ? `${childPercent.toFixed(0)}%` : t(statusLabelKey(child.status)))}
                  </span>
                </div>
                {child.totalBytes > 0 && (
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        child.status === "completed"
                          ? "bg-emerald-500/80"
                          : childFrozen
                            ? "bg-amber-500/80"
                            : "bg-primary/80",
                      )}
                      style={{ width: `${child.status === "completed" ? 100 : childPercent}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isDirParent && expanded && childTasks.length > 0 && (
        <div
          className="mt-2 max-h-48 space-y-1 overflow-y-auto border-t border-border/40 pt-2"
          data-section="global-sftp-transfer-child-list"
        >
          {childTasks.map((child) => {
            const childPercent = getGlobalTransferProgressPercent(child);
            const childDetail = formatChildByteProgress(child);
            return (
              <div
                key={child.id}
                className="flex items-center gap-2 rounded px-1 py-1 text-[10px] hover:bg-muted/40"
                data-transfer-status={child.status}
              >
                <TruncatedTextWithTooltip
                  text={child.fileName}
                  tooltip={child.targetPath || child.fileName}
                  className="flex-1 text-muted-foreground"
                />
                <span className="shrink-0 font-mono text-muted-foreground">
                  {childDetail
                    || (child.totalBytes > 0 ? `${childPercent.toFixed(0)}%` : t(statusLabelKey(child.status)))}
                </span>
                {child.status === "transferring" && (
                  <Loader2 size={10} className="shrink-0 animate-spin text-primary" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {task.status === "attention" && task.conflict && canControl && (() => {
        const conflict = task.conflict!;
        const canMerge = conflict.isDirectory && conflict.existingType === "directory";
        const destructiveDirectoryReplace = canMerge;
        const unresolvedFolderType = conflict.isDirectory && !conflict.existingType;
        const canReplace = canReplaceSftpConflict(conflict.isDirectory, conflict.existingType);
        const actions = [
          "stop",
          "skip",
          "duplicate",
          ...(canMerge ? (["merge"] as const) : []),
          ...(canReplace ? (["replace"] as const) : []),
        ] as const;
        const applyAllActions = [
          "skip",
          "duplicate",
          ...(canMerge ? (["merge"] as const) : []),
          ...(canReplace ? (["replace"] as const) : []),
        ] as const;
        const renderConflictAction = (action: FileConflictAction, applyToAll = false) => {
          const presentation = getGlobalConflictActionPresentation(action, destructiveDirectoryReplace);
          return (
            <Button
              key={applyToAll ? `all-${action}` : action}
              variant={presentation.variant}
              size="sm"
              className={cn(
                "h-6 px-2 text-[10px]",
                presentation.destructiveReplace
                  && "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive",
              )}
              aria-describedby={presentation.destructiveReplace ? folderReplaceWarningId : undefined}
              onClick={() => { void sftpTransferCenterStore.resolveConflict(task.id, action, applyToAll); }}
            >
              {t(`sftp.conflict.action.${action}`)}
              {applyToAll && <> · {t("sftp.transferCenter.applyAll")}</>}
            </Button>
          );
        };
        return (
        <div className="mt-2 space-y-2">
          {destructiveDirectoryReplace && (
            <div
              id={folderReplaceWarningId}
              className="flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10px] leading-4"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-destructive" />
              <p>
                {t("sftp.conflict.folderMergeHint")}{" "}
                <span className="font-medium text-destructive">
                  {t("sftp.conflict.folderReplaceWarning")}
                </span>
              </p>
            </div>
          )}
          {unresolvedFolderType && (
            <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-4">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600" />
              <p>{t("sftp.conflict.folderUnknownDesc")}</p>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-1">
            {actions.map((action) => renderConflictAction(action))}
            {(conflict.applyToAllCount ?? 0) > 1
              && applyAllActions.map((action) => renderConflictAction(action, true))}
          </div>
        </div>
        );
      })()}
    </div>
  );
}

export function GlobalSftpTransferCenter() {
  const { t } = useI18n();
  // Badge is a stable store snapshot (identity unchanged on pure progress).
  // Full task list is only needed while the popover is open — when closed,
  // progress ticks used to re-render this TopTabs child on every byte.
  const badge = useSftpTransferCenterBadge();
  const [open, setOpen] = useState(false);
  // Folder drops fire this so the scanning row is visible immediately without
  // requiring the user to notice the badge first.
  useEffect(() => {
    const openCenter = () => setOpen(true);
    window.addEventListener("netcatty:open-sftp-transfer-center", openCenter);
    return () => window.removeEventListener("netcatty:open-sftp-transfer-center", openCenter);
  }, []);
  const snapshot = useSftpTransferCenterWhenOpen(open);
  const [bucket, setBucket] = useState<GlobalTransferBucket>("all");
  const [showBackground, setShowBackground] = useState(false);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, TransferTask[]>();
    for (const task of snapshot.tasks) {
      if (!task.parentTaskId || task.status === "cancelled") continue;
      const list = map.get(task.parentTaskId) ?? [];
      list.push(task);
      map.set(task.parentTaskId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startTime - b.startTime);
    }
    return map;
  }, [snapshot.tasks]);
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((item) => [
    item,
    getTasksForGlobalTransferBucket(snapshot.tasks, item).length,
  ])) as Record<GlobalTransferBucket, number>, [snapshot.tasks]);
  const bucketTasks = useMemo(() => getTasksForGlobalTransferBucket(snapshot.tasks, bucket)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.startTime - a.startTime), [bucket, snapshot.tasks]);
  const { visible, collapsed } = splitBackgroundTransfers(bucketTasks);
  const displayed = showBackground ? [...visible, ...collapsed] : visible;
  const { batchEligibility, pauseAll, resumeAll } = useGlobalSftpTransferActions(snapshot.tasks);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn"
              style={{ color: "var(--top-tabs-muted, hsl(var(--muted-foreground)))" }}
              aria-label={t("sftp.transferCenter.title")}
              data-section="global-sftp-transfer-toggle"
            >
              <ArrowDownUp size={15} />
              {badge.count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] leading-3 text-primary-foreground">
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              )}
              {badge.hasAttention && (
                <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-destructive" />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("sftp.transferCenter.title")}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={5}
        className="w-[min(460px,calc(100vw-24px))] overflow-hidden p-0 app-no-drag"
        data-section="global-sftp-transfer-center"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="min-w-0 pr-2 text-sm font-semibold">
            {t("sftp.transferCenter.title")}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={pauseAll} disabled={batchEligibility.pausableCount === 0}>
              <Pause size={12} className="mr-1" />{t("sftp.transferCenter.pauseAll")}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resumeAll} disabled={batchEligibility.resumableCount === 0}>
              <Play size={12} className="mr-1" />{t("sftp.transferCenter.resumeAll")}
            </Button>
          </div>
        </div>

        <div className="flex gap-0 px-2 pt-1" role="tablist" aria-label={t("sftp.transferCenter.title")}>
          {BUCKETS.map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                // Selected: keep a clear accent underline (not just text color).
                // Unselected: gray label only — no shared full-width hairline.
                "relative min-w-0 flex-1 truncate px-1.5 py-2 text-[11px] transition-colors",
                bucket === item
                  ? "font-medium text-primary after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
              onClick={() => setBucket(item)}
              role="tab"
              aria-selected={bucket === item}
            >
              {t(`sftp.transferCenter.bucket.${item}`)}
              {counts[item] > 0 && <span className="ml-1 text-[10px] opacity-80">{counts[item]}</span>}
            </button>
          ))}
        </div>

        <div className="max-h-[460px] overflow-auto">
          {displayed.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
              {badge.hasAttention && bucket !== "attention" && bucket !== "all" ? <AlertCircle size={22} /> : <ArrowDownUp size={22} />}
              <span className="mt-2 text-xs">{t("sftp.transferCenter.empty")}</span>
            </div>
          ) : displayed.map((task) => (
            <TransferRow
              key={task.id}
              task={task}
              childTasks={childrenByParent.get(task.id) ?? []}
            />
          ))}
        </div>

        {(() => {
          const showBackgroundToggle = collapsed.length > 0;
          const showClear = bucket === "completed" && counts.completed > 0;
          if (!showBackgroundToggle && !showClear) return null;
          return (
            <div className="flex items-center justify-between px-3 py-2">
              <div>
                {showBackgroundToggle && (
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowBackground((value) => !value)}>
                    {showBackground
                      ? t("sftp.transferCenter.hideBackground")
                      : t("sftp.transferCenter.showBackground", { count: collapsed.length })}
                  </Button>
                )}
              </div>
              {showClear && (
                <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => {
                  sftpTransferCenterStore.clearTerminal("completed");
                  sftpTransferCenterStore.clearTerminal("cancelled");
                }}>
                  <Trash2 size={11} className="mr-1" />{t("sftp.transferCenter.clear")}
                </Button>
              )}
            </div>
          );
        })()}
      </PopoverContent>
    </Popover>
  );
}
