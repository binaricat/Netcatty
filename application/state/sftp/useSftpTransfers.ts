import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  FileConflict,
  FileConflictAction,
  SftpFilenameEncoding,
  TransferDirection,
  TransferStatus,
  TransferTask,
} from "../../../domain/models";
import {
  canReplaceSftpConflict,
  describeSftpExistingKind,
  describeSftpIncomingKind,
  getSftpConflictTypeKey,
  shouldUnlinkSftpConflictBeforeReplace,
} from "../../../domain/sftpConflict";
import {
  findActivePathConflict,
  pathConflictMessage,
} from "../../../domain/sftpTransferConflicts";
import { useI18n } from "../../i18n/I18nProvider";
import { notify } from "../../notification";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { SftpPane } from "./types";
import { isMissingStatError } from "./errors";
import { useSftpDirectoryTransferOps } from "./transferDirectoryOps";
import { useSftpTransferConflictOps } from "./transferConflictOps";
import { useSftpTransferTaskOps } from "./transferTaskOps";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";
import {
  createDirectDownloadTransferTask,
  resolveDirectDirectoryDownloadFinalStatus,
} from "./downloadTransferTask";
import {
  releaseTransferPauseTree,
  waitUntilTransferPauseReleased,
} from "./transferPauseLatch";
import {
  bumpTransferControlEpoch,
  settleTransferControlEpochTree,
} from "./transferControlEpoch";
import { transferRuntime } from "./transferRuntime";
import {
  clearTransferCancelled,
  clearTransferCancelledTree,
  isTransferCancelledFlag,
  markTransferCancelled,
  markTransferCancelledTree,
  settleTransferCancelTree,
} from "./transferCancelLatch";
import type { TransferResult, UseSftpTransfersParams, UseSftpTransfersResult } from "./useSftpTransfers.types";
import type { TransferConnectionLease } from "./transferConnectionPool";
import {
  captureDeferredTransferAttempt,
  createDeferredTransferAttemptQueue,
  isDeferredTransferAttemptCurrent,
  pruneTransferConflictDefaults,
  type DeferredTransferAttemptQueue,
  type TransferConflictDefaults,
} from "./transferConflictLifecycle";
import { getParentPath, joinPath } from "./utils";
import { promoteDirectoryReplaceStage as promoteDirectoryReplacePaths } from "./directoryReplacePromotion";
import {
  isExternalDragDropFileUpload,
  retryExternalDragDropFileUpload,
} from "./externalDragDropRetry";

/** Keep the MutableRefObject mirror in sync with the process-global latch set. */
function syncPausedTasksRef(ref: { current: Set<string> }, taskId: string, latched: boolean) {
  if (latched) ref.current.add(taskId);
  else ref.current.delete(taskId);
}

/** Set whose has() also observes process-global cancel flags (tab-close path). */
class PanelCancelSet extends Set<string> {
  override add(id: string): this {
    super.add(id);
    markTransferCancelled(id);
    return this;
  }
  override delete(id: string): boolean {
    const had = super.delete(id);
    clearTransferCancelled(id);
    return had;
  }
  override has(id: string): boolean {
    return super.has(id) || isTransferCancelledFlag(id);
  }
}

function createPanelCancelSet(): Set<string> {
  return new PanelCancelSet();
}

export async function runTrackedTransferAttempt<T>(
  inFlightTransferIds: Set<string>,
  taskId: string,
  runner: () => Promise<T>,
): Promise<T> {
  inFlightTransferIds.add(taskId);
  try {
    return await runner();
  } finally {
    // Completion callbacks are caller-owned and may throw. The process-global
    // runtime already releases its walk in finally; keep the panel mirror just
    // as strict so one callback failure cannot permanently block a retry.
    inFlightTransferIds.delete(taskId);
  }
}

export function finishTransferTask(
  task: TransferTask,
  outcome: {
    partialFailure: boolean;
    cancelled: boolean;
    endTime?: number;
  },
  flushPendingProgress: () => void,
  mirrorPanelTask: (task: TransferTask) => void,
): TransferStatus {
  flushPendingProgress();
  const latestTask = transferRuntime.getTask(task.id) ?? task;
  const endTime = outcome.endTime ?? Date.now();
  const cancelled = outcome.cancelled || latestTask.status === "cancelled";
  const status: TransferStatus = cancelled
    ? "cancelled"
    : outcome.partialFailure ? "failed" : "completed";
  const updates: Partial<TransferTask> = cancelled
    ? {
      status: "cancelled",
      error: undefined,
      endTime,
      speed: 0,
    }
    : {
      status,
      error: outcome.partialFailure ? "Some files failed to transfer" : undefined,
      retryable: outcome.partialFailure ? false : latestTask.retryable,
      endTime,
      transferredBytes: outcome.partialFailure ? latestTask.transferredBytes : latestTask.totalBytes,
      speed: 0,
    };
  transferRuntime.patchTask(latestTask.id, updates);
  mirrorPanelTask(transferRuntime.getTask(latestTask.id) ?? { ...latestTask, ...updates });
  return status;
}

/** User-facing path exclusivity notice (toast + logs). */
function notifyPathConflict(
  existing: Pick<TransferTask, "fileName" | "status">,
  t: (key: string, values?: Record<string, string | number>) => string,
): void {
  const name = existing.fileName || "file";
  const message = existing.status === "paused"
    ? t("sftp.transfers.pathConflict.paused", { name })
    : t("sftp.transfers.pathConflict.inProgress", { name });
  logger.warn("[SFTP] path conflict", pathConflictMessage(existing));
  notify.warning(message, t("sftp.transfers.pathConflict.title"));
}

