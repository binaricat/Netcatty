import type { TransferTask } from "./models";
import {
  compareDirectoryTraversalPaths,
  createDirectoryManifestAccumulator,
  createDirectoryEntryIdentity,
  createEmptyDirectoryResumeCheckpoint,
  isValidDirectoryResumeCheckpoint,
} from "./sftpDirectoryCheckpoint";

export const SFTP_TRANSFER_CENTER_VERSION = 1;
export const SFTP_TRANSFER_HISTORY_MAX = 200;
export const SFTP_TRANSFER_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set<TransferTask["status"]>(["completed", "failed", "cancelled"]);
const RUNNING_STATUSES = new Set<TransferTask["status"]>(["transferring", "pausing"]);
// After an app restart no backend streams/sessions remain. Any non-terminal
// in-flight status must become a manual-resume "interrupted" task — including
// paused work, which also loses its live transfer handle on quit.
const RESTORED_INTERRUPTED_STATUSES = new Set<TransferTask["status"]>([
  "pending",
  "queued",
  "transferring",
  "pausing",
  "paused",
]);

export interface PersistedSftpTransferCenter {
  version: typeof SFTP_TRANSFER_CENTER_VERSION;
  tasks: TransferTask[];
}

const SAFE_TASK_KEYS: ReadonlySet<keyof TransferTask> = new Set([
  "id", "batchId", "fileName", "originalFileName", "sourcePath", "targetPath",
  "sourceConnectionId", "targetConnectionId", "targetHostId", "targetConnectionKey",
  "direction", "status", "totalBytes", "transferredBytes", "speed", "error",
  "startTime", "endTime", "isDirectory", "progressMode", "childTasks", "parentTaskId",
  "sourceLastModified", "skipConflictCheck", "replaceExistingTarget", "retryable",
  "ownerId", "sourceHostId", "sourceHostLabel", "targetHostLabel", "origin", "background",
  "phase", "controlKind", "resumable", "checkpointBytes", "priority", "updatedAt", "pauseUnavailableReason",
  "resumeStage", "downloadCheckpointBytes", "uploadCheckpointBytes",
  "conflict",
  "stagedTargetPath",
  "sourceFingerprint",
  "reconnectRequired",
  "lifecycleEpoch",
  "directoryEntryIndex",
  "directoryEntryIdentity",
  "directoryResumeCheckpoint",
  "expectedLocalTarget",
  "requireOriginalSourceForResume",
]);

export function sanitizeSftpTransferTask(value: unknown): TransferTask | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.fileName !== "string") return null;
  if (typeof source.sourcePath !== "string" || typeof source.targetPath !== "string") return null;
  const sanitized: Record<string, unknown> = {};
  for (const key of SAFE_TASK_KEYS) {
    if (source[key] !== undefined) sanitized[key] = source[key];
  }
  const task = sanitized as unknown as TransferTask;
  if (source.expectedLocalTarget !== undefined) {
    const expected = source.expectedLocalTarget as Record<string, unknown> | null;
    if (!expected || typeof expected.parentRealPath !== "string" || !expected.parentRealPath
      || typeof expected.parentIdentity !== "string" || !/^\d+:\d+$/.test(expected.parentIdentity)
      || typeof expected.parentBirthtimeNs !== "string" || !/^[1-9]\d*$/.test(expected.parentBirthtimeNs)
      || typeof expected.targetIdentity !== "string" || !/^\d+:\d+$/.test(expected.targetIdentity)
      || typeof expected.targetBirthtimeNs !== "string" || !/^[1-9]\d*$/.test(expected.targetBirthtimeNs)
      || typeof expected.targetCtimeNs !== "string" || !/^[1-9]\d*$/.test(expected.targetCtimeNs)
      || typeof expected.targetMtimeNs !== "string" || !/^[1-9]\d*$/.test(expected.targetMtimeNs)) {
      // An incomplete saved guard must never become an unguarded overwrite.
      task.expectedLocalTarget = {
        parentRealPath: "", parentIdentity: "", parentBirthtimeNs: "",
        targetIdentity: "", targetBirthtimeNs: "", targetCtimeNs: "", targetMtimeNs: "",
      };
    } else {
      task.expectedLocalTarget = {
        parentRealPath: expected.parentRealPath,
        parentIdentity: expected.parentIdentity,
        parentBirthtimeNs: expected.parentBirthtimeNs,
        targetIdentity: expected.targetIdentity,
        targetBirthtimeNs: expected.targetBirthtimeNs,
        targetCtimeNs: expected.targetCtimeNs,
        targetMtimeNs: expected.targetMtimeNs,
      };
    }
  }
  if (task.expectedLocalTarget) task.requireOriginalSourceForResume = true;
  if (!Number.isSafeInteger(task.directoryEntryIndex) || (task.directoryEntryIndex ?? -1) < 0) {
    task.directoryEntryIndex = undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(task.directoryEntryIdentity ?? "")) {
    task.directoryEntryIdentity = undefined;
  }
  if (!isValidDirectoryResumeCheckpoint(task.directoryResumeCheckpoint)) {
    task.directoryResumeCheckpoint = undefined;
  } else {
    const checkpoint = task.directoryResumeCheckpoint;
    // Rebuild the fixed schema so unknown/legacy payload fields cannot smuggle
    // an unbounded path list back into localStorage.
    task.directoryResumeCheckpoint = {
      version: checkpoint.version,
      coveredEntries: checkpoint.coveredEntries,
      completedEntries: checkpoint.completedEntries,
      manifestHash: checkpoint.manifestHash,
    };
  }
  // After force-quit / restart no backend stream remains. Every unfinished row
  // (including a previously interrupted row that was already persisted) needs a
  // dedicated reconnect — do not leave reconnectRequired false.
  if (RESTORED_INTERRUPTED_STATUSES.has(task.status) || task.status === "interrupted") {
    task.status = "interrupted";
    task.speed = 0;
    task.reconnectRequired = true;
    // Phase labels like "transferring" would otherwise still render as "传输中"
    // even though the task is dead after restart.
    task.phase = undefined;
    task.error = task.error || undefined;
    // Stale lifecycle epochs from a previous process must not block first
    // progress after dedicated reconnect.
    task.lifecycleEpoch = undefined;
  }
  // Terminal rows must not keep conflict payloads. Older Skip paths cancelled the
  // task without clearing conflict, so SFTP remount reopened the conflict dialog
  // while the transfer center looked empty (no attention bucket row).
  if (TERMINAL_STATUSES.has(task.status) && task.conflict) {
    task.conflict = undefined;
  }
  return task;
}

