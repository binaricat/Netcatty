/**
 * Process-global soft pause/resume for SFTP transfers.
 *
 * Single control plane: not tied to SFTP panel / terminal-tab React owners.
 * The transfer center store always uses this for live soft-control; walks
 * listen to process-global pause latches (transferPauseLatch) regardless of
 * which UI started the job.
 */

import type { TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";
import {
  allPauseResultsDeadTransfer,
  isBenignPauseMiss,
  planPartialPauseRollback,
} from "./pauseTransferOutcome";
import {
  bumpTransferControlEpoch,
  isTransferControlEpochCurrent,
} from "./transferControlEpoch";
import {
  isTransferOrRootPauseLatched,
  latchTransferPauseTree,
  releaseTransferPauseTree,
} from "./transferPauseLatch";
import { isTransferWalkInFlight } from "./transferWalkRegistry";

export type TransferControlBridge = {
  pauseTransfer?: (id: string) => Promise<{
    success: boolean;
    /** A newer control in another window owns the authoritative state. */
    superseded?: boolean;
    supersededBy?: "pause" | "resume" | "cancel";
    reason?: string;
    checkpointBytes?: number;
    resumeStage?: TransferTask["resumeStage"];
    downloadCheckpointBytes?: number;
    uploadCheckpointBytes?: number;
    sourceFingerprint?: string;
    /** Main-process stream lifecycle epoch (must not mix with control-plane epochs). */
    lifecycleEpoch?: number;
  }>;
  resumeTransfer?: (id: string) => Promise<{
    success: boolean;
    /** A newer control in another window owns the authoritative state. */
    superseded?: boolean;
    supersededBy?: "pause" | "resume" | "cancel";
    reason?: string;
    lifecycleEpoch?: number;
  }>;
  cancelTransfer?: (id: string) => Promise<unknown>;
};

function wasSuperseded(result: { success?: boolean; superseded?: boolean } | undefined | null): boolean {
  return result?.superseded === true;
}

type SupersededControlResult = {
  success?: boolean;
  superseded?: boolean;
  supersededBy?: "pause" | "resume" | "cancel";
};

export function reconcileSupersededControls(
  host: TransferControlHost,
  taskId: string,
  childIds: string[],
  backendIds: string[],
  results: ReadonlyArray<SupersededControlResult | undefined>,
  epoch: number,
  requestedAction: "pause" | "resume",
  controlTaskId = taskId,
): void {
  if (!isTransferControlEpochCurrent(controlTaskId, epoch)) return;
  const task = host.getTasks().find((candidate) => candidate.id === taskId);
  if (!task || ["completed", "cancelled", "failed"].includes(task.status)) return;
  const apply = (id: string, descendants: string[], action: "pause" | "resume" | "cancel") => {
    if (action === "resume") releaseTransferPauseTree(id, descendants);
    else latchTransferPauseTree(id, descendants);
    for (const affectedId of [id, ...descendants]) {
      try {
        if (action === "resume") globalSftpTransferScheduler.resume(affectedId);
        else globalSftpTransferScheduler.pause(affectedId);
      } catch { /* best-effort */ }
    }
  };
  const decisions = results.map((result) => result?.superseded
    ? result.supersededBy
    : result?.success ? requestedAction : undefined);
  // A child-only resume does not establish a folder-wide decision. Require all
  // relevant children to agree, or an already-authoritative resumed root row.
  if (decisions.length > 0 && decisions.every((action) => action === "resume")) {
    apply(taskId, childIds, "resume");
    host.setTasks(host.getTasks().map((row) => row.id === taskId ? { ...row, status: "transferring" } : row));
  } else if (decisions.length > 0 && decisions.every((action) => action === "pause")) {
    apply(taskId, childIds, "pause");
    host.setTasks(host.getTasks().map((row) => row.id === taskId ? { ...row, status: "paused" } : row));
  } else if (task.status === "transferring" && decisions.includes("resume")) {
    apply(taskId, [], "resume");
  }
  decisions.forEach((action, index) => {
    if (action) apply(backendIds[index], [], action);
  });
}

/** Prefer the highest bridge lifecycleEpoch from successful pause/resume results. */
function maxBridgeLifecycleEpoch(
  results: ReadonlyArray<{ success?: boolean; lifecycleEpoch?: number } | undefined | null>,
): number | undefined {
  let max: number | undefined;
  for (const result of results) {
    if (!result?.success) continue;
    const epoch = result.lifecycleEpoch;
    if (!Number.isFinite(epoch)) continue;
    const value = epoch as number;
    max = max === undefined ? value : Math.max(max, value);
  }
  return max;
}

export type TransferControlHost = {
  getTasks: () => TransferTask[];
  setTasks: (next: TransferTask[]) => void;
  getBridge: () => TransferControlBridge | undefined;
};

function unfinishedChildren(tasks: readonly TransferTask[], taskId: string): string[] {
  return tasks
    .filter((candidate) => candidate.parentTaskId === taskId
      && !["completed", "cancelled", "failed"].includes(candidate.status))
    .map((candidate) => candidate.id);
}

function paintTreeStatus(
  tasks: readonly TransferTask[],
  taskId: string,
  status: TransferTask["status"],
  extras?: Partial<TransferTask>,
  /**
   * Bridge-aligned lifecycle epoch to stamp, or `null` to clear a stale store
   * epoch so main-process progress is not dropped after soft resume.
   * Omit to leave existing task.lifecycleEpoch unchanged.
   */
  lifecycleEpoch?: number | null,
): TransferTask[] {
  return tasks.map((candidate) => {
    if (candidate.id !== taskId && candidate.parentTaskId !== taskId) return candidate;
    if (["completed", "cancelled", "failed"].includes(candidate.status)) return candidate;
    const epochPatch = lifecycleEpoch === undefined
      ? null
      : { lifecycleEpoch: lifecycleEpoch === null ? undefined : lifecycleEpoch };
    return {
      ...candidate,
      status,
      speed: 0,
      phase: undefined,
      ...epochPatch,
      ...(candidate.id === taskId ? extras : null),
    };
  });
}

/** Soft-pause a live transfer (folder or file). UI-independent. */
export async function softPauseTransfer(
  host: TransferControlHost,
  taskId: string,
): Promise<"paused" | "pausing" | "interrupted" | "noop"> {
  const tasks = host.getTasks();
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task || ["completed", "cancelled"].includes(task.status)) return "noop";
  if (task.ownerId === "dedicated-resume" && task.reconnectRequired) return "noop";

  const childIds = unfinishedChildren(tasks, taskId);
  const treeIds = task.isDirectory
    ? childIds
    : [taskId, ...childIds.filter((id) => id !== taskId)];
  // Control-plane epoch supersedes in-flight soft-drain only. Do NOT stamp it as
  // task.lifecycleEpoch — that field tracks main-process bridge epochs for ingest.
  const pauseEpoch = bumpTransferControlEpoch(taskId);
  latchTransferPauseTree(taskId, childIds);
  for (const id of [taskId, ...childIds]) {
    try { globalSftpTransferScheduler.pause(id); } catch { /* best-effort */ }
  }

  const immediateStatus = task.isDirectory ? "paused" as const : "pausing" as const;
  // Freeze via latch/status; leave lifecycleEpoch alone until bridge responds.
  host.setTasks(paintTreeStatus(
    host.getTasks(),
    taskId,
    immediateStatus,
    task.isDirectory
      ? { checkpointBytes: task.transferredBytes, pauseUnavailableReason: undefined }
      : { pauseUnavailableReason: undefined },
  ));

  let bridge: TransferControlBridge | undefined;
  try { bridge = host.getBridge(); } catch { bridge = undefined; }

  if (!bridge?.pauseTransfer) {
    if (isTransferWalkInFlight(taskId) || task.isDirectory) {
      host.setTasks(paintTreeStatus(host.getTasks(), taskId, "paused", {
        checkpointBytes: task.isDirectory ? task.transferredBytes : undefined,
        pauseUnavailableReason: undefined,
      }));
      return "paused";
    }
    // Dead row after restart — demote so UI can reconnect.
    for (const id of [taskId, ...childIds]) {
      try { await bridge?.cancelTransfer?.(id); } catch { /* best-effort */ }
    }
    host.setTasks(host.getTasks().map((candidate) => (
      candidate.id === taskId || candidate.parentTaskId === taskId
        ? {
          ...candidate,
          status: (["completed", "cancelled"].includes(candidate.status)
            ? candidate.status
            : "interrupted") as TransferTask["status"],
          speed: 0,
          phase: undefined,
          reconnectRequired: true,
          error: candidate.id === taskId
            ? (candidate.error ?? "Transfer was interrupted. Resume to continue.")
            : candidate.error,
        }
        : candidate
    )));
    return "interrupted";
  }

  const backendIds = treeIds.length > 0 ? treeIds : [taskId];
  // An obsolete pause can be superseded by another pause or cancellation,
  // not only by resume. Compensate only while the tree still wants to run.
  const undoObsoletePause = async (id: string) => {
    const live = host.getTasks().find((candidate) => candidate.id === taskId);
    if (!live || ["completed", "cancelled", "failed", "interrupted"].includes(live.status)) return;
    if (isTransferOrRootPauseLatched(taskId, id)) return;
    try { await bridge!.resumeTransfer?.(id); } catch { /* best-effort */ }
  };
  const pauseOne = async (id: string) => {
    let result = await bridge!.pauseTransfer?.(id)
      ?? { success: false, reason: "Pause unavailable" };
    const maxAttempts = task.isDirectory ? 4 : 16;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (wasSuperseded(result)) return result;
      if (!isTransferControlEpochCurrent(taskId, pauseEpoch)) {
        if (result.success) {
          await undoObsoletePause(id);
        }
        return { success: false, reason: "Pause superseded by resume" };
      }
      if (result.success || isBenignPauseMiss(result.reason)) return result;
      if (!/cannot be paused yet|Could not verify the saved transfer checkpoint/i.test(result.reason || "")) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!isTransferControlEpochCurrent(taskId, pauseEpoch)) {
        return { success: false, reason: "Pause superseded by newer control" };
      }
      result = await bridge!.pauseTransfer?.(id)
        ?? { success: false, reason: "Pause unavailable" };
    }
    return result;
  };

  if (task.isDirectory) {
    void (async () => {
      const pauseStillCurrent = () => isTransferControlEpochCurrent(taskId, pauseEpoch);
      const pauseResults = await Promise.all(backendIds.map(async (id) => {
        if (!pauseStillCurrent()) {
          return { id, result: { success: false, reason: "Pause superseded by resume" } };
        }
        const result = await pauseOne(id);
        if (wasSuperseded(result)) return { id, result };
        const live = host.getTasks().find((candidate) => candidate.id === taskId);
        const userResumed = !pauseStillCurrent()
          || !live
          || (live.status !== "paused" && live.status !== "pausing");
        if (userResumed) {
          await undoObsoletePause(id);
          return { id, result: { success: false, reason: "Pause superseded by resume" } };
        }
        return { id, result };
      }));
      if (!pauseStillCurrent()) return;
      if (pauseResults.some(({ result }) => wasSuperseded(result))) {
        reconcileSupersededControls(host, taskId, childIds, backendIds, pauseResults.map(({ result }) => result), pauseEpoch, "pause");
        return;
      }
      const after = host.getTasks().find((candidate) => candidate.id === taskId);
      if (!after || after.status === "cancelled") return;
      if (after.status !== "paused" && after.status !== "pausing") return;
      const byId = new Map(pauseResults.map((row) => [row.id, row.result]));
      const bridgeEpoch = maxBridgeLifecycleEpoch(pauseResults.map((row) => row.result));
      // Final directory paint: parent + unfinished children all go paused (do not
      // leave children stuck on transferring under a paused parent).
      host.setTasks(host.getTasks().map((candidate) => {
        if (candidate.id === taskId) {
          return {
            ...candidate,
            status: "paused" as const,
            speed: 0,
            checkpointBytes: candidate.transferredBytes,
            pauseUnavailableReason: undefined,
            phase: undefined,
            // Bridge epoch only — control-plane pauseEpoch must not poison ingest.
            ...(bridgeEpoch !== undefined ? { lifecycleEpoch: bridgeEpoch } : null),
          };
        }
        if (candidate.parentTaskId !== taskId && !backendIds.includes(candidate.id)) return candidate;
        if (["completed", "cancelled", "failed"].includes(candidate.status)) return candidate;
        const result = byId.get(candidate.id);
        const childEpoch = Number.isFinite(result?.lifecycleEpoch)
          ? (result!.lifecycleEpoch as number)
          : bridgeEpoch;
        return {
          ...candidate,
          status: "paused" as const,
          speed: 0,
          checkpointBytes: result?.checkpointBytes ?? candidate.checkpointBytes ?? candidate.transferredBytes,
          resumeStage: result?.resumeStage ?? candidate.resumeStage,
          downloadCheckpointBytes: result?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
          uploadCheckpointBytes: result?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
          sourceFingerprint: result?.sourceFingerprint ?? candidate.sourceFingerprint,
          pauseUnavailableReason: undefined,
          ...(childEpoch !== undefined ? { lifecycleEpoch: childEpoch } : null),
        };
      }));
    })().catch(() => { /* best-effort */ });
    return "paused";
  }

  // Single-file: await soft-drain with supersede guards.
  const pauseResults = await Promise.all(backendIds.map(async (id) => ({
    id,
    result: await pauseOne(id),
  })));
  if (pauseResults.some(({ result }) => wasSuperseded(result))) {
    reconcileSupersededControls(host, taskId, childIds, backendIds, pauseResults.map(({ result }) => result), pauseEpoch, "pause");
    return "noop";
  }
  const afterLivePause = host.getTasks().find((candidate) => candidate.id === taskId);
  if (afterLivePause?.status === "cancelled") {
    releaseTransferPauseTree(taskId, childIds);
    return "noop";
  }
  const pauseStillCurrent = isTransferControlEpochCurrent(taskId, pauseEpoch);
  const userAlreadyResumed = !pauseStillCurrent
    || !afterLivePause
    || (afterLivePause.status !== "pausing" && afterLivePause.status !== "paused");
  if (userAlreadyResumed) {
    for (const { id, result } of pauseResults) {
      if (result?.success) {
        await undoObsoletePause(id);
      }
    }
    return "noop";
  }
  const bridgePauseResults = pauseResults.map((row) => row.result);
  const allBenignOrSuccess = backendIds.length === 0 || pauseResults.every(
    ({ result }) => result.success || isBenignPauseMiss(result.reason),
  );
  if (allBenignOrSuccess) {
    if (!isTransferControlEpochCurrent(taskId, pauseEpoch)) {
      for (const { id, result } of pauseResults) {
        if (result?.success) {
          await undoObsoletePause(id);
        }
      }
      return "noop";
    }
    // Dead stream painted as "paused" made Resume soft-fail and fall into
    // dedicated vault reconnect — which cannot resolve quick-connect hosts.
    if (allPauseResultsDeadTransfer(bridgePauseResults)) {
      releaseTransferPauseTree(taskId, childIds);
      for (const id of [taskId, ...childIds]) {
        try { globalSftpTransferScheduler.resume(id); } catch { /* best-effort */ }
      }
      const deadReason = pauseResults.find(({ result }) => result?.reason)?.result?.reason
        ?? "Transfer is no longer active";
      host.setTasks(host.getTasks().map((candidate) => (
        candidate.id === taskId || candidate.parentTaskId === taskId
          ? {
            ...candidate,
            status: (["completed", "cancelled"].includes(candidate.status)
              ? candidate.status
              : "interrupted") as TransferTask["status"],
            speed: 0,
            phase: undefined,
            reconnectRequired: true,
            error: candidate.id === taskId
              ? (candidate.error ?? `${deadReason}. Resume will reconnect.`)
              : candidate.error,
          }
          : candidate
      )));
      return "interrupted";
    }
    const byId = new Map(pauseResults.map((row) => [row.id, row.result]));
    const bridgeEpoch = maxBridgeLifecycleEpoch(pauseResults.map((row) => row.result));
    host.setTasks(host.getTasks().map((candidate) => {
      if (candidate.id === taskId) {
        if (candidate.status !== "pausing" && candidate.status !== "paused") return candidate;
        return {
          ...candidate,
          status: "paused" as const,
          speed: 0,
          checkpointBytes: byId.get(taskId)?.checkpointBytes ?? candidate.checkpointBytes,
          resumeStage: byId.get(taskId)?.resumeStage ?? candidate.resumeStage,
          downloadCheckpointBytes: byId.get(taskId)?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
          uploadCheckpointBytes: byId.get(taskId)?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
          sourceFingerprint: byId.get(taskId)?.sourceFingerprint ?? candidate.sourceFingerprint,
          pauseUnavailableReason: undefined,
          ...(bridgeEpoch !== undefined ? { lifecycleEpoch: bridgeEpoch } : null),
        };
      }
      if (candidate.parentTaskId !== taskId && !backendIds.includes(candidate.id)) return candidate;
      if (["completed", "cancelled", "failed"].includes(candidate.status)) return candidate;
      const result = byId.get(candidate.id);
      const childEpoch = Number.isFinite(result?.lifecycleEpoch)
        ? (result!.lifecycleEpoch as number)
        : bridgeEpoch;
      return {
        ...candidate,
        status: "paused" as const,
        speed: 0,
        checkpointBytes: result?.checkpointBytes ?? candidate.checkpointBytes ?? candidate.transferredBytes,
        resumeStage: result?.resumeStage ?? candidate.resumeStage,
        downloadCheckpointBytes: result?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
        uploadCheckpointBytes: result?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
        sourceFingerprint: result?.sourceFingerprint ?? candidate.sourceFingerprint,
        pauseUnavailableReason: undefined,
        ...(childEpoch !== undefined ? { lifecycleEpoch: childEpoch } : null),
      };
    }));
    return "paused";
  }

  if (!isTransferControlEpochCurrent(taskId, pauseEpoch)) return "noop";
  releaseTransferPauseTree(taskId, childIds);
  for (const id of [taskId, ...childIds]) {
    try { globalSftpTransferScheduler.resume(id); } catch { /* best-effort */ }
  }
  const rollback = planPartialPauseRollback({
    activeIds: backendIds,
    backendIds,
    bridgeResults: pauseResults.map((row) => row.result),
  });
  for (const id of rollback.bridgeIdsToResume) {
    await undoObsoletePause(id);
  }
  if (!isTransferControlEpochCurrent(taskId, pauseEpoch)) return "noop";
  const hard = pauseResults.find(({ result }) =>
    result && !result.success && !isBenignPauseMiss(result.reason),
  )?.result;
  host.setTasks(host.getTasks().map((candidate) => {
    if (candidate.id !== taskId && !backendIds.includes(candidate.id)) return candidate;
    if (candidate.status !== "pausing" && candidate.status !== "paused" && candidate.id !== taskId) {
      return candidate;
    }
    return {
      ...candidate,
      status: "transferring" as const,
      pauseUnavailableReason: candidate.id === taskId
        ? (hard?.reason ?? candidate.pauseUnavailableReason)
        : candidate.pauseUnavailableReason,
    };
  }));
  return "noop";
}