export const useSftpTransfers = ({
  ownerId,
  canPrepareAdoption,
  surfaceVisible = true,
  getActivePane,
  getPaneByConnectionId,
  getTabByConnectionId,
  updateTab,
  refresh,
  clearCacheForConnection,
  sftpSessionsRef,
  connectionCacheKeyMapRef,
  listLocalFiles,
  listRemoteFiles,
  handleSessionError,
  acquireTransferSession,
}: UseSftpTransfersParams): UseSftpTransfersResult => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  // Ref so progress flushes always see the latest visibility without rebinding.
  const surfaceVisibleRef = useRef(surfaceVisible);
  surfaceVisibleRef.current = surfaceVisible;
  const [transfers, setTransfersState] = useState<TransferTask[]>(() => sftpTransferCenterStore.getOwnerTasks(ownerId));
  // Only re-surface live attention conflicts. Terminal rows may still carry a
  // stale conflict payload after older Skip paths — those must not reopen the dialog.
  const [conflicts, setConflicts] = useState<FileConflict[]>(() => sftpTransferCenterStore
    .getOwnerTasks(ownerId)
    .filter((task) => task.status === "attention" && !!task.conflict)
    .map((task) => task.conflict as FileConflict));

  // Track cancelled task IDs. has() also sees process-global cancel flags set by
  // the transfer center after the React owner unmounts.
  const cancelledTasksRef = useRef<Set<string>>(createPanelCancelSet());
  // Process-global pause latches (survive panel unmount / tab close). Local ref
  // mirrors the global set so transferDirectoryOps can keep using a MutableRefObject.
  const pausedTasksRef = useRef<Set<string>>(new Set());
  const pauseWaitersRef = useRef<Map<string, Set<() => void>>>(new Map());
  // Track active child transfer IDs per parent (outside React state for immediate visibility)
  const activeChildIdsRef = useRef<Map<string, Set<string>>>(new Map());
  // Live processTransfer walks (esp. directory parents). Resume must unlatch
  // these instead of starting a second full re-walk of the tree.
  const inFlightTransferIdsRef = useRef<Set<string>>(new Set());
  /** While folder is latched, keep hammering pauseTransfer on live children. */
  const folderPauseWatchdogsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  // Sole writer after mount is setTransfers (ref-first). Do not clobber with
  // React state on every render — a parent re-render between progress IPC ticks
  // would roll the ref back and freeze the global center bar.
  const transfersRef = useRef(transfers);
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;

  // When the retained panel is re-opened, catch up React state from the ref that
  // kept receiving progress while the surface was hidden.
  useEffect(() => {
    if (!surfaceVisible) return;
    setTransfersState(transfersRef.current);
  }, [surfaceVisible]);

  // Keep owner lifecycle changes in the global transfer store. Byte progress
  // arrives independently through the unified process-wide event stream.
  //
  // Do not pre-assign transfersRef before publishing the same array reference —
  // identity equality skips the store merge (avoids store↔listener loops).
  const setTransfers = useCallback((update: SetStateAction<TransferTask[]>) => {
    const prev = transfersRef.current;
    const next = typeof update === "function"
      ? (update as (value: TransferTask[]) => TransferTask[])(prev)
      : update;
    if (next === prev) return;
    sftpTransferCenterStore.publishOwner(ownerId, next);
    const canonical = sftpTransferCenterStore.getOwnerTasks(ownerId);
    transfersRef.current = canonical;
    setTransfersState(canonical);
  }, [ownerId]);

  // Coalesce progress-only patches to one paint per animation frame. Without
  // this, each stream tick maps the full transfer list + publishOwner + store
  // emit, and the main-window renderer pegs ~100%+ CPU during large copies.
  //
  // Progress flushes intentionally skip publishOwner: the store is updated via
  // transferRuntime.patchTask (cheap single-row merge). Re-publishing the full
  // owner snapshot on every tick was the freeze path for directory copies.
  const pendingProgressByIdRef = useRef<Map<string, Partial<TransferTask>>>(new Map());
  const progressFlushRafRef = useRef<number | null>(null);
  // Progress coalesce: store is the live authority (SftpTransferItem uses
  // useSftpTransferTask). Batch patchTask to one rAF — do not add another 500ms
  // timer on top of main-process IPC (stacked lag made the bar jump).
  // Do not setTransfersState here — that re-reconciled the retained SFTP tree.
  const flushPendingProgress = useCallback(() => {
    progressFlushRafRef.current = null;
    const pending = pendingProgressByIdRef.current;
    if (pending.size === 0) return;
    pendingProgressByIdRef.current = new Map();
    for (const [taskId, updates] of pending) {
      transferRuntime.patchTask(taskId, updates);
    }
  }, []);
  const scheduleProgressFlush = useCallback(() => {
    if (progressFlushRafRef.current != null) return;
    progressFlushRafRef.current = window.requestAnimationFrame(flushPendingProgress);
  }, [flushPendingProgress]);
  const applyProgress = useCallback((taskId: string, updates: Partial<TransferTask>) => {
    const prevPending = pendingProgressByIdRef.current.get(taskId) || {};
    pendingProgressByIdRef.current.set(taskId, { ...prevPending, ...updates });
    // Keep ref hot for cancel/pause checks without waiting for paint.
    transfersRef.current = transfersRef.current.map((row) => (
      row.id === taskId ? { ...row, ...updates } : row
    ));
    scheduleProgressFlush();
  }, [scheduleProgressFlush]);
  useEffect(() => () => {
    if (progressFlushRafRef.current != null) {
      window.cancelAnimationFrame(progressFlushRafRef.current);
      progressFlushRafRef.current = null;
    }
  }, []);

  const completionHandlersRef = useRef<Map<string, (result: TransferResult) => void | Promise<void>>>(new Map());
  const conflictDefaultsRef = useRef<TransferConflictDefaults>(new Map());
  const deferredConflictAttemptsRef = useRef<DeferredTransferAttemptQueue | null>(null);

  useEffect(() => {
    const conflictDefaults = conflictDefaultsRef.current;
    const queue = createDeferredTransferAttemptQueue({
      onError: (error) => logger.warn("[SFTP] Deferred conflict transfer failed", error),
    });
    deferredConflictAttemptsRef.current = queue;
    return () => {
      queue.dispose();
      if (deferredConflictAttemptsRef.current === queue) {
        deferredConflictAttemptsRef.current = null;
      }
      conflictDefaults.clear();
    };
  }, [ownerId]);

  useEffect(() => {
    pruneTransferConflictDefaults(conflictDefaultsRef.current, transfers);
  }, [transfers]);

  const clearCancelledTask = useCallback((taskId: string) => {
    cancelledTasksRef.current.delete(taskId);
    clearTransferCancelled(taskId);
  }, []);

  const waitUntilTransferResumed = useCallback(async (taskId: string) => {
    // Process-global latch: survives panel unmount so the transfer center can
    // release a walk that outlived the React owner.
    await waitUntilTransferPauseReleased(taskId);
    syncPausedTasksRef(pausedTasksRef, taskId, false);
  }, []);

  const stopFolderPauseWatchdog = useCallback((taskId: string) => {
    const timer = folderPauseWatchdogsRef.current.get(taskId);
    if (timer) {
      clearInterval(timer);
      folderPauseWatchdogsRef.current.delete(taskId);
    }
  }, []);

  /** Every unfinished child id under a folder parent (state + live workers). */
  const collectPauseTreeChildIds = useCallback((rootTaskId: string): string[] => {
    const childIdSet = new Set(activeChildIdsRef.current.get(rootTaskId) ?? []);
    for (const candidate of transfersRef.current) {
      if (
        candidate.parentTaskId === rootTaskId
        && !["completed", "cancelled", "failed"].includes(candidate.status)
      ) {
        childIdSet.add(candidate.id);
      }
    }
    return [...childIdSet];
  }, []);

  /**
   * Resume/cancel must clear the whole latch tree. Store pause latches parent
   * + children; releasing only the parent left child latches stuck and the
   * directory walk blocked forever (UI "transferring", 0 bytes moving).
   */
  const releasePausedTransfer = useCallback((taskId: string, childIds?: readonly string[]) => {
    // Invalidate any in-flight soft-drain / watchdog pause IPC for this tree.
    bumpTransferControlEpoch(taskId);
    const kids = childIds ?? collectPauseTreeChildIds(taskId);
    releaseTransferPauseTree(taskId, kids);
    syncPausedTasksRef(pausedTasksRef, taskId, false);
    for (const id of kids) syncPausedTasksRef(pausedTasksRef, id, false);
    stopFolderPauseWatchdog(taskId);
    const wake = (id: string) => {
      const waiters = pauseWaitersRef.current.get(id);
      pauseWaitersRef.current.delete(id);
      for (const resolve of waiters ?? []) resolve();
    };
    wake(taskId);
    for (const id of kids) wake(id);
  }, [collectPauseTreeChildIds, stopFolderPauseWatchdog]);

  /** Latch the tree and return the pause control epoch for soft-drain gating. */
  const resolveTaskEndpoints = useCallback((task: TransferTask) => {
    const sourceTab = getTabByConnectionId(task.sourceConnectionId);
    const targetTab = task.targetConnectionId === "local"
      ? null
      : getTabByConnectionId(task.targetConnectionId);
    const sourceByHost = !sourceTab && task.sourceHostId
      ? (["left", "right"] as const).map((side) => {
          const pane = getActivePane(side);
          return pane?.connection?.hostId === task.sourceHostId ? { side, pane } : null;
        }).find(Boolean)
      : null;
    const targetByHost = !targetTab && task.targetHostId
      ? (["left", "right"] as const).map((side) => {
          const pane = getActivePane(side);
          return pane?.connection?.hostId === task.targetHostId ? { side, pane } : null;
        }).find(Boolean)
      : null;
    const localTab = (["left", "right"] as const).map((side) => {
      const pane = getActivePane(side);
      return pane?.connection?.isLocal ? { side, pane } : null;
    }).find(Boolean);

    const source = sourceTab
      ? { side: sourceTab.side, pane: sourceTab.pane }
      : sourceByHost
        ?? (!task.sourceHostId ? localTab : null);
    const target = targetTab
      ? { side: targetTab.side, pane: targetTab.pane }
      : targetByHost
        ?? (!task.targetHostId || task.targetConnectionId === "local" ? localTab : null);

    if (!source?.pane.connection || !target?.pane.connection) {
      return null;
    }

    return {
      sourceSide: source.side,
      targetSide: target.side,
      sourcePane: source.pane,
      targetPane: target.pane,
    };
  }, [getActivePane, getTabByConnectionId]);

  const cleanupTaskArtifacts = useCallback(async (task: TransferTask) => {
    const endpoints = resolveTaskEndpoints(task);
    const targetPane = endpoints?.targetPane;
    const targetSftpId = targetPane?.connection && !targetPane.connection.isLocal
      ? sftpSessionsRef.current.get(targetPane.connection.id)
      : undefined;
    await netcattyBridge.get()?.cleanupTransferArtifacts?.({
      transferId: task.id,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      targetSftpId,
      targetEncoding: targetPane?.filenameEncoding,
      stagedTargetPath: task.stagedTargetPath,
    });
  }, [resolveTaskEndpoints, sftpSessionsRef]);

  const isTransferCancelledError = useCallback(
    (error: unknown): boolean =>
      error instanceof Error && error.message === "Transfer cancelled",
    [],
  );

  const conflictDefaultKey = useCallback(
    (batchId: string | undefined, isDirectory: boolean, existingType?: "file" | "directory" | "symlink") =>
      `${batchId ?? "global"}:${getSftpConflictTypeKey(isDirectory, existingType)}`,
    [],
  );

  const buildReplaceTypeMismatchError = useCallback(
    (isDirectory: boolean, existingType: "file" | "directory" | "symlink" | undefined, targetPath: string) =>
      `Cannot replace existing ${describeSftpExistingKind(existingType)} with ${describeSftpIncomingKind(isDirectory)}: ${targetPath}`,
    [],
  );

  const { completeCancelledTask, cancelBackendTransfers, markBatchStopped } = useSftpTransferTaskOps({
    cancelledTasksRef,
    activeChildIdsRef,
    transfersRef,
    completionHandlersRef,
    setConflicts,
    setTransfers,
    releasePausedTransfer,
    cleanupTaskArtifacts,
  });

  const { statTargetPath, getDuplicateTarget, deleteTargetPath } = useSftpTransferConflictOps();

  const { transferFile, transferDirectory } = useSftpDirectoryTransferOps({
    ownerId,
    cancelledTasksRef,
    pausedTasksRef,
    waitUntilTransferResumed,
    activeChildIdsRef,
    transfersRef,
    setTransfers,
    listLocalFiles,
    listRemoteFiles,
    acquireTransferSession,
  });

  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
    targetSide: "left" | "right",
  ): Promise<TransferStatus> => {
    if (cancelledTasksRef.current.has(task.id)) {
      return "cancelled";
    }
    // Guard against concurrent processTransfer on the same id (resume used to
    // re-enter while a paused directory walk was still alive). Process-global
    // registry also covers walks after the SFTP panel / terminal tab unmounts.
    if (inFlightTransferIdsRef.current.has(task.id) || transferRuntime.isWalkInFlight(task.id)) {
      logger.warn("[SFTP] processTransfer already in flight; skipping re-entry", task.id);
      return transfersRef.current.find((candidate) => candidate.id === task.id)?.status
        ?? transferRuntime.getTask(task.id)?.status
        ?? "transferring";
    }
    return runTrackedTransferAttempt(inFlightTransferIdsRef.current, task.id, async () => {
      // Runtime is the authority writer for live lifecycle. Also mirror into the
      // panel list when mounted (view only — soft control does not depend on it).
      // Progress-only patches are rAF-coalesced so large-file streams do not
      // force a full React + global-center re-render on every IPC tick.
      const updateTask = (updates: Partial<TransferTask>) => {
        const statusChange = updates.status !== undefined
          && updates.status !== "transferring"
          && updates.status !== "paused"
          && updates.status !== "pausing";
        // Pause-latched progress still counts as progress-only (no publishOwner).
        const progressOnly = !statusChange
          && updates.error === undefined
          && updates.conflict === undefined
          && updates.ownerId === undefined
          && (
            updates.transferredBytes !== undefined
            || updates.speed !== undefined
            || updates.checkpointBytes !== undefined
            || updates.resumeStage !== undefined
            || updates.downloadCheckpointBytes !== undefined
            || updates.uploadCheckpointBytes !== undefined
            || updates.sourceFingerprint !== undefined
            || updates.totalBytes !== undefined
            || updates.phase !== undefined
            || updates.status === "transferring"
            || updates.status === "paused"
            || updates.status === "pausing"
          );
        if (progressOnly) {
          applyProgress(task.id, updates);
          return;
        }
        // Lifecycle transitions: flush any pending progress first, then apply.
        if (pendingProgressByIdRef.current.size > 0) {
          flushPendingProgress();
        }
        transferRuntime.patchTask(task.id, updates);
        setTransfers((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, ...updates } : t)),
        );
      };

      let walkStatus: TransferStatus = "transferring";
      await transferRuntime.runWalk(task.id, async () => {
        walkStatus = await processTransferBody(task, sourcePane, targetPane, targetSide, updateTask);
      });
      return walkStatus;
    });
  };

  const processTransferBody = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
    targetSide: "left" | "right",
    updateTask: (updates: Partial<TransferTask>) => void,
  ): Promise<TransferStatus> => {

    // Initialize encoding early to avoid temporal dead zone issues
    const sourceEncoding: SftpFilenameEncoding = sourcePane.connection?.isLocal
      ? "auto"
      : sourcePane.filenameEncoding || "auto";
    const targetEncoding: SftpFilenameEncoding = targetPane.connection?.isLocal
      ? "auto"
      : targetPane.filenameEncoding || "auto";

    // Browse panel sessions may be soft-closed while transfers continue on the
    // dedicated pool. Prefer live browse ids, else open pool sessions for work.
    let sourceSftpId: string | null = sourcePane.connection?.isLocal
      ? null
      : (sftpSessionsRef.current.get(sourcePane.connection!.id) ?? null);
    let targetSftpId: string | null = targetPane.connection?.isLocal
      ? null
      : (sftpSessionsRef.current.get(targetPane.connection!.id) ?? null);

    let sourceWorkLease: TransferConnectionLease | null = null;
    let targetWorkLease: TransferConnectionLease | null = null;

    const releaseWorkLeases = (mode: "release" | "discard" = "release") => {
      if (mode === "discard") {
        sourceWorkLease?.discard();
        targetWorkLease?.discard();
      } else {
        sourceWorkLease?.release();
        targetWorkLease?.release();
      }
      sourceWorkLease = null;
      targetWorkLease = null;
    };

    // Detect same-host: both sides connected to the same remote endpoint.
    // Use per-connection cache keys (hostname+port+protocol+sudo+username) instead of
    // just hostId, because the same hostId can have different session-time overrides.
    const sourceCacheKey = sourcePane.connection?.id
      ? connectionCacheKeyMapRef.current.get(sourcePane.connection.id)
      : undefined;
    const targetCacheKey = targetPane.connection?.id
      ? connectionCacheKeyMapRef.current.get(targetPane.connection.id)
      : undefined;
    // sameHost remote-cp needs a live sftpId; pool-only transfers fall back to
    // recursive file copy via transferDirectory.
    const sameHostEndpoints = !!(
      !sourcePane.connection?.isLocal && !targetPane.connection?.isLocal
      && sourceCacheKey && targetCacheKey
      && sourceCacheKey === targetCacheKey
    );

    try {
    // Prefer dedicated work leases for remote ends so folder walks/listings
    // survive browse park and tab hide (pool holders, not panel map ids).
    if (!sourcePane.connection?.isLocal) {
      const sourceHostId = task.sourceHostId || sourcePane.connection?.hostId;
      if (acquireTransferSession && sourceHostId) {
        sourceWorkLease = await acquireTransferSession(sourceHostId, `${task.id}:work-source`);
        sourceSftpId = sourceWorkLease.sftpId;
      }
      if (!sourceSftpId) {
        const sourceSide = targetSide === "left" ? "right" : "left";
        handleSessionError(sourceSide, new Error("Source SFTP session lost"));
        throw new Error("Source SFTP session not found");
      }
    }

    if (!targetPane.connection?.isLocal) {
      const targetHostId = task.targetHostId || targetPane.connection?.hostId;
      if (acquireTransferSession && targetHostId) {
        targetWorkLease = await acquireTransferSession(targetHostId, `${task.id}:work-target`);
        targetSftpId = targetWorkLease.sftpId;
      }
      if (!targetSftpId) {
        handleSessionError(targetSide, new Error("Target SFTP session lost"));
        throw new Error("Target SFTP session not found");
      }
    }

    const sameHost = sameHostEndpoints && !!sourceSftpId && !!targetSftpId;

    const discoverTransferSize = async () => {
      try {
        if (task.totalBytes > 0 || !!task.sourceLastModified) return;

        if (sourcePane.connection?.isLocal) {
          const stat = await netcattyBridge.get()?.statLocal?.(task.sourcePath);
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
          return;
        }

        if (sourceSftpId) {
          const stat = await netcattyBridge.get()?.statSftp?.(
            sourceSftpId,
            task.sourcePath,
            sourceEncoding,
          );
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
        }
      } catch (err) {
        if (!isTransferCancelledError(err)) {
          logger.debug?.("[SFTP] Deferred transfer size discovery failed", err);
        }
      }
    };

    try {
      const t0 = performance.now();
      logger.debug(`[SFTP:perf] processTransfer START — file=${task.fileName} isDir=${task.isDirectory}`);

      // Directory parents use file counts in transferredBytes/totalBytes. Never
      // seed from byte checkpointBytes (pause clears those, which would show 0/N
      // while completed children are skipped without re-counting).
      const directoryCompletedCount = task.isDirectory
        ? (task.directoryResumeCheckpoint?.completedEntries ?? 0) + transfersRef.current.filter(
            (candidate) => candidate.parentTaskId === task.id && candidate.status === "completed",
          ).length
        : 0;
      updateTask({
        status: "transferring",
        totalBytes: task.isDirectory
          ? directoryCompletedCount
          : Math.max(task.totalBytes, 0),
        transferredBytes: task.isDirectory
          ? Math.max(task.transferredBytes, directoryCompletedCount)
          : (task.checkpointBytes ?? task.transferredBytes ?? 0),
        startTime: Date.now(),
        phase: "transferring",
        resumable: task.resumable !== false,
        reconnectRequired: false,
        error: undefined,
      });

      // Run size discovery and conflict check in parallel
      const conflictCheckPromise = (async (): Promise<FileConflict | null> => {
        if (task.skipConflictCheck || !targetPane.connection) return null;

        const sourceStat: { size: number; mtime: number } | null =
          (task.totalBytes > 0 || task.sourceLastModified)
            ? { size: task.totalBytes, mtime: task.sourceLastModified || Date.now() }
            : null;

        try {
          const existingStat = await statTargetPath(targetPane, targetSftpId, task.targetPath, targetEncoding);

          if (existingStat) {
            const applyToAllCount = task.batchId
              ? await (async () => {
                  const candidates = transfersRef.current.filter((candidate) =>
                    candidate.batchId === task.batchId &&
                    candidate.isDirectory === task.isDirectory &&
                    !candidate.parentTaskId &&
                    candidate.status !== "completed" &&
                    candidate.status !== "cancelled",
                  );
                  const matches = await Promise.all(candidates.map(async (candidate) => {
                    if (candidate.id === task.id) return true;
                    try {
                      const candidateStat = await statTargetPath(
                        targetPane,
                        targetSftpId,
                        candidate.targetPath,
                        targetEncoding,
                      );
                      return candidateStat?.type === existingStat.type;
                    } catch {
                      return false;
                    }
                  }));
                  return Math.max(1, matches.filter(Boolean).length);
                })()
              : 1;

            return {
              transferId: task.id,
              batchId: task.batchId,
              fileName: task.fileName,
              sourcePath: task.sourcePath,
              targetPath: task.targetPath,
              isDirectory: task.isDirectory,
              existingType: existingStat.type,
              applyToAllCount,
              existingSize: existingStat.size,
              newSize: sourceStat?.size || task.totalBytes || 0,
              existingModified: existingStat.mtime,
              newModified: sourceStat?.mtime || Date.now(),
            };
          }
        } catch (error) {
          // Missing path = no conflict. ENOTSUP / unknown type fail closed.
          if (isMissingStatError(error)) return null;
          throw error;
        }
        return null;
      })();

      // For single files: fire-and-forget size discovery
      if (!task.isDirectory) {
        void discoverTransferSize();
      }

      // Only await conflict check (fast single stat call)
      const conflict = await conflictCheckPromise;
      // Cancel/Stop may have won while conflict stats were in flight.
      if (cancelledTasksRef.current.has(task.id)) return "cancelled";

      if (conflict) {
        const defaultAction = conflictDefaultsRef.current
          .get(task.batchId ?? "global")
          ?.get(getSftpConflictTypeKey(task.isDirectory, conflict.existingType));
        if (defaultAction) {
          if (defaultAction === "stop") {
            await markBatchStopped(task);
            return "cancelled";
          }

          if (defaultAction === "skip") {
            cancelledTasksRef.current.add(task.id);
            updateTask({ status: "cancelled", endTime: Date.now() });
            await completeCancelledTask(task);
            return "cancelled";
          }

          if (defaultAction === "replace" && !canReplaceSftpConflict(task.isDirectory, conflict.existingType)) {
            updateTask({
              status: "failed",
              endTime: Date.now(),
              error: buildReplaceTypeMismatchError(task.isDirectory, conflict.existingType, task.targetPath),
              retryable: false,
            });
            return "failed";
          }

          if (
            defaultAction === "replace"
            && shouldUnlinkSftpConflictBeforeReplace(conflict.existingType)
          ) {
            await deleteTargetPath(task, targetPane, targetSftpId, targetEncoding, "symlink");
          }

          const duplicateTarget = defaultAction === "duplicate"
            ? await getDuplicateTarget(task, targetPane, targetSftpId, targetEncoding)
            : null;
          if (cancelledTasksRef.current.has(task.id)) return "cancelled";
          const updatedTask: TransferTask = {
            ...task,
            ...(duplicateTarget
              ? {
                  fileName: duplicateTarget.fileName,
                  targetPath: duplicateTarget.targetPath,
                }
              : null),
            skipConflictCheck: true,
            replaceExistingTarget: defaultAction === "replace",
          };
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === task.id
                ? { ...updatedTask, status: "pending" as TransferStatus }
                : t,
            ),
          );
          return processTransfer(updatedTask, sourcePane, targetPane, targetSide);
        }

        if (cancelledTasksRef.current.has(task.id)) return "cancelled";
        setConflicts((prev) => [...prev, conflict]);
        updateTask({
          status: "attention",
          totalBytes: conflict.newSize || task.totalBytes || 0,
          conflict,
        });
        return "attention";
      }

      logger.debug(`[SFTP:perf] starting actual transfer — file=${task.fileName} isDir=${task.isDirectory} — ${(performance.now() - t0).toFixed(0)}ms since start`);
      await waitUntilTransferResumed(task.id);
      if (cancelledTasksRef.current.has(task.id)) return "cancelled";

      let dirPartialFailure = false;

      // Same-host exec-based paths are only safe for UTF-8 compatible encodings.
      // "auto" is allowed here — the backend resolves it to the actual encoding
      // and skips exec if it resolved to non-UTF-8 (e.g. gb18030).
      const encodingSafeForExec =
        (!sourceEncoding || sourceEncoding === "utf-8" || sourceEncoding === "auto") &&
        (!targetEncoding || targetEncoding === "utf-8" || targetEncoding === "auto");

      // Try same-host directory optimization first; falls back to recursive transfer
      // if remote cp is unavailable (e.g. Windows SSH servers).
      let dirHandledBySameHost = false;
      if (
        task.isDirectory
        && !task.replaceExistingTarget
        && task.resumable === false
        && sameHost
        && encodingSafeForExec
        && sourceSftpId
      ) {
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        const result = await netcattyBridge.require().sameHostCopyDirectory!(
          sourceSftpId,
          task.sourcePath,
          task.targetPath,
          sourceEncoding,
          task.id,
        );
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        dirHandledBySameHost = result.success;
      }

      if (task.isDirectory && !dirHandledBySameHost) {
        // For directory transfers, parent task uses:
        //   totalBytes = total file count (discovered async)
        //   transferredBytes = completed file count (incremented by child completions)
        // Child file tasks are registered in transfers array with their own byte progress.

        const stagedTargetPath = task.replaceExistingTarget
          ? `${task.targetPath}.netcatty-${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}.part`
          : undefined;
        const directoryTask = stagedTargetPath ? { ...task, targetPath: stagedTargetPath } : task;
        if (stagedTargetPath) updateTask({ stagedTargetPath });

        const dirErrors = await transferDirectory(
          directoryTask,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );

        if (dirErrors > 0) {
          dirPartialFailure = true;
        } else if (stagedTargetPath) {
          const bridge = netcattyBridge.require();
          const backupPath = `${task.targetPath}.netcatty-${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}.backup`;
          if (targetPane.connection!.isLocal) {
            if (!bridge.statLocal || !bridge.renameLocalFile || !bridge.deleteLocalFile) {
              throw new Error("Local directory replacement is unavailable");
            }
            await promoteDirectoryReplacePaths({
              targetPath: task.targetPath,
              stagedPath: stagedTargetPath,
              backupPath,
              statPath: bridge.statLocal,
              renamePath: bridge.renameLocalFile,
              deletePath: bridge.deleteLocalFile,
            });
          } else if (targetSftpId) {
            if (!bridge.statSftp || !bridge.renameSftp || !bridge.deleteSftp) {
              throw new Error("Remote directory replacement is unavailable");
            }
            await promoteDirectoryReplacePaths({
              targetPath: task.targetPath,
              stagedPath: stagedTargetPath,
              backupPath,
              statPath: (candidate) => bridge.statSftp!(targetSftpId, candidate, targetEncoding),
              renamePath: (source, target) => bridge.renameSftp!(targetSftpId, source, target, targetEncoding),
              deletePath: (candidate) => bridge.deleteSftp!(targetSftpId, candidate, targetEncoding),
            });
          } else {
            throw new Error("Target SFTP session missing for directory promote");
          }
          updateTask({ stagedTargetPath: undefined });
        }
      } else if (!task.isDirectory) {
        await transferFile(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );
      }

      if (cancelledTasksRef.current.has(task.id)) {
        throw new Error("Transfer cancelled");
      }

      const fallbackTask = transfersRef.current.find((candidate) => candidate.id === task.id)
        ?? task;
      // Publish terminal lifecycle through the runtime-aware writer while the
      // directory walk is still registered. A panel-only setState could be
      // rejected as stale by the global transfer center and remain active at 100%.
      const finalStatus = finishTransferTask(
        fallbackTask,
        {
          partialFailure: dirPartialFailure,
          cancelled: cancelledTasksRef.current.has(task.id),
        },
        () => {
          if (pendingProgressByIdRef.current.size > 0) {
            flushPendingProgress();
          }
        },
        (canonicalTask) => {
          const next = transfersRef.current.map((candidate) => (
            candidate.id === task.id ? canonicalTask : candidate
          ));
          transfersRef.current = next;
          setTransfersState(next);
        },
      );

      // Target contents may have been cached before this transfer started,
      // especially when dropping into a subdirectory like "/tmp" from its parent.
      // Clear the target connection cache so the next navigation reloads fresh data.
      clearCacheForConnection(task.targetConnectionId);

      const targetTab = getTabByConnectionId(task.targetConnectionId);
      if (targetTab) {
        updateTab(targetTab.side, targetTab.tabId, (prev) => ({
          ...prev,
          transferMutationToken: prev.transferMutationToken + 1,
        }));
      }

      // Refresh the specific target tab, not whichever tab happens to be
      // active now — focus may have switched during the transfer.
      if (getParentPath(task.targetPath) === targetPane.connection!.currentPath) {
        await refresh(targetSide, { tabId: targetPane.id });
      }
      // Clean up tracked child IDs for this transfer
      activeChildIdsRef.current.delete(task.id);

      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: finalStatus,
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return finalStatus;
    } catch (err) {
      activeChildIdsRef.current.delete(task.id);
      // Check if this was a cancellation
      const isCancelled = cancelledTasksRef.current.has(task.id) ||
        (err instanceof Error && err.message === "Transfer cancelled");

      if (isCancelled) {
        // Don't update status - cancelTransfer already set it to cancelled
        const completionHandler = completionHandlersRef.current.get(task.id);
        if (completionHandler) {
          try {
            await completionHandler({
              id: task.id,
              fileName: task.fileName,
              originalFileName: task.originalFileName ?? task.fileName,
              status: "cancelled",
            });
          } finally {
            completionHandlersRef.current.delete(task.id);
          }
        }
        clearCancelledTask(task.id);
        return "cancelled";
      }

      updateTask({
        status: "failed",
        error: err instanceof Error ? err.message : "Transfer failed",
        endTime: Date.now(),
        speed: 0,
      });
      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: "failed",
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return "failed";
    }
    } finally {
      // Walk registry cleanup is owned by transferRuntime.runWalk.
      // Drop ephemeral pool holds opened when browse was soft-closed.
      // Per-file transferDirectory leases are released inside transferDirectory.
      releaseWorkLeases();
    }
  };

  const startTransfer = useCallback(
    async (
      sourceFiles: { name: string; isDirectory: boolean }[],
      sourceSide: "left" | "right",
      targetSide: "left" | "right",
      options?: {
        sourcePane?: SftpPane;
        sourcePath?: string;
        sourceConnectionId?: string;
        targetPath?: string;
        onTransferComplete?: (result: TransferResult) => void | Promise<void>;
      },
    ) => {
      const sourcePane = options?.sourcePane
        ?? (options?.sourceConnectionId ? getPaneByConnectionId(options.sourceConnectionId) : null)
        ?? getActivePane(sourceSide);
      const targetPane = getActivePane(targetSide);

      if (!sourcePane?.connection || !targetPane?.connection) return [];

      const sourcePath = options?.sourcePath ?? sourcePane.connection.currentPath;
      const targetPath = options?.targetPath ?? targetPane.connection.currentPath;
      const sourceConnectionId = options?.sourceConnectionId ?? sourcePane.connection.id;
      const batchId = crypto.randomUUID();
      const usesLegacyScp = sourcePane.connection.fileProtocol === "scp" || targetPane.connection.fileProtocol === "scp";

      const newTasks: TransferTask[] = [];
      const skippedResults: TransferResult[] = [];

      const canReusePaneMetadata = sourcePath === sourcePane.connection.currentPath;
      const fileEntryMap = canReusePaneMetadata
        ? new Map(sourcePane.files.map(f => [f.name, f]))
        : null;

      for (const file of sourceFiles) {
        const direction: TransferDirection =
          sourcePane.connection!.isLocal && !targetPane.connection!.isLocal
            ? "upload"
            : !sourcePane.connection!.isLocal && targetPane.connection!.isLocal
              ? "download"
              : "remote-to-remote";

        // Use cached metadata from the source pane's file list to avoid
        // redundant stat calls over the network, but only when the transfer
        // source matches the pane's currently listed directory.
        const fileEntry = fileEntryMap?.get(file.name);
        const fileSize = file.isDirectory ? 0 : (fileEntry?.size ?? 0);
        const sourceLastModified = fileEntry?.lastModified ?? 0;

        const nextSourcePath = joinPath(sourcePath, file.name);
        const nextTargetPath = joinPath(targetPath, file.name);
        const targetIsLocal = targetPane.connection!.isLocal;
        const pathTaken = findActivePathConflict(
          [...sftpTransferCenterStore.getSnapshot().tasks, ...transfersRef.current, ...newTasks],
          {
            id: "",
            targetPath: nextTargetPath,
            // Normalize local pane ids to the same sentinel downloadToLocal uses.
            targetConnectionId: targetIsLocal ? "local" : targetPane.connection!.id,
            targetHostId: targetIsLocal ? undefined : targetPane.connection!.hostId,
            targetHostLabel: targetIsLocal ? "Local" : targetPane.connection!.hostLabel,
            isDirectory: file.isDirectory,
          },
        );
        if (pathTaken) {
          notifyPathConflict(pathTaken, tRef.current);
          const message = pathConflictMessage(pathTaken);
          const attentionTask: TransferTask = {
            id: crypto.randomUUID(),
            batchId,
            fileName: file.name,
            originalFileName: file.name,
            sourcePath: nextSourcePath,
            targetPath: nextTargetPath,
            sourceConnectionId,
            targetConnectionId: targetPane.connection!.id,
            sourceHostId: sourcePane.connection!.isLocal ? undefined : sourcePane.connection!.hostId,
            sourceHostLabel: sourcePane.connection!.isLocal ? "Local" : sourcePane.connection!.hostLabel,
            targetHostId: targetIsLocal ? undefined : targetPane.connection!.hostId,
            targetHostLabel: targetIsLocal ? "Local" : targetPane.connection!.hostLabel,
            direction,
            status: "attention",
            totalBytes: fileSize,
            transferredBytes: 0,
            speed: 0,
            startTime: Date.now(),
            endTime: Date.now(),
            isDirectory: file.isDirectory,
            progressMode: file.isDirectory ? "files" : "bytes",
            sourceLastModified,
            origin: "manual",
            error: message,
            resumable: false,
          };
          newTasks.push(attentionTask);
          const skipped: TransferResult = {
            id: attentionTask.id,
            fileName: attentionTask.fileName,
            originalFileName: attentionTask.originalFileName ?? attentionTask.fileName,
            status: "attention",
          };
          skippedResults.push(skipped);
          if (options?.onTransferComplete) {
            await options.onTransferComplete(skipped);
          }
          continue;
        }
        newTasks.push({
          id: crypto.randomUUID(),
          batchId,
          fileName: file.name,
          originalFileName: file.name,
          sourcePath: nextSourcePath,
          targetPath: nextTargetPath,
          sourceConnectionId,
          targetConnectionId: targetPane.connection!.id,
          sourceHostId: sourcePane.connection!.isLocal ? undefined : sourcePane.connection!.hostId,
          sourceHostLabel: sourcePane.connection!.isLocal ? "Local" : sourcePane.connection!.hostLabel,
          targetHostId: targetPane.connection!.isLocal ? undefined : targetPane.connection!.hostId,
          targetHostLabel: targetPane.connection!.isLocal ? "Local" : targetPane.connection!.hostLabel,
          direction,
          status: "pending" as TransferStatus,
          totalBytes: fileSize,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: file.isDirectory,
          progressMode: file.isDirectory ? "files" : "bytes",
          sourceLastModified,
          origin: "manual",
          resumable: !usesLegacyScp,
          pauseUnavailableReason: usesLegacyScp ? "This server uses legacy SCP; cancel and retry from the beginning instead" : undefined,
          phase: file.isDirectory ? "scanning" : "transferring",
        });
      }

      setTransfers((prev) => [...prev, ...newTasks]);

      // Only enqueue runnable tasks — attention path-conflict rows stay visible
      // and must not re-enter processTransfer.
      const runnableTasks = newTasks.filter((task) => task.status !== "attention");

      if (options?.onTransferComplete) {
        for (const task of runnableTasks) {
          completionHandlersRef.current.set(task.id, options.onTransferComplete);
        }
      }

      const results = await Promise.all(runnableTasks.map(async (task): Promise<TransferResult> => {
        const status = await processTransfer(task, sourcePane, targetPane, targetSide);
        return {
          id: task.id,
          fileName: task.fileName,
          originalFileName: task.originalFileName ?? task.fileName,
          status,
        };
      }));

      return [...skippedResults, ...results];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getActivePane, getPaneByConnectionId, getTabByConnectionId, sftpSessionsRef, updateTab],
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      const taskToCancel = transfersRef.current.find((task) => task.id === transferId);
      // Add to cancelled set so async operations can check (local + process-global
      // so walks survive panel unmount and still honor center Cancel).
      cancelledTasksRef.current.add(transferId);
      markTransferCancelled(transferId);
      releasePausedTransfer(transferId);
      globalSftpTransferScheduler.cancel(transferId);

      // Cancel parent + remove child tasks
      const childIdsToCancel = new Set<string>();
      const childrenToCleanup: TransferTask[] = [];
      for (const t of transfersRef.current) {
        if (t.parentTaskId === transferId && !["completed", "cancelled", "failed"].includes(t.status)) {
          childIdsToCancel.add(t.id);
          childrenToCleanup.push(t);
        }
      }
      for (const cid of activeChildIdsRef.current.get(transferId) ?? []) {
        if (!childIdsToCancel.has(cid)) {
          childIdsToCancel.add(cid);
          if (taskToCancel) {
            childrenToCleanup.push({
              ...taskToCancel,
              id: cid,
              parentTaskId: transferId,
            });
          }
        }
      }
      for (const cid of childIdsToCancel) {
        cancelledTasksRef.current.add(cid);
        markTransferCancelled(cid);
        globalSftpTransferScheduler.cancel(cid);
      }
      markTransferCancelledTree(transferId, [...childIdsToCancel]);
      // Keep refs in sync immediately so same-turn resolveConflict/resume sees cancel.
      const nextTransfers = transfersRef.current
        .filter((t) => t.parentTaskId !== transferId)
        .map((t) =>
          t.id === transferId
            ? { ...t, status: "cancelled" as TransferStatus, endTime: Date.now(), conflict: undefined }
            : t,
        );
      setTransfers(nextTransfers);
      conflictsRef.current = conflictsRef.current.filter((c) => c.transferId !== transferId && !childIdsToCancel.has(c.transferId));
      setConflicts(conflictsRef.current);

      await cancelBackendTransfers([transferId, ...childIdsToCancel]);
      if (taskToCancel) await cleanupTaskArtifacts(taskToCancel);
      // Child stages are keyed by per-file transferId — clean each known child.
      for (const child of childrenToCleanup) {
        try {
          await cleanupTaskArtifacts(child);
        } catch {
          // best-effort
        }
      }

    },
    [cancelBackendTransfers, cleanupTaskArtifacts, releasePausedTransfer, setTransfers],
  );

  // Soft pause/resume: single TransferRuntime entry (store soft-control +
  // dedicated hard reconnect). No panel-local soft-control dual path.
  const resumeTransfer = useCallback(async (transferId: string) => {
    // Clear sticky child cancel latches so re-walk can retry same child ids.
    clearCancelledTask(transferId);
    for (const child of transfersRef.current) {
      if (child.parentTaskId === transferId) clearCancelledTask(child.id);
    }
    for (const childId of activeChildIdsRef.current.get(transferId) ?? []) {
      clearCancelledTask(childId);
    }
    clearTransferCancelledTree(
      transferId,
      [...(activeChildIdsRef.current.get(transferId) ?? [])],
    );
    await transferRuntime.resume(transferId);
  }, [clearCancelledTask]);

  const prioritizeTransfer = useCallback((transferId: string) => {
    globalSftpTransferScheduler.prioritize(transferId);
    void netcattyBridge.get()?.prioritizeTransfer?.(transferId);
    setTransfers((prev) => {
      const nextPriority = prev.reduce((max, task) => Math.max(max, task.priority ?? 0), 0) + 1;
      return prev.map((task) => task.id === transferId ? { ...task, priority: nextPriority } : task);
    });
  }, [setTransfers]);

  const retryTransfer = useCallback(
    async (transferId: string) => {
      // Prefer the live owner list; fall back to the center store (drag-drop
      // children are upserted there and mirrored via subscribe).
      const task = transfersRef.current.find((t) => t.id === transferId)
        ?? sftpTransferCenterStore.getTask(transferId);
      if (!task || task.retryable === false) return;

      // Progressive / external drag-drop children never have dual-pane endpoints
      // (sourceConnectionId is "external"). Re-run startStreamTransfer in place.
      if (isExternalDragDropFileUpload(task)) {
        if (inFlightTransferIdsRef.current.has(transferId)) return;
        inFlightTransferIdsRef.current.add(transferId);
        clearTransferCancelled(transferId);
        cancelledTasksRef.current.delete(transferId);
        try {
          const result = await retryExternalDragDropFileUpload(task, {
            getBrowseSftpId: (connectionId) => sftpSessionsRef.current.get(connectionId),
            acquireTransferSession: acquireTransferSession
              ? (hostId, id) => acquireTransferSession(hostId, id)
              : undefined,
            startStreamTransfer: async (options) => {
              const bridge = netcattyBridge.get();
              if (!bridge?.startStreamTransfer) {
                return { error: "Stream transfer is unavailable" };
              }
              return bridge.startStreamTransfer(options);
            },
            clearPendingCancel: (id) => netcattyBridge.get()?.clearPendingTransferCancel?.(id),
            cleanupArtifacts: cleanupTaskArtifacts,
            getTask: (id) => sftpTransferCenterStore.getTask(id)
              ?? transfersRef.current.find((row) => row.id === id),
            getChildTasks: (parentId) => {
              const fromStore = sftpTransferCenterStore.getOwnerTasks(ownerId)
                .filter((row) => row.parentTaskId === parentId);
              if (fromStore.length > 0) return fromStore;
              return transfersRef.current.filter((row) => row.parentTaskId === parentId);
            },
            onPatch: (taskId, updates) => {
              transferRuntime.patchTask(taskId, updates);
              setTransfers((prev) => {
                if (!prev.some((row) => row.id === taskId)) {
                  // Store-only child: mirror the patch by re-pulling owner rows.
                  return sftpTransferCenterStore.getOwnerTasks(ownerId);
                }
                return prev.map((row) => (row.id === taskId ? { ...row, ...updates } : row));
              });
            },
          });
          if (!result.success && result.error && !/cancelled/i.test(result.error)) {
            notify.warning(result.error, "SFTP");
          }
        } finally {
          inFlightTransferIdsRef.current.delete(transferId);
        }
        return;
      }

      await cleanupTaskArtifacts(task);

      const retriedTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        status: "pending" as TransferStatus,
        error: undefined,
        transferredBytes: 0,
        checkpointBytes: 0,
        resumeStage: undefined,
        downloadCheckpointBytes: undefined,
        uploadCheckpointBytes: undefined,
        directoryResumeCheckpoint: undefined,
        speed: 0,
        startTime: Date.now(),
        endTime: undefined,
        lifecycleEpoch: undefined,
      };

      const endpoints = resolveTaskEndpoints(task);
      if (!endpoints) {
        notify.warning(
          "Could not resolve transfer endpoints for retry. Reconnect the target and try again.",
          "SFTP",
        );
        return;
      }
      const { targetSide, sourcePane, targetPane } = endpoints;

      const completionHandler = completionHandlersRef.current.get(transferId);
      if (completionHandler) {
        completionHandlersRef.current.set(retriedTask.id, completionHandler);
        completionHandlersRef.current.delete(transferId);
      }

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? retriedTask
            : t,
        ),
      );
      await processTransfer(retriedTask, sourcePane, targetPane, targetSide);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline
    [acquireTransferSession, cleanupTaskArtifacts, ownerId, resolveTaskEndpoints, setTransfers, sftpSessionsRef],
  );

  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) => {
      const unfinishedParents = new Set(
        prev.filter((t) => !["completed", "cancelled", "failed"].includes(t.status)).map((t) => t.id),
      );
      // Keep non-compacted terminal exceptions of unfinished directory parents;
      // compacted completions already live in the bounded parent checkpoint.
      return prev.filter((t) => {
        if (t.parentTaskId && unfinishedParents.has(t.parentTaskId)) return true;
        return t.status !== "completed" && t.status !== "cancelled";
      });
    });
  }, [setTransfers]);

  const dismissTransfer = useCallback((transferId: string) => {
    const task = transfersRef.current.find((candidate) => candidate.id === transferId);
    if (task) void cleanupTaskArtifacts(task);
    setTransfers((prev) => prev.filter((t) => t.id !== transferId && t.parentTaskId !== transferId));
  }, [cleanupTaskArtifacts, setTransfers]);

  const dismissTransfers = useCallback((prunedTasks: readonly TransferTask[]) => {
    if (prunedTasks.length === 0) return;
    const removing = new Set(prunedTasks.map((task) => task.id));
    const artifactTasks = prunedTasks.filter((task) => task.status !== "completed");
    // This callback is used only for automatic history eviction. Completed
    // streams already cleaned their staging files; sending one cleanup IPC per
    // pruned child recreates a main-process event storm at folder completion.
    setTransfers((prev) => prev.filter((task) => (
      !removing.has(task.id) && !removing.has(task.parentTaskId ?? "")
    )));
    // Failed/cancelled transfers can retain resumable staging files. Clean them
    // sequentially in the background so a large eviction never floods IPC.
    if (artifactTasks.length > 0) {
      void (async () => {
        for (const task of artifactTasks) {
          try {
            await cleanupTaskArtifacts(task);
          } catch {
            // best-effort history cleanup
          }
        }
      })();
    }
  }, [cleanupTaskArtifacts, setTransfers]);

  const isTransferCancelled = useCallback((transferId: string) => {
    return cancelledTasksRef.current.has(transferId) || isTransferCancelledFlag(transferId);
  }, []);

  const resolveConflict = useCallback(
    async (conflictId: string, action: FileConflictAction, applyToAll = false) => {
      if (cancelledTasksRef.current.has(conflictId)) return;
      const conflict = conflictsRef.current.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      const task = transfersRef.current.find((t) => t.id === conflictId);
      if (!task) {
        // Dialog can show a store-owned conflict before the panel adopts the row.
        // Clearing only React state leaves attention+conflict in localStorage and
        // the prompt returns on the next SFTP open (issue #2636).
        conflictsRef.current = conflictsRef.current.filter((c) => c.transferId !== conflictId);
        setConflicts(conflictsRef.current);
        if (action === "stop" || action === "skip") {
          sftpTransferCenterStore.patchTask(conflictId, {
            status: "cancelled",
            conflict: undefined,
            endTime: Date.now(),
            speed: 0,
            error: undefined,
          });
        }
        return;
      }

      const selectedConflictKey = conflictDefaultKey(conflict.batchId, conflict.isDirectory, conflict.existingType);
      const affectedConflicts = applyToAll
        ? conflictsRef.current.filter((candidate) =>
            conflictDefaultKey(candidate.batchId, candidate.isDirectory, candidate.existingType) === selectedConflictKey,
          )
        : [conflict];
      const affectedConflictIds = new Set(affectedConflicts.map((candidate) => candidate.transferId));
      const affectedTasks = affectedConflicts
        .map((candidate) => transfersRef.current.find((transfer) => transfer.id === candidate.transferId))
        .filter((candidate): candidate is TransferTask => Boolean(candidate));
      const affectedConflictById = new Map<string, FileConflict>(
        affectedConflicts.map((candidate): [string, FileConflict] => [candidate.transferId, candidate]),
      );

      if (applyToAll) {
        const batchId = conflict.batchId ?? "global";
        const batchDefaults = conflictDefaultsRef.current.get(batchId) ?? new Map<string, FileConflictAction>();
        batchDefaults.set(getSftpConflictTypeKey(conflict.isDirectory, conflict.existingType), action);
        conflictDefaultsRef.current.set(batchId, batchDefaults);
      }

      // Eagerly clear refs so a double-click cannot schedule two processTransfer calls.
      conflictsRef.current = conflictsRef.current.filter((c) => !affectedConflictIds.has(c.transferId));
      setConflicts(conflictsRef.current);

      if (affectedTasks.length === 0) {
        return;
      }

      if (action === "stop") {
        await markBatchStopped(task);
        return;
      }

      if (action === "skip") {
        for (const affectedTask of affectedTasks) {
          cancelledTasksRef.current.add(affectedTask.id);
        }
        // Drop conflict so remount / restart cannot rehydrate the dialog from a
        // cancelled row that still carries conflict metadata.
        setTransfers((prev) =>
          prev.map((t) => affectedConflictIds.has(t.id)
              ? {
                  ...t,
                  status: "cancelled" as TransferStatus,
                  endTime: Date.now(),
                  conflict: undefined,
                  error: undefined,
                  speed: 0,
                }
              : t,
          ),
        );
        for (const affectedTask of affectedTasks) {
          await completeCancelledTask(affectedTask);
        }
        return;
      }

      const updatedTasks: TransferTask[] = [];
      const blockedReplaceTasks: Array<{ task: TransferTask; conflict: FileConflict }> = [];
      const failedReplaceTasks: Array<{ task: TransferTask; error: string }> = [];

      for (const affectedTask of affectedTasks) {
        if (cancelledTasksRef.current.has(affectedTask.id)) continue;
        let updatedTask = { ...affectedTask };
        const affectedConflict = affectedConflictById.get(affectedTask.id);

        if (action === "duplicate") {
          const endpoints = resolveTaskEndpoints(affectedTask);
          if (!endpoints) continue;
          const targetSftpId = endpoints.targetPane.connection?.isLocal
            ? null
            : sftpSessionsRef.current.get(endpoints.targetPane.connection!.id) ?? null;
          const targetEncoding = endpoints.targetPane.connection?.isLocal
            ? "auto"
            : endpoints.targetPane.filenameEncoding || "auto";
          const duplicateTarget = await getDuplicateTarget(affectedTask, endpoints.targetPane, targetSftpId, targetEncoding);
          if (cancelledTasksRef.current.has(affectedTask.id)) continue;
          updatedTask = {
            ...affectedTask,
            fileName: duplicateTarget.fileName,
            targetPath: duplicateTarget.targetPath,
            skipConflictCheck: true,
          };
        } else if (action === "replace") {
          if (
            affectedConflict &&
            !canReplaceSftpConflict(affectedTask.isDirectory, affectedConflict.existingType)
          ) {
            blockedReplaceTasks.push({ task: affectedTask, conflict: affectedConflict });
            continue;
          }
          if (
            affectedConflict
            && shouldUnlinkSftpConflictBeforeReplace(affectedConflict.existingType)
          ) {
            const endpoints = resolveTaskEndpoints(affectedTask);
            if (!endpoints?.targetPane.connection) continue;
            const targetSftpId = endpoints.targetPane.connection.isLocal
              ? null
              : sftpSessionsRef.current.get(endpoints.targetPane.connection.id) ?? null;
            const targetEncoding = endpoints.targetPane.connection.isLocal
              ? "auto"
              : endpoints.targetPane.filenameEncoding || "auto";
            try {
              await deleteTargetPath(
                affectedTask,
                endpoints.targetPane,
                targetSftpId,
                targetEncoding,
                "symlink",
              );
            } catch (error) {
              failedReplaceTasks.push({
                task: affectedTask,
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }
          }
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: true,
          };
        } else if (action === "merge") {
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: false,
          };
        }

        updatedTasks.push(updatedTask);
      }

      if (blockedReplaceTasks.length > 0) {
        const blockedTaskIds = new Set(blockedReplaceTasks.map(({ task }) => task.id));
        const blockedErrors = new Map(
          blockedReplaceTasks.map(({ task, conflict }) => [
            task.id,
            buildReplaceTypeMismatchError(task.isDirectory, conflict.existingType, task.targetPath),
          ]),
        );
        setTransfers((prev) =>
          prev.map((t) => blockedTaskIds.has(t.id)
            ? {
                ...t,
                status: "failed" as TransferStatus,
                endTime: Date.now(),
                error: blockedErrors.get(t.id),
                retryable: false,
                conflict: undefined,
              }
            : t,
          ),
        );
      }

      if (failedReplaceTasks.length > 0) {
        const failedErrors = new Map(
          failedReplaceTasks.map(({ task: failedTask, error }) => [failedTask.id, error]),
        );
        setTransfers((prev) =>
          prev.map((candidate) => failedErrors.has(candidate.id)
            ? {
                ...candidate,
                status: "failed" as TransferStatus,
                endTime: Date.now(),
                error: failedErrors.get(candidate.id),
                conflict: undefined,
              }
            : candidate,
          ),
        );
      }

      const liveUpdatedTasks = updatedTasks.filter((candidate) => !cancelledTasksRef.current.has(candidate.id));
      const updatedTaskMap = new Map(liveUpdatedTasks.map((updatedTask) => [updatedTask.id, updatedTask]));
      setTransfers((prev) =>
        prev.map((t) => {
          if (t.status === "cancelled" || cancelledTasksRef.current.has(t.id)) return t;
          const updatedTask = updatedTaskMap.get(t.id);
          return updatedTask
            ? { ...updatedTask, status: "pending" as TransferStatus, conflict: undefined }
            : t;
        }),
      );

      for (const updatedTask of liveUpdatedTasks) {
        const identity = captureDeferredTransferAttempt(
          updatedTask,
          ownerId,
          connectionCacheKeyMapRef.current,
        );
        const resolveCurrentAttempt = () => {
          const current = transfersRef.current.find((candidate) => candidate.id === updatedTask.id);
          if (
            cancelledTasksRef.current.has(updatedTask.id)
            || !isDeferredTransferAttemptCurrent(current, identity, connectionCacheKeyMapRef.current)
          ) return null;
          const endpoints = resolveTaskEndpoints(current!);
          if (!endpoints?.sourcePane.connection || !endpoints.targetPane.connection) return null;
          const sourceMatches = current!.sourceConnectionId === "local"
            ? endpoints.sourcePane.connection.isLocal
            : endpoints.sourcePane.connection.id === current!.sourceConnectionId;
          const targetMatches = current!.targetConnectionId === "local"
            ? endpoints.targetPane.connection.isLocal
            : endpoints.targetPane.connection.id === current!.targetConnectionId;
          if (!sourceMatches || !targetMatches) return null;
          return { current: current!, endpoints };
        };
        deferredConflictAttemptsRef.current?.schedule(
          updatedTask.id,
          100,
          () => resolveCurrentAttempt() !== null,
          async () => {
            const attempt = resolveCurrentAttempt();
            if (!attempt) return;
            await processTransfer(
              attempt.current,
              attempt.endpoints.sourcePane,
              attempt.endpoints.targetPane,
              attempt.endpoints.targetSide,
            );
          },
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline; transfers/conflicts accessed via refs
    [
      completeCancelledTask,
      connectionCacheKeyMapRef,
      conflictDefaultKey,
      getDuplicateTarget,
      markBatchStopped,
      ownerId,
      resolveTaskEndpoints,
      sftpSessionsRef,
    ],
  );

  // Only work that is still moving or queued — paused rows must not keep the
  // header "N active" lit or pause feels like it did nothing.
  const activeTransfersCount = useMemo(() => transfers.filter(
    (t) => !t.parentTaskId
      && ["pending", "queued", "transferring", "pausing"].includes(t.status),
  ).length, [transfers]);

  const downloadToLocal = useCallback(
    async (params: {
      fileName: string;
      sourcePath: string;
      targetPath: string;
      sftpId: string;
      connectionId: string;
      sourceHostId: string;
      sourceHostLabel: string;
      sourceEncoding?: SftpFilenameEncoding;
      isDirectory: boolean;
      totalBytes?: number;
    }): Promise<TransferStatus> => {
      // Same destination concurrent writers corrupt .part / final files.
      // Must pass the local endpoint identity — createDirectDownloadTransferTask
      // stores targetConnectionId:"local"; a bare { targetPath } never matches
      // isLocalTransferDestination and silently skips dedupe (double download).
      const downloadDest = {
        targetPath: params.targetPath,
        targetConnectionId: "local" as const,
        targetHostLabel: "Local",
        isDirectory: params.isDirectory,
      };
      const conflict = findActivePathConflict(
        [...sftpTransferCenterStore.getSnapshot().tasks, ...transfersRef.current],
        { id: "", ...downloadDest },
      );
      if (conflict) {
        notifyPathConflict(conflict, tRef.current);
        return conflict.status === "completed" ? "completed" : "attention";
      }

      const task = createDirectDownloadTransferTask({
        id: crypto.randomUUID(),
        fileName: params.fileName,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        sourceConnectionId: params.connectionId,
        sourceHostId: params.sourceHostId,
        sourceHostLabel: params.sourceHostLabel,
        totalBytes: params.totalBytes ?? 0,
        isDirectory: params.isDirectory,
      });

      // Reserve the path in transfersRef before any await so concurrent
      // downloadToLocal calls (double-click) see each other.
      setTransfers((prev) => {
        const raced = findActivePathConflict(
          [...sftpTransferCenterStore.getSnapshot().tasks, ...prev],
          { id: task.id, ...downloadDest },
        );
        if (raced) return prev;
        return [...prev, task];
      });
      if (!transfersRef.current.some((row) => row.id === task.id)) {
        notifyPathConflict(
          findActivePathConflict(
            [...sftpTransferCenterStore.getSnapshot().tasks, ...transfersRef.current],
            { id: "", ...downloadDest },
          ) ?? task,
          tRef.current,
        );
        return "attention";
      }

      const sourceEncoding = params.sourceEncoding ?? "auto";
      // Mutable counter to track child failures outside React state,
      // so the final status check doesn't depend on render timing.
      let childFailureCount = 0;

      // Dedicated pool only when host id is known — never fall back to browse
      // (tab close would kill the download and freeze the global center).
      let sourceWorkLease: TransferConnectionLease | null = null;
      let workingSourceSftpId = params.sftpId;
      if (acquireTransferSession && params.sourceHostId) {
        sourceWorkLease = await acquireTransferSession(
          params.sourceHostId,
          `${task.id}:work-source`,
        );
        workingSourceSftpId = sourceWorkLease.sftpId;
      }

      try {
        if (params.isDirectory) {
          childFailureCount = await transferDirectory(
            task,
            workingSourceSftpId,
            null,       // targetSftpId = null (local)
            false,       // sourceIsLocal = false
            true,        // targetIsLocal = true
            sourceEncoding,
            "auto",      // targetEncoding
            task.id,
            false,       // sameHost
            0,           // symlinkDepth
            true,        // followSymlinks — download should expand symlink dirs
          );
        } else {
          await transferFile(
            task,
            workingSourceSftpId,
            null,
            false,
            true,
            sourceEncoding,
            "auto",
            task.id,
          );
        }

        // Use childFailureCount (tracked outside React state) to determine
        // final status reliably, regardless of render timing.
        // Cancel must win: transferDirectory counts cancelled children as errors,
        // but cancelTransfer already marked the parent cancelled — do not demote
        // it to failed with "Some files failed to transfer".
        // Re-read cancel inside the state update so a cancel that lands after
        // transferDirectory returns cannot be overwritten by completed/failed.
        let appliedStatus: TransferStatus = "completed";
        setTransfers((prev) => {
          const liveParent = prev.find((candidate) => candidate.id === task.id);
          const completedCount = (liveParent?.directoryResumeCheckpoint?.completedEntries ?? 0) + prev.filter(
            (t) => t.parentTaskId === task.id && t.status === "completed",
          ).length;
          return prev.map((t) => {
            if (t.id !== task.id) return t;
            const parentCancelled = t.status === "cancelled"
              || cancelledTasksRef.current.has(task.id);
            const resolved = resolveDirectDirectoryDownloadFinalStatus({
              parentCancelled,
              childFailureCount,
            });
            appliedStatus = resolved.status;
            if (resolved.status === "cancelled") {
              cancelledTasksRef.current.delete(task.id);
              return {
                ...t,
                status: "cancelled" as TransferStatus,
                error: undefined,
                endTime: Date.now(),
                // Keep partial progress — do not look 100% complete when cancelled.
                speed: 0,
              };
            }
            const finalTotal = t.totalBytes > 0 ? t.totalBytes : completedCount;
            const hasFailures = resolved.status === "failed";
            return {
              ...t,
              status: resolved.status,
              error: resolved.error,
              endTime: Date.now(),
              totalBytes: finalTotal,
              transferredBytes: hasFailures ? completedCount : finalTotal,
              speed: 0,
            };
          });
        });
        activeChildIdsRef.current.delete(task.id);
        return appliedStatus;
      } catch (err) {
        activeChildIdsRef.current.delete(task.id);
        const isCancelled = cancelledTasksRef.current.has(task.id);
        // Clean up cancelled task tracking to prevent memory leak
        if (isCancelled) cancelledTasksRef.current.delete(task.id);
        const errMsg = err instanceof Error ? err.message : String(err);
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status: isCancelled ? ("cancelled" as TransferStatus) : ("failed" as TransferStatus),
                  error: isCancelled ? undefined : errMsg,
                  endTime: Date.now(),
                }
              : t,
          ),
        );
        return isCancelled ? "cancelled" : "failed";
      } finally {
        sourceWorkLease?.release();
        sourceWorkLease = null;
        const childIds = sftpTransferCenterStore.getSnapshot().tasks
          .filter((candidate) => candidate.parentTaskId === task.id)
          .map((candidate) => candidate.id);
        const relatedChildIds = settleTransferCancelTree(task.id, childIds);
        settleTransferControlEpochTree(task.id, relatedChildIds);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpSessionsRef, acquireTransferSession],
  );

  // Publish only on owner change / mount. Do NOT re-publish on every `transfers`
  // React state change: progress flushes use setTransfersState without
  // publishOwner, and a transfers→publishOwner effect reintroduced the full
  // store merge + emit on every tick (hidden retained SFTP panels still
  // remount useSftpTransfers after close).
  // Lifecycle writers already call setTransfers → publishOwner.
  useEffect(() => {
    sftpTransferCenterStore.publishOwner(ownerId, transfersRef.current);
  }, [ownerId]);

  // The store is the only transfer-task authority. Lifecycle changes update the
  // panel list; byte-only ticks update refs without repainting the whole panel.
  useEffect(() => {
    return sftpTransferCenterStore.subscribe(() => {
      const ownerRows = sftpTransferCenterStore.getSnapshot().tasks.filter((task) => task.ownerId === ownerId);
      transfersRef.current = ownerRows;
      setTransfersState(ownerRows);
    });
  }, [ownerId]);

  useEffect(() => sftpTransferCenterStore.subscribeProgress(() => {
    const liveById = new Map(sftpTransferCenterStore.getSnapshot().tasks.map((task) => [task.id, task]));
    transfersRef.current = transfersRef.current.map((task) => liveById.get(task.id) ?? task);
  }), []);

  const resolveAdoptionPanes = useCallback((task: TransferTask) => {
    const panes = [getActivePane("left"), getActivePane("right")].filter((pane): pane is SftpPane => !!pane?.connection);
    const sourcePane = panes.find((pane) => task.sourceHostId
      ? pane.connection?.hostId === task.sourceHostId
      : pane.connection?.isLocal);
    const targetPane = panes.find((pane) => task.targetHostId
      ? pane.connection?.hostId === task.targetHostId
      : pane.connection?.isLocal);
    // Downloads to local only need the remote source; local pane is optional for
    // matching but preferred so processTransfer can run dual-endpoint checks.
    if (sourcePane && targetPane) return { sourcePane, targetPane };
    if (sourcePane && task.sourceHostId && !task.targetHostId) {
      const localPane = panes.find((pane) => pane.connection?.isLocal);
      if (localPane) return { sourcePane, targetPane: localPane };
    }
    if (targetPane && task.targetHostId && !task.sourceHostId) {
      const localPane = panes.find((pane) => pane.connection?.isLocal);
      if (localPane) return { sourcePane: localPane, targetPane };
    }
    return null;
  }, [getActivePane]);

  const adoptInterruptedTransfer = useCallback(async (task: TransferTask) => {
    const panes = resolveAdoptionPanes(task);
    if (!panes?.sourcePane.connection || !panes.targetPane.connection) return;
    // Keep checkpoint / fingerprint fields so resume restarts from the saved byte offset.
    const hasConflict = !!task.conflict;
    const isDirectoryResume = !!task.isDirectory && !hasConflict;
    const adoptedTask: TransferTask = {
      ...task,
      ownerId,
      sourceConnectionId: panes.sourcePane.connection.id,
      targetConnectionId: panes.targetPane.connection.isLocal
        ? (task.targetConnectionId === "local" ? "local" : panes.targetPane.connection.id)
        : panes.targetPane.connection.id,
      // Conflict rows stay in attention until resolveConflict applies the action.
      // Other reconnects stay "pending" + reconnectRequired for the spinner.
      // Directory resume: skip re-prompting conflict when the target already
      // exists from the first attempt (merge/continue semantics).
      status: hasConflict ? "attention" : "pending",
      reconnectRequired: !hasConflict,
      error: hasConflict ? task.error : undefined,
      speed: 0,
      // Preserve replace/staging flags so resume keeps the original conflict
      // choice; only force skipConflict when continuing a directory resume.
      skipConflictCheck: isDirectoryResume ? true : task.skipConflictCheck,
      replaceExistingTarget: isDirectoryResume
        ? !!task.replaceExistingTarget
        : task.replaceExistingTarget,
      stagedTargetPath: task.stagedTargetPath,
    };
    // Re-home orphaned children under this parent so directory resume can skip
    // already-completed files using persisted checkpoints (same ownerId).
    const storeChildren = sftpTransferCenterStore.getSnapshot().tasks.filter(
      (candidate) => candidate.parentTaskId === task.id,
    );
    const rehomedChildren = storeChildren.map((child) => ({
      ...child,
      ownerId,
      status: (child.status === "completed" || child.status === "cancelled" || child.status === "failed")
        ? child.status
        : "interrupted" as TransferStatus,
      reconnectRequired: child.status !== "completed" && child.status !== "cancelled" && child.status !== "failed",
    }));
    const nextTransfers = [
      ...transfersRef.current.filter(
        (candidate) => candidate.id !== task.id && candidate.parentTaskId !== task.id,
      ),
      adoptedTask,
      ...rehomedChildren,
    ];
    setTransfers(nextTransfers);
    if (task.conflict) {
      // Keep conflictsRef in sync immediately — store.resolveConflict may call
      // controller.resolveConflict in the same turn before React re-renders.
      const nextConflicts = [
        ...conflictsRef.current.filter((item) => item.transferId !== task.id),
        task.conflict,
      ];
      conflictsRef.current = nextConflicts;
      setConflicts(nextConflicts);
      // Do not auto-resume — caller will apply the chosen conflict action.
      return;
    }
    // Cancel may have won while we were rehoming ownership.
    if (cancelledTasksRef.current.has(task.id)) return;
    // Force resumeTransfer to accept pending (reconnect path) statuses.
    await resumeTransfer(task.id);
  }, [ownerId, resolveAdoptionPanes, resumeTransfer, setTransfers]);

  const syncOwnedTasksFromStore = useCallback(() => {
    const snap = sftpTransferCenterStore.getSnapshot().tasks;
    setTransfers((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        const storeRow = snap.find((candidate) => candidate.id === row.id);
        if (!storeRow) return row;
        if (
          storeRow.status === row.status
          && storeRow.speed === row.speed
          && (storeRow.checkpointBytes ?? 0) === (row.checkpointBytes ?? 0)
          && (storeRow.transferredBytes ?? 0) === (row.transferredBytes ?? 0)
          && storeRow.pauseUnavailableReason === row.pauseUnavailableReason
          && storeRow.reconnectRequired === row.reconnectRequired
          && storeRow.error === row.error
          && storeRow.lifecycleEpoch === row.lifecycleEpoch
        ) {
          return row;
        }
        changed = true;
        return {
          ...row,
          status: storeRow.status,
          speed: storeRow.speed,
          checkpointBytes: storeRow.checkpointBytes,
          transferredBytes: storeRow.transferredBytes,
          pauseUnavailableReason: storeRow.pauseUnavailableReason,
          reconnectRequired: storeRow.reconnectRequired,
          error: storeRow.error,
          phase: storeRow.phase,
          resumeStage: storeRow.resumeStage,
          downloadCheckpointBytes: storeRow.downloadCheckpointBytes,
          uploadCheckpointBytes: storeRow.uploadCheckpointBytes,
          sourceFingerprint: storeRow.sourceFingerprint,
          lifecycleEpoch: storeRow.lifecycleEpoch,
        };
      });
      return changed ? next : prev;
    });
  }, [setTransfers]);

  useEffect(() => sftpTransferCenterStore.registerOwner(ownerId, {
    // Soft pause/resume: TransferRuntime (process-global). Owner registration is
    // view/sync + cancel/retry/adopt only — not control authority for live walks.
    pause: async (taskId: string) => {
      await transferRuntime.pause(taskId);
    },
    resume: async (taskId: string) => {
      // Use resumeTransfer so cancel latches are cleared before soft/hard resume.
      await resumeTransfer(taskId);
    },
    cancel: cancelTransfer,
    retry: retryTransfer,
    prioritize: prioritizeTransfer,
    dismiss: dismissTransfer,
    dismissMany: dismissTransfers,
    resolveConflict,
    // Origin/local listing only — soft pause/resume must not key on this.
    ownsTask: (taskId: string) => transfersRef.current.some(
      (row) => row.id === taskId || row.parentTaskId === taskId,
    ),
    syncOwnedTasks: syncOwnedTasksFromStore,
    canAdopt: (task) => resolveAdoptionPanes(task) !== null,
    canPrepareAdoption,
    adopt: adoptInterruptedTransfer,
  }), [adoptInterruptedTransfer, canPrepareAdoption, cancelTransfer, dismissTransfer, dismissTransfers, ownerId, prioritizeTransfer, resolveAdoptionPanes, resolveConflict, resumeTransfer, retryTransfer, syncOwnedTasksFromStore]);

  return {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    downloadToLocal,
    cancelTransfer,
    // Single process-level control surface (TransferRuntime).
    pauseTransfer: async (transferId: string) => {
      await transferRuntime.pause(transferId);
    },
    resumeTransfer,
    prioritizeTransfer,
    isTransferCancelled,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
  };
};