export function serializeSftpTransferCenter(tasks: readonly TransferTask[]): string {
  return JSON.stringify({
    version: SFTP_TRANSFER_CENTER_VERSION,
    tasks: tasks.map((task) => sanitizeSftpTransferTask(task)).filter((task): task is TransferTask => task !== null),
  } satisfies PersistedSftpTransferCenter);
}

export function deserializeSftpTransferCenter(raw: string | null | undefined): PersistedSftpTransferCenter {
  if (!raw) return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; tasks?: unknown };
    if (parsed.version !== SFTP_TRANSFER_CENTER_VERSION || !Array.isArray(parsed.tasks)) {
      return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
    }
    return {
      version: SFTP_TRANSFER_CENTER_VERSION,
      tasks: parsed.tasks.map(sanitizeSftpTransferTask).filter((task): task is TransferTask => task !== null),
    };
  } catch {
    return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
  }
}

export function pruneSftpTransferHistory(
  tasks: readonly TransferTask[],
  now = Date.now(),
): TransferTask[] {
  // A failed terminal directory can have more retained failed children than
  // the global history cap. Once those rows are evicted, a compact checkpoint
  // cannot distinguish them from completed children. Drop the ambiguous skip
  // state so Retry/Resume safely walks every source entry again.
  let compacted = tasks.map((task) => (
    task.isDirectory
    && !task.parentTaskId
    && task.status === "failed"
    && task.directoryResumeCheckpoint
      ? { ...task, directoryResumeCheckpoint: undefined }
      : task
  ));
  const unfinishedDirectoryParents = compacted.filter((task) => (
    task.isDirectory
    && !task.parentTaskId
    && !TERMINAL_STATUSES.has(task.status)
  ));
  const childrenByParent = new Map<string, TransferTask[]>();
  for (const task of compacted) {
    if (!task.parentTaskId) continue;
    const children = childrenByParent.get(task.parentTaskId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentTaskId, children);
  }
  const compactedChildIds = new Set<string>();
  const parentUpdates = new Map<string, TransferTask>();
  const normalizedChildUpdates = new Map<string, TransferTask>();
  for (const parent of unfinishedDirectoryParents) {
    let parentChildren = childrenByParent.get(parent.id) ?? [];
    // Upgrade pre-checkpoint history safely. The sorted known set becomes a
    // candidate prefix; dedicated resume validates it against a fresh walk.
    // Any added/reordered/modified source entry invalidates the hash and causes
    // a conservative restart instead of an incorrect skip.
    if (
      !isValidDirectoryResumeCheckpoint(parent.directoryResumeCheckpoint)
      && parentChildren.some((child) => (
        !Number.isSafeInteger(child.directoryEntryIndex)
        || !/^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")
      ))
    ) {
      parentChildren = [...parentChildren]
        .sort((left, right) => compareDirectoryTraversalPaths(left.sourcePath, right.sourcePath))
        .map((child, directoryEntryIndex) => ({
          ...child,
          directoryEntryIndex,
          directoryEntryIdentity: createDirectoryEntryIdentity({
            sourcePath: child.sourcePath,
            targetPath: child.targetPath,
            size: child.totalBytes,
            lastModified: child.sourceLastModified,
          }),
        }));
      for (const child of parentChildren) normalizedChildUpdates.set(child.id, child);
    }
    const checkpoint = isValidDirectoryResumeCheckpoint(parent.directoryResumeCheckpoint)
      ? { ...parent.directoryResumeCheckpoint }
      : createEmptyDirectoryResumeCheckpoint();
    const initialCoveredEntries = checkpoint.coveredEntries;
    const childrenByIndex = new Map<number, TransferTask>();
    for (const child of parentChildren) {
      if (!Number.isSafeInteger(child.directoryEntryIndex) || (child.directoryEntryIndex ?? -1) < 0) continue;
      if (!/^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")) continue;
      if (!childrenByIndex.has(child.directoryEntryIndex!)) {
        childrenByIndex.set(child.directoryEntryIndex!, child);
      }
    }
    const manifest = createDirectoryManifestAccumulator(checkpoint);
    while (childrenByIndex.has(checkpoint.coveredEntries)) {
      const child = childrenByIndex.get(checkpoint.coveredEntries)!;
      manifest.append(child.directoryEntryIdentity!);
      checkpoint.coveredEntries += 1;
    }
    checkpoint.manifestHash = manifest.digest();
    let newlyCompacted = 0;
    for (const child of parentChildren) {
      if (
        child.parentTaskId === parent.id
        && child.status === "completed"
        && Number.isSafeInteger(child.directoryEntryIndex)
        && (child.directoryEntryIndex ?? checkpoint.coveredEntries) < checkpoint.coveredEntries
        && /^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")
      ) {
        compactedChildIds.add(child.id);
        newlyCompacted += 1;
      }
    }
    if (checkpoint.coveredEntries !== initialCoveredEntries || newlyCompacted > 0) {
      checkpoint.completedEntries = Math.min(
        checkpoint.coveredEntries,
        checkpoint.completedEntries + newlyCompacted,
      );
      parentUpdates.set(parent.id, {
        ...parent,
        directoryResumeCheckpoint: checkpoint,
        transferredBytes: Math.max(parent.transferredBytes, checkpoint.completedEntries),
      });
    }
  }
  if (compactedChildIds.size > 0 || parentUpdates.size > 0 || normalizedChildUpdates.size > 0) {
    compacted = compacted
      .filter((task) => !compactedChildIds.has(task.id))
      .map((task) => parentUpdates.get(task.id) ?? normalizedChildUpdates.get(task.id) ?? task);
  }

  const unfinished = compacted.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const unfinishedIds = new Set(unfinished.map((task) => task.id));
  // Keep terminal exceptions that cannot be compacted (failed/cancelled or a
  // legacy gap). Completed indexed children normally live in the parent hash.
  const checkpointChildren = compacted.filter((task) =>
    TERMINAL_STATUSES.has(task.status)
    && !!task.parentTaskId
    && unfinishedIds.has(task.parentTaskId),
  );
  const checkpointIds = new Set(checkpointChildren.map((task) => task.id));
  const terminal = compacted
    .filter((task) => TERMINAL_STATUSES.has(task.status) && !checkpointIds.has(task.id))
    .filter((task) => now - (task.endTime ?? task.updatedAt ?? task.startTime) <= SFTP_TRANSFER_HISTORY_MAX_AGE_MS)
    .sort((a, b) => (b.endTime ?? b.updatedAt ?? b.startTime) - (a.endTime ?? a.updatedAt ?? a.startTime))
    .slice(0, SFTP_TRANSFER_HISTORY_MAX);
  return [...unfinished, ...checkpointChildren, ...terminal].sort((a, b) => a.startTime - b.startTime);
}

export function validateTransferResumeSource(
  task: Pick<TransferTask, "totalBytes" | "sourceLastModified" | "checkpointBytes">,
  source: { size: number; lastModified?: number; sizeKnown?: boolean },
  options?: { allowSourceGrowth?: boolean },
): string | null {
  // Stat-less SCP endpoints report size as a placeholder 0 (sizeKnown false).
  // Size-based checks would misread any saved progress against that fake zero
  // as a shrunk/changed source and silently restart the transfer, so only the
  // mtime guard applies while the size is unknown.
  const sizeKnown = source.sizeKnown !== false && Number.isFinite(source.size);
  if (!sizeKnown) {
    if (
      !options?.allowSourceGrowth
      && task.sourceLastModified
      && source.lastModified
      && source.lastModified !== task.sourceLastModified
    ) {
      return "Source was modified while the transfer was paused";
    }
    return null;
  }
  const checkpoint = Math.max(0, task.checkpointBytes ?? 0);
  if (checkpoint > source.size) return "Saved checkpoint is beyond the current source size";
  const plannedSize = Number(task.totalBytes);
  const hasPlannedSize = Number.isFinite(plannedSize) && plannedSize >= 0;
  if (hasPlannedSize) {
    if (source.size < plannedSize) {
      return "Source size changed while the transfer was paused";
    }
    // Download snapshots of append-only files (live logs) may grow past the
    // planned size — including an empty (0-byte) snapshot; the original
    // [0, totalBytes) range is still resume-safe.
    if (source.size > plannedSize && !options?.allowSourceGrowth) {
      return "Source size changed while the transfer was paused";
    }
  }
  // Append growth always updates mtime; only treat mtime drift as a rewrite when
  // the planned size is still exact. plannedSize === 0 with source growth is
  // still growth (empty log that received its first lines while paused).
  const sizeGrew =
    Boolean(options?.allowSourceGrowth)
    && hasPlannedSize
    && source.size > plannedSize;
  if (
    !sizeGrew
    && task.sourceLastModified
    && source.lastModified
    && source.lastModified !== task.sourceLastModified
  ) {
    return "Source was modified while the transfer was paused";
  }
  return null;
}

export interface SftpTransferCenter {
  add(ownerId: string, tasks: readonly TransferTask[]): void;
  update(taskId: string, updates: Partial<TransferTask>): void;
  pause(taskId: string): void;
  resume(taskId: string): void;
  prioritize(taskId: string): void;
  complete(taskId: string): void;
  takeRunnable(): TransferTask[];
  getTask(taskId: string): TransferTask | undefined;
  getTasks(): readonly TransferTask[];
}

export function createSftpTransferCenter({ concurrency }: { concurrency: number }): SftpTransferCenter {
  let tasks: TransferTask[] = [];
  let prioritySequence = 0;

  const replace = (taskId: string, updates: Partial<TransferTask>) => {
    tasks = tasks.map((task) => task.id === taskId
      ? { ...task, ...updates, updatedAt: updates.updatedAt ?? Date.now() }
      : task);
  };

  return {
    add(ownerId, incoming) {
      const existingIds = new Set(tasks.map((item) => item.id));
      tasks = [
        ...tasks,
        ...incoming.filter((item) => !existingIds.has(item.id)).map((item) => ({ ...item, ownerId })),
      ];
    },
    update: replace,
    pause(taskId) {
      const current = tasks.find((item) => item.id === taskId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      replace(taskId, { status: "paused", speed: 0 });
    },
    resume(taskId) {
      const current = tasks.find((item) => item.id === taskId);
      if (!current || !["paused", "interrupted", "failed", "attention"].includes(current.status)) return;
      replace(taskId, { status: "queued", error: undefined, endTime: undefined });
    },
    prioritize(taskId) {
      prioritySequence += 1;
      replace(taskId, { priority: prioritySequence });
    },
    complete(taskId) {
      replace(taskId, { status: "completed", endTime: Date.now(), speed: 0 });
    },
    takeRunnable() {
      const openSlots = Math.max(0, Math.floor(concurrency) - tasks.filter((item) => RUNNING_STATUSES.has(item.status)).length);
      if (openSlots === 0) return [];
      const queued = tasks
        .filter((item) => item.status === "queued" && !item.parentTaskId)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.startTime - b.startTime);
      const selected: TransferTask[] = [];
      const owners = new Set<string>();
      for (const task of queued) {
        const owner = task.ownerId ?? "global";
        if (owners.has(owner) && queued.some((candidate) => (
          candidate.id !== task.id
          && !selected.includes(candidate)
          && !owners.has(candidate.ownerId ?? "global")
        ))) continue;
        selected.push(task);
        owners.add(owner);
        if (selected.length >= openSlots) break;
      }
      for (const task of selected) replace(task.id, { status: "transferring" });
      return selected.map((task) => tasks.find((item) => item.id === task.id) ?? task);
    },
    getTask(taskId) {
      return tasks.find((item) => item.id === taskId);
    },
    getTasks() {
      return tasks;
    },
  };
}