export type SoftResumeResult = {
  /** True when soft-resume rejoined without dedicated hard reconnect. */
  handled: boolean;
  /** Bridge miss reason when handled is false (drives demotion policy). */
  reason?: string;
};

/**
 * Soft-resume a live transfer.
 *
 * Single-file: requires at least one successful bridge resume (walkAlive alone is
 * not enough — a paused/dead stream with a live walk would paint transferring and
 * skip hard reconnect). Directory: walkAlive may rejoin after unlatch without
 * per-child bridge success.
 *
 * task.lifecycleEpoch follows bridge epochs only (never control-plane bumps), so
 * main-process progress ingest is not stale-dropped after soft pause/resume.
 * Soft-resume must stamp a real bridge epoch (or keep the previous one) — never
 * clear to `undefined`, or a late pause event re-applies "paused".
 */
export async function softResumeTransfer(
  host: TransferControlHost,
  taskId: string,
): Promise<SoftResumeResult> {
  const tasks = host.getTasks();
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { handled: false, reason: "Transfer not found" };

  const childIds = unfinishedChildren(tasks, taskId);
  // Always release the full tree known to the store so orphaned child latches
  // (panel closed mid-folder) cannot leave the walk stuck after resume.
  const knownChildIds = tasks
    .filter((candidate) => candidate.parentTaskId === taskId)
    .map((candidate) => candidate.id);
  const releaseIds = [...new Set([...childIds, ...knownChildIds])];
  const treeIds = task.isDirectory
    ? childIds
    : [taskId, ...childIds.filter((id) => id !== taskId)];

  // Supersede in-flight soft-drain / pauseWatch only — not a bridge lifecycle stamp.
  const resumeEpoch = bumpTransferControlEpoch(taskId);
  releaseTransferPauseTree(taskId, releaseIds);
  for (const id of [taskId, ...releaseIds]) {
    try { globalSftpTransferScheduler.resume(id); } catch { /* best-effort */ }
  }

  let bridge: TransferControlBridge | undefined;
  try { bridge = host.getBridge(); } catch { bridge = undefined; }

  const resumeIds = treeIds.length > 0 ? treeIds : [taskId];
  const failedIds = new Set<string>();
  const results = await Promise.all(resumeIds.map(async (id) => {
    try {
      return await bridge?.resumeTransfer?.(id) ?? { success: false, reason: "Resume unavailable" };
    } catch (error) {
      // Rejections must pass the same stale-control check as ordinary failures.
      failedIds.add(id);
      return { success: false, reason: error instanceof Error && error.message ? error.message : "Resume request failed" };
    }
  }));
  const after = host.getTasks().find((candidate) => candidate.id === taskId);
  if (!isTransferControlEpochCurrent(taskId, resumeEpoch)) return { handled: true };
  if (!after || ["completed", "cancelled", "failed"].includes(after.status)) return { handled: true };

  results.forEach((result, index) => {
    // A missing stream can belong to queued directory work. Verification and
    // other explicit failures still own a paused stream and must remain held.
    const benignMiss = /^(?:Transfer is no longer active|not active|Resume unavailable)$/i.test(result.reason || "");
    if (!result.success && !result.superseded && !benignMiss) failedIds.add(resumeIds[index]);
  });
  if (results.some(wasSuperseded)) {
    reconcileSupersededControls(host, taskId, releaseIds, resumeIds, results, resumeEpoch, "resume");
  }
  const successIds = resumeIds.filter((_, index) => results[index]?.success);
  const effectiveRunning = results.some((result) => result?.success || (result?.superseded && result.supersededBy === "resume"));
  const failedIndex = resumeIds.findIndex((id) => failedIds.has(id));
  const failureReason = failedIndex >= 0 ? results[failedIndex]?.reason || "Resume request failed" : undefined;
  if (failedIds.size > 0) {
    // A partial resume stays visibly active; hold only failed children. Do not
    // hide successfully running streams behind a paused root barrier.
    const heldIds = effectiveRunning ? [...failedIds] : [taskId, ...failedIds];
    for (const id of heldIds) {
      latchTransferPauseTree(id, []);
      try { globalSftpTransferScheduler.pause(id); } catch { /* best-effort */ }
    }
    if (!effectiveRunning) return { handled: false, reason: failureReason };
  }
  if (results.some(wasSuperseded) && failedIds.size === 0) {
    return { handled: true };
  }
  const walkAlive = isTransferWalkInFlight(taskId);
  // Directory walk can continue after unlatch without bridge resume on every child.
  // Single-file must not claim success when every bridge resume fails (stuck bar).
  if (!effectiveRunning) {
    if (task.isDirectory && walkAlive) {
      host.setTasks(paintTreeStatus(
        host.getTasks(),
        taskId,
        "transferring",
        { error: undefined, reconnectRequired: false, pauseUnavailableReason: undefined },
        // Clear any control-plane / stale pause epoch so child stream progress is accepted.
        null,
      ));
      return { handled: true };
    }
    const reason = results.find((row) => row?.reason)?.reason
      ?? "Transfer is no longer active";
    return { handled: false, reason };
  }

  const resumed = new Set(successIds);
  const bridgeEpochById = new Map<string, number>();
  for (let index = 0; index < resumeIds.length; index += 1) {
    const result = results[index];
    if (!result?.success) continue;
    const epoch = result.lifecycleEpoch;
    if (Number.isFinite(epoch)) bridgeEpochById.set(resumeIds[index]!, epoch as number);
  }
  const parentBridgeEpoch = maxBridgeLifecycleEpoch(results);
  host.setTasks(host.getTasks().map((candidate) => {
    if (
      candidate.id !== taskId
      && !resumed.has(candidate.id)
      && candidate.parentTaskId !== taskId
    ) {
      return candidate;
    }
    if (["completed", "cancelled", "failed"].includes(candidate.status)) return candidate;
    if (
      candidate.id !== taskId
      && !resumed.has(candidate.id)
      && !["paused", "pausing", "queued", "pending", "transferring"].includes(candidate.status)
    ) {
      return candidate;
    }

    if (failedIds.has(candidate.id)) {
      return { ...candidate, status: "paused" as const, speed: 0, error: failureReason };
    }
    const candidateResult = results[resumeIds.indexOf(candidate.id)];
    if (candidate.id !== taskId && candidateResult?.superseded) return candidate;

    // Parent: transferring. Prefer bridge epoch; never wipe to undefined or a
    // late pause fanout re-applies "paused" (acceptsLifecycle treats missing as any).
    if (candidate.id === taskId) {
      const nextEpoch = parentBridgeEpoch !== undefined
        ? parentBridgeEpoch
        : (Number.isFinite(candidate.lifecycleEpoch)
          ? Math.max(0, candidate.lifecycleEpoch as number) + 1
          : 1);
      return {
        ...candidate,
        status: "transferring" as const,
        error: failureReason,
        reconnectRequired: false,
        pauseUnavailableReason: undefined,
        phase: undefined,
        speed: 0,
        lifecycleEpoch: nextEpoch,
      };
    }

    // Bridge-resumed children only: use their own stream epoch when present.
    if (resumed.has(candidate.id)) {
      const childEpoch = bridgeEpochById.get(candidate.id);
      const nextEpoch = childEpoch !== undefined
        ? childEpoch
        : (Number.isFinite(candidate.lifecycleEpoch)
          ? Math.max(0, candidate.lifecycleEpoch as number) + 1
          : 1);
      return {
        ...candidate,
        status: "transferring" as const,
        error: undefined,
        reconnectRequired: false,
        pauseUnavailableReason: undefined,
        phase: undefined,
        speed: 0,
        lifecycleEpoch: nextEpoch,
      };
    }

    // Non-resumed siblings under the folder (queued/pending/later files): keep
    // queue status and CLEAR lifecycleEpoch. Stamping the parent's resume epoch
    // here poisons startStreamTransfer children that arm at bridge epoch 0.
    const nextStatus = (
      candidate.status === "queued" || candidate.status === "pending"
    )
      ? candidate.status
      : "transferring" as const;
    return {
      ...candidate,
      status: nextStatus,
      error: undefined,
      reconnectRequired: false,
      pauseUnavailableReason: undefined,
      phase: undefined,
      speed: 0,
      lifecycleEpoch: undefined,
    };
  }));
  return { handled: true };
}

/** Default bridge accessor for Electron / tests with window.netcatty. */
export function defaultTransferControlBridge(): TransferControlBridge | undefined {
  try {
    return netcattyBridge.get() as TransferControlBridge | undefined;
  } catch {
    return undefined;
  }
}
