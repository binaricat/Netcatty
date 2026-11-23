import type { TransferTask } from "../../../domain/models";
import {
  compareDirectoryTraversalPaths,
  createDirectoryManifestAccumulator,
  createDirectoryEntryIdentity,
  createEmptyDirectoryResumeCheckpoint,
  isValidDirectoryResumeCheckpoint,
} from "../../../domain/sftpDirectoryCheckpoint";
import {
  pruneSftpTransferHistory,
  sanitizeSftpTransferTask,
  SFTP_TRANSFER_CENTER_VERSION,
} from "../../../domain/sftpTransferCenter";

const RESTORE_SYNC_BUDGET_MS = 8;
const RESTORE_CHECK_INTERVAL = 128;
const TERMINAL_STATUSES = new Set<TransferTask["status"]>(["completed", "failed", "cancelled"]);

export interface CooperativeTransferHistoryRestoreResult {
  valid: boolean;
  tasks: TransferTask[];
  restoredPackedTaskIds: string[];
}

function monotonicNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

async function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createRestoreYieldController() {
  let sliceStartedAt = monotonicNow();
  return async (iteration: number, force = false) => {
    if (!force && iteration % RESTORE_CHECK_INTERVAL !== 0) return;
    if (!force && monotonicNow() - sliceStartedAt < RESTORE_SYNC_BUDGET_MS) return;
    await yieldToEventLoop();
    sliceStartedAt = monotonicNow();
  };
}

/**
 * Upgrade a large pre-checkpoint transfer history without monopolizing the
 * renderer. The final bounded prune still uses the canonical domain function;
 * this function only performs its expensive legacy directory normalization
 * and manifest hashing in cooperative slices first.
 */
export async function restoreSftpTransferHistoryCooperatively(
  raw: string,
  now = Date.now(),
): Promise<CooperativeTransferHistoryRestoreResult> {
  // Let first paint and store subscribers attach before parsing a legacy blob.
  await yieldToEventLoop();

  let parsed: { version?: unknown; tasks?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown; tasks?: unknown };
  } catch {
    return { valid: false, tasks: [], restoredPackedTaskIds: [] };
  }
  if (parsed.version !== SFTP_TRANSFER_CENTER_VERSION || !Array.isArray(parsed.tasks)) {
    return { valid: false, tasks: [], restoredPackedTaskIds: [] };
  }

  const maybeYield = createRestoreYieldController();
  const restored: TransferTask[] = [];
  const restoredPackedTaskIds: string[] = [];
  for (let index = 0; index < parsed.tasks.length; index += 1) {
    const task = sanitizeSftpTransferTask(parsed.tasks[index], {
      onRestoredPackedTask: (id) => restoredPackedTaskIds.push(id),
    });
    if (task) restored.push(task);
    await maybeYield(index);
  }

  const unfinishedDirectoryParents: TransferTask[] = [];
  const childrenByParent = new Map<string, TransferTask[]>();
  for (let index = 0; index < restored.length; index += 1) {
    const task = restored[index];
    if (task.isDirectory && !task.parentTaskId && !TERMINAL_STATUSES.has(task.status)) {
      unfinishedDirectoryParents.push(task);
    }
    if (task.parentTaskId) {
      const children = childrenByParent.get(task.parentTaskId) ?? [];
      children.push(task);
      childrenByParent.set(task.parentTaskId, children);
    }
    await maybeYield(index);
  }

  const compactedChildIds = new Set<string>();
  const parentUpdates = new Map<string, TransferTask>();
  const normalizedChildUpdates = new Map<string, TransferTask>();

  for (let parentIndex = 0; parentIndex < unfinishedDirectoryParents.length; parentIndex += 1) {
    const parent = unfinishedDirectoryParents[parentIndex];
    let parentChildren = childrenByParent.get(parent.id) ?? [];
    const needsLegacyNormalization = !isValidDirectoryResumeCheckpoint(parent.directoryResumeCheckpoint)
      && parentChildren.some((child) => (
        !Number.isSafeInteger(child.directoryEntryIndex)
        || !/^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")
      ));

    if (needsLegacyNormalization) {
      parentChildren = [...parentChildren]
        .sort((left, right) => compareDirectoryTraversalPaths(left.sourcePath, right.sourcePath));
      await maybeYield(parentIndex, parentChildren.length > RESTORE_CHECK_INTERVAL);
      for (let childIndex = 0; childIndex < parentChildren.length; childIndex += 1) {
        const child = parentChildren[childIndex];
        const normalized: TransferTask = {
          ...child,
          directoryEntryIndex: childIndex,
          directoryEntryIdentity: createDirectoryEntryIdentity({
            sourcePath: child.sourcePath,
            targetPath: child.targetPath,
            size: child.totalBytes,
            lastModified: child.sourceLastModified,
          }),
        };
        parentChildren[childIndex] = normalized;
        normalizedChildUpdates.set(normalized.id, normalized);
        await maybeYield(childIndex);
      }
    }

    const checkpoint = isValidDirectoryResumeCheckpoint(parent.directoryResumeCheckpoint)
      ? { ...parent.directoryResumeCheckpoint }
      : createEmptyDirectoryResumeCheckpoint();
    const initialCoveredEntries = checkpoint.coveredEntries;
    const childrenByIndex = new Map<number, TransferTask>();
    for (let childIndex = 0; childIndex < parentChildren.length; childIndex += 1) {
      const child = parentChildren[childIndex];
      if (
        Number.isSafeInteger(child.directoryEntryIndex)
        && (child.directoryEntryIndex ?? -1) >= 0
        && /^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")
        && !childrenByIndex.has(child.directoryEntryIndex!)
      ) {
        childrenByIndex.set(child.directoryEntryIndex!, child);
      }
      await maybeYield(childIndex);
    }

    let hashIterations = 0;
    const manifest = createDirectoryManifestAccumulator(checkpoint);
    while (childrenByIndex.has(checkpoint.coveredEntries)) {
      const child = childrenByIndex.get(checkpoint.coveredEntries)!;
      manifest.append(child.directoryEntryIdentity!);
      checkpoint.coveredEntries += 1;
      hashIterations += 1;
      await maybeYield(hashIterations);
    }
    checkpoint.manifestHash = manifest.digest();

    let newlyCompacted = 0;
    for (let childIndex = 0; childIndex < parentChildren.length; childIndex += 1) {
      const child = parentChildren[childIndex];
      if (
        child.status === "completed"
        // Match canonical pruning: warning rows carry recovery paths that
        // cannot be represented by the directory's compact manifest.
        && !child.warning
        && Number.isSafeInteger(child.directoryEntryIndex)
        && (child.directoryEntryIndex ?? checkpoint.coveredEntries) < checkpoint.coveredEntries
        && /^[a-f0-9]{64}$/.test(child.directoryEntryIdentity ?? "")
      ) {
        compactedChildIds.add(child.id);
        newlyCompacted += 1;
      }
      await maybeYield(childIndex);
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

  const compacted: TransferTask[] = [];
  for (let index = 0; index < restored.length; index += 1) {
    const task = restored[index];
    if (!compactedChildIds.has(task.id)) {
      compacted.push(parentUpdates.get(task.id) ?? normalizedChildUpdates.get(task.id) ?? task);
    }
    await maybeYield(index);
  }

  return {
    valid: true,
    tasks: pruneSftpTransferHistory(compacted, now),
    restoredPackedTaskIds,
  };
}
