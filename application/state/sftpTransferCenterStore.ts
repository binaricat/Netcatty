import { useRef, useSyncExternalStore } from "react";

import type { FileConflictAction, TransferTask } from "../../domain/models";
import {
  deserializeSftpTransferCenter,
  pruneSftpTransferHistory,
  serializeSftpTransferCenter,
} from "../../domain/sftpTransferCenter";
import {
  findActivePathConflict,
  pathConflictMessage,
} from "../../domain/sftpTransferConflicts";
import { STORAGE_KEY_SFTP_TRANSFER_CENTER } from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { notify } from "../notification";
import { globalSftpTransferScheduler } from "./sftp/globalTransferScheduler";
import {
  isTransferOrRootPauseLatched,
  isTransferPauseLatched,
  releaseTransferPauseTree,
} from "./sftp/transferPauseLatch";
import {
  bumpTransferControlEpoch,
  getTransferControlEpoch,
  isTransferControlEpochCurrent,
  settleTransferControlEpochTree,
} from "./sftp/transferControlEpoch";
import { isTransferWalkInFlight } from "./sftp/transferWalkRegistry";
import {
  isTransferOrRootCancelled,
  markTransferCancelledTree,
  settleTransferCancelTree,
} from "./sftp/transferCancelLatch";
import {
  defaultTransferControlBridge,
  softPauseTransfer,
  softResumeTransfer,
  type TransferControlHost,
} from "./sftp/globalSftpTransferControl";
import { restoreSftpTransferHistoryCooperatively } from "./sftp/transferHistoryRestoreMigration";
import { cancelExternalUploadRuntime } from "./sftp/externalUploadRuntime";

type Listener = () => void;

// Ordinary bounded history restores synchronously so existing callers receive
// it immediately. Legacy directory snapshots can contain tens of thousands of
// rows, so they migrate after first paint in cooperative slices.
const ASYNC_TRANSFER_HISTORY_RESTORE_THRESHOLD_BYTES = 512 * 1024;

export interface SftpTransferOwnerControls {
  pause: (taskId: string) => void | Promise<void>;
  resume: (taskId: string) => void | Promise<void>;
  cancel: (taskId: string) => void | Promise<void>;
  retry: (taskId: string) => void | Promise<void>;
  prioritize: (taskId: string) => void | Promise<void>;
  dismiss: (taskId: string, task?: TransferTask) => void;
  /** Remove a pruned group in one owner update to avoid publish/dismiss feedback loops. */
  dismissMany?: (tasks: readonly TransferTask[]) => void;
  /**
   * True when the panel still lists this task locally.
   * Used only for adopt/retry UX after hard reconnect — never for soft
   * pause/resume (those are process-global via TransferRuntime / store).
   */
  ownsTask?: (taskId: string) => boolean;
  /** Pull lifecycle fields from the store after unified soft-control. */
  syncOwnedTasks?: () => void;
  canAdopt?: (task: TransferTask) => boolean;
  canPrepareAdoption?: boolean;
  adopt?: (task: TransferTask) => void | Promise<void>;
  resolveConflict?: (taskId: string, action: FileConflictAction, applyToAll?: boolean) => void | Promise<void>;
}

export interface SftpTransferCenterSnapshot {
  tasks: readonly TransferTask[];
  activeCount: number;
  queuedCount: number;
  attentionCount: number;
}

export type DedicatedTransferResumeHandler = (task: TransferTask) => Promise<{
  success: boolean;
  error?: string;
  needsAttention?: boolean;
  resetCheckpoint?: boolean;
}>;

export interface SftpTransferCenterStore {
  subscribe(listener: Listener): () => void;
  /**
   * Progress-only fanout. Pure byte ticks must not wake lifecycle subscribers
   * (owner foreign-id sync, badge, closed popover getters).
   */
  subscribeProgress(listener: Listener): () => void;
  getSnapshot(): SftpTransferCenterSnapshot;
  /** Stable identity when badge counts are unchanged (avoids TopTabs thrash). */
  getBadgeSnapshot(): { count: number; hasAttention: boolean };
  /** Single task row — same object identity until that row is patched. */
  getTask(taskId: string): TransferTask | undefined;
  /** Observe exact task settlement before completed child rows are compacted. */
  observeTaskSettlement(task: TransferTask): { read(): TransferTask | undefined; dispose(): void };
  /** Publish an explicit dispatch identity without flushing large child-history batches. */
  admitTaskRun(task: TransferTask, pausedAtResume?: TransferTask): "ready" | "paused" | "completed" | "cancelled" | "conflict";
  getOwnerTasks(ownerId: string): TransferTask[];
  publishOwner(ownerId: string, tasks: readonly TransferTask[]): void;
  registerOwner(ownerId: string, controls: SftpTransferOwnerControls): () => void;
  setDedicatedResumeHandler(handler: DedicatedTransferResumeHandler | null): void;
  patchTask(taskId: string, updates: Partial<TransferTask>): void;
  /** Insert or merge tasks by id (used by dedicated directory resume for children). */
  upsertTasks(incoming: readonly TransferTask[]): void;
  canControl(taskId: string): boolean;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  prioritize(taskId: string): Promise<void>;
  dismiss(taskId: string): void;
  clearTerminal(status?: TransferTask["status"]): void;
  markReconnectRequired(taskId: string, error?: string): void;
  reportResumePreparationFailure(taskId: string, error: string): void;
  ingestBackgroundEvent(event: {
    type: "queued" | "started" | "progress" | "pausing" | "paused" | "resumed" | "cancelled" | "completed" | "failed";
    transferId: string;
    direction?: TransferTask["direction"];
    fileName?: string;
    sourcePath?: string;
    targetPath?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
    transferred?: number;
    totalBytes?: number;
    speed?: number;
    checkpointBytes?: number;
    resumeStage?: TransferTask["resumeStage"];
    downloadCheckpointBytes?: number;
    uploadCheckpointBytes?: number;
    sourceFingerprint?: string;
    sessionId?: string;
    sourceHostId?: string;
    targetHostId?: string;
    parentTaskId?: string;
    directoryEntryIndex?: number;
    directoryEntryIdentity?: string;
    isDirectory?: boolean;
    controlKind?: TransferTask["controlKind"];
    phase?: TransferTask["phase"];
    lifecycleEpoch?: number;
    lifecycleState?: "queued" | "pausing" | "paused" | "transferring";
    resumable?: boolean;
    pauseUnavailableReason?: string;
  }): void;
  resolveConflict(taskId: string, action: FileConflictAction, applyToAll?: boolean): Promise<void>;
}

type BackgroundTransferEvent = Parameters<SftpTransferCenterStore["ingestBackgroundEvent"]>[0];

interface StorePersistence {
  read(): string | null;
  write(value: string): void;
}

const EMPTY_SNAPSHOT: SftpTransferCenterSnapshot = {
  tasks: [],
  activeCount: 0,
  queuedCount: 0,
  attentionCount: 0,
};

function buildSnapshot(tasks: readonly TransferTask[]): SftpTransferCenterSnapshot {
  const topLevelTasks = tasks.filter((task) => !task.parentTaskId);
  return {
    tasks,
    activeCount: topLevelTasks.filter((task) => task.status === "transferring" || task.status === "pausing").length,
    queuedCount: topLevelTasks.filter((task) => task.status === "pending" || task.status === "queued").length,
    attentionCount: topLevelTasks.filter((task) => task.status === "attention" || task.status === "failed").length,
  };
}

function buildBadgeSnapshot(tasks: readonly TransferTask[]): { count: number; hasAttention: boolean } {
  const topLevelTasks = tasks.filter((task) => !task.parentTaskId);
  return {
    count: topLevelTasks.filter((task) =>
      ["pending", "queued", "transferring", "pausing", "paused", "interrupted"].includes(task.status)
    ).length,
    hasAttention: topLevelTasks.some((task) =>
      task.status === "attention"
      || task.status === "failed"
      || task.status === "interrupted"
      || task.reconnectRequired === true
    ),
  };
}

const TERMINAL_OWNER_STATUSES = new Set<TransferTask["status"]>([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * Panel snapshots and main-process progress IPC both write the same rows.
 * Never let a stale panel paint roll back bytes that background events already
 * advanced (tab-close / hide dual-writer race freezes the global center bar).
 * Also never resurrect completed/cancelled store rows from a late transferring
 * panel snapshot (ingest already guards terminal; publishOwner must too).
 */
export function mergeOwnerPublishedTask(
  existing: TransferTask,
  incoming: TransferTask,
  ownerId: string,
  parentStatus?: TransferTask["status"],
): TransferTask {
  // Explicit restart / re-queue may reset progress to 0 — allow that.
  const incomingReset = (
    (incoming.status === "pending" || incoming.status === "queued")
    && (incoming.transferredBytes ?? 0) === 0
    && (incoming.checkpointBytes ?? 0) === 0
  );
  const incomingTerminal = TERMINAL_OWNER_STATUSES.has(incoming.status);
  // completed/cancelled stick on the store. A late panel "transferring" paint
  // must not un-complete after ingestBackgroundEvent(completed|cancelled).
  // failed is intentionally not sticky: same-id checkpoint resume re-opens it.
  if (
    (existing.status === "completed" || existing.status === "cancelled")
    && !incomingTerminal
    && !incomingReset
  ) {
    return {
      ...existing,
      ownerId,
      updatedAt: existing.updatedAt ?? Date.now(),
    };
  }
  // Prefer cancelled over a late completed when both sides are terminal.
  if (
    existing.status === "cancelled"
    && incoming.status === "completed"
  ) {
    return {
      ...existing,
      ownerId,
      updatedAt: existing.updatedAt ?? Date.now(),
    };
  }

  const merged: TransferTask = {
    ...incoming,
    ownerId,
    updatedAt: incoming.updatedAt ?? Date.now(),
  };

  if (incomingReset || incomingTerminal) {
    return merged;
  }

  // Keep higher water marks while either side still treats the row as live work.
  const existingLive = !TERMINAL_OWNER_STATUSES.has(existing.status);
  const incomingLive = !TERMINAL_OWNER_STATUSES.has(incoming.status);
  if (existingLive && incomingLive) {
    const existingBytes = existing.transferredBytes ?? 0;
    const incomingBytes = incoming.transferredBytes ?? 0;
    if (existingBytes > incomingBytes) {
      merged.transferredBytes = existingBytes;
      // Prefer the fresher non-zero speed from either side when bytes stall.
      if (!(Number.isFinite(merged.speed) && merged.speed > 0) && existing.speed > 0) {
        merged.speed = existing.speed;
      }
    }
    const existingCheckpoint = existing.checkpointBytes ?? 0;
    const incomingCheckpoint = incoming.checkpointBytes ?? 0;
    if (existingCheckpoint > incomingCheckpoint) {
      merged.checkpointBytes = existingCheckpoint;
    }
    if ((existing.totalBytes ?? 0) > (incoming.totalBytes ?? 0)) {
      merged.totalBytes = existing.totalBytes;
    }
    const existingLifecycleEpoch = Number.isFinite(existing.lifecycleEpoch)
      ? (existing.lifecycleEpoch as number)
      : -1;
    const incomingLifecycleEpoch = Number.isFinite(incoming.lifecycleEpoch)
      ? (incoming.lifecycleEpoch as number)
      : -1;
    if (existingLifecycleEpoch > incomingLifecycleEpoch) {
      merged.lifecycleEpoch = existing.lifecycleEpoch;
      merged.status = existing.status;
      if (existing.status === "paused" || existing.status === "pausing") {
        merged.transferredBytes = existing.transferredBytes;
        merged.checkpointBytes = existing.checkpointBytes;
        merged.speed = 0;
      }
    }
    // Background progress re-opens transferring; don't let a frozen panel
    // snapshot paint a non-terminal lower status over a live transferring row
    // when bytes moved forward on the store.
    if (
      existing.status === "transferring"
      && (incoming.status === "pending" || incoming.status === "queued")
      && (merged.transferredBytes ?? 0) > 0
    ) {
      merged.status = "transferring";
    }
    // Intentional pause from the panel must always win over soft-drain water
    // marks. Freezing transferredBytes on pause used to leave store bytes ahead
    // of the panel snapshot; the old "higher bytes keep transferring" rule then
    // rejected pause and the global transfer center looked stuck on 传输中.
    // Only a strictly newer lifecycle epoch may re-open transferring (resume).
    const incomingPaused = incoming.status === "paused" || incoming.status === "pausing";
    const existingPaused = existing.status === "paused" || existing.status === "pausing";
    if (incomingPaused && incomingLifecycleEpoch >= existingLifecycleEpoch) {
      merged.status = incoming.status;
      merged.speed = 0;
      // Pin the visible bar while paused/latched. Soft-drain must not keep
      // raising transferredBytes after the user paused (checkpoint may still rise).
      const latched = isTransferOrRootPauseLatched(
        existing.parentTaskId ?? existing.id,
        existing.id,
      ) || isTransferPauseLatched(existing.id);
      if (latched || existingPaused) {
        merged.transferredBytes = existingBytes;
      } else {
        merged.transferredBytes = Math.max(existingBytes, incomingBytes);
      }
      if (existingCheckpoint > 0 || incomingCheckpoint > 0) {
        merged.checkpointBytes = Math.max(existingCheckpoint, incomingCheckpoint);
      }
    } else if (
      existingPaused
      && (incoming.status === "transferring" || incoming.status === "pending" || incoming.status === "queued")
      // Only a strictly older epoch is a stale snapshot. Equal/missing epochs must
      // allow intentional Resume (publishOwner after unlatch) to re-open the row.
      && incomingLifecycleEpoch < existingLifecycleEpoch
    ) {
      // Soft-drain / late progress publish must not un-pause without resume epoch.
      merged.status = existing.status;
      merged.speed = 0;
      merged.transferredBytes = existing.transferredBytes;
      merged.checkpointBytes = existing.checkpointBytes ?? merged.checkpointBytes;
    }
    // Folder parent already paused/pausing: never re-open a child as live from a
    // late panel paint. That made the collapsed "current file" row blink in/out.
    const parentHoldsPause = parentStatus === "paused" || parentStatus === "pausing";
    if (
      parentHoldsPause
      && !["completed", "cancelled", "failed"].includes(merged.status)
      && (merged.status === "transferring" || merged.status === "pending" || merged.status === "queued")
    ) {
      merged.status = parentStatus === "pausing" ? "pausing" : "paused";
      merged.speed = 0;
    }
  }

  if (
    existing.directoryResumeCheckpoint
    && (
      !merged.directoryResumeCheckpoint
      || merged.directoryResumeCheckpoint.coveredEntries
        < existing.directoryResumeCheckpoint.coveredEntries
    )
  ) {
    merged.directoryResumeCheckpoint = existing.directoryResumeCheckpoint;
    merged.transferredBytes = Math.max(
      merged.transferredBytes ?? 0,
      existing.directoryResumeCheckpoint.completedEntries,
    );
  }

  return merged;
}

function areTransferTasksEquivalent(left: TransferTask, right: TransferTask): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    // updatedAt is bookkeeping, not a visible or durable transfer change.
    if (key === "updatedAt") continue;
    if (!Object.is(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

export function createSftpTransferCenterStore(persistence?: StorePersistence): SftpTransferCenterStore {
  const persistedRaw = persistence?.read() ?? null;
  const shouldRestoreCooperatively = (
    typeof persistedRaw === "string"
    && persistedRaw.length >= ASYNC_TRANSFER_HISTORY_RESTORE_THRESHOLD_BYTES
  );
  const restored = shouldRestoreCooperatively
    ? { tasks: [] }
    : deserializeSftpTransferCenter(persistedRaw);
  let tasks = pruneSftpTransferHistory(restored.tasks);
  let restoreMigrationPending = shouldRestoreCooperatively;
  let replayingRestoreEvents = false;
  let deferRestoreReplayEmits = false;
  let restoreEventSequence = 0;
  const backgroundEventsDuringRestore = new Map<string, Array<{
    sequence: number;
    event: BackgroundTransferEvent;
  }>>();
  let snapshot = tasks.length > 0 ? buildSnapshot(tasks) : EMPTY_SNAPSHOT;
  let badgeSnapshot = buildBadgeSnapshot(tasks);
  let snapshotDirty = false;
  const listeners = new Set<Listener>();
  const progressListeners = new Set<Listener>();
  const settlementObservers = new Map<string, Set<{ expected: TransferTask; settled?: TransferTask }>>();
  const matchesObservedTask = (expected: TransferTask, candidate: TransferTask) => (
    expected.id === candidate.id
    && expected.sourcePath === candidate.sourcePath
    && expected.targetPath === candidate.targetPath
    && expected.parentTaskId === candidate.parentTaskId
    && expected.directoryEntryIndex === candidate.directoryEntryIndex
    && expected.directoryEntryIdentity === candidate.directoryEntryIdentity
  );
  const refreshBadgeSnapshot = () => {
    const next = buildBadgeSnapshot(tasks);
    if (
      next.count === badgeSnapshot.count
      && next.hasAttention === badgeSnapshot.hasAttention
    ) {
      return;
    }
    badgeSnapshot = next;
  };
  const controllers = new Map<string, SftpTransferOwnerControls>();
  const lastPublishedByOwner = new Map<string, ReadonlyMap<string, TransferTask>>();
  const PERSIST_INTERVAL_MS = 250;
  // Progress ticks must not touch localStorage — see emitProgress. Pause/complete
  // and other lifecycle emits still persist immediately via emit()/persist(true).
  let lastPersistedAt = 0;
  let persistenceDirty = false;
  let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  const resumeInvocations = new Map<string, Promise<void>>();
  const resumePreparationFailures = new Map<string, string>();
  let dedicatedResumeHandler: DedicatedTransferResumeHandler | null = null;
  const dedicatedResumeWaiters = new Set<{
    taskId: string;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const notifyDedicatedResumeWaiters = () => {
    for (const waiter of dedicatedResumeWaiters) {
      const current = tasks.find((task) => task.id === waiter.taskId);
      if (
        !dedicatedResumeHandler
        && current
        && current.status !== "cancelled"
        && current.status !== "completed"
      ) continue;
      clearTimeout(waiter.timer);
      dedicatedResumeWaiters.delete(waiter);
      waiter.resolve();
    }
  };

  const waitForDedicatedResumeHandler = (taskId: string) => new Promise<void>((resolve) => {
    if (dedicatedResumeHandler) {
      resolve();
      return;
    }
    const waiter = {
      taskId,
      resolve,
      // Vault unlock + first host load can exceed a few seconds after force-quit.
      timer: setTimeout(() => {
        dedicatedResumeWaiters.delete(waiter);
        resolve();
      }, 15000),
    };
    dedicatedResumeWaiters.add(waiter);
  });

  const writePersistence = () => {
    if (!persistence || !persistenceDirty || restoreMigrationPending) return;
    persistenceDirty = false;
    try {
      persistence.write(serializeSftpTransferCenter(tasks));
    } catch (error) {
      // Transfer history is recoverability metadata. Storage exhaustion or a
      // transient browser storage failure must never take down the renderer.
      console.warn("[SFTP] Could not persist transfer history", error);
    } finally {
      // Measure the interval from completion, since stringify/setItem itself can
      // be expensive for a large directory snapshot.
      lastPersistedAt = Date.now();
    }
  };
  const persist = (immediate = false) => {
    if (!persistence) return;
    persistenceDirty = true;
    // Never replace a valid legacy snapshot with the initially empty store.
    // Mutations that happen during migration are merged before the final write.
    if (restoreMigrationPending) return;
    const elapsed = Date.now() - lastPersistedAt;
    if (immediate || lastPersistedAt === 0 || elapsed >= PERSIST_INTERVAL_MS) {
      if (persistenceTimer) {
        clearTimeout(persistenceTimer);
        persistenceTimer = null;
      }
      writePersistence();
      return;
    }
    if (persistenceTimer) return;
    persistenceTimer = setTimeout(() => {
      persistenceTimer = null;
      writePersistence();
    }, PERSIST_INTERVAL_MS - elapsed);
  };
  const notifyOwnersOfPrunedTasks = (removed: readonly TransferTask[]) => {
    if (removed.length === 0) return;
    const byOwner = new Map<string, TransferTask[]>();
    for (const task of removed) {
      if (!task.ownerId) continue;
      const ownerTasks = byOwner.get(task.ownerId) ?? [];
      ownerTasks.push(task);
      byOwner.set(task.ownerId, ownerTasks);
    }
    for (const [ownerId, ownerTasks] of byOwner) {
      const controller = controllers.get(ownerId);
      if (!controller) continue;
      if (controller.dismissMany) {
        controller.dismissMany(ownerTasks);
      } else {
        for (const task of ownerTasks) controller.dismiss(task.id, task);
      }
    }
  };
  const hasCriticalPersistenceChange = (
    previous: readonly TransferTask[],
    next: readonly TransferTask[],
  ) => {
    const previousById = new Map(previous.map((task) => [task.id, task]));
    for (const task of next) {
      const before = previousById.get(task.id);
      if (task.sourceFingerprint !== before?.sourceFingerprint) return true;
      if (task.directoryResumeCheckpoint !== before?.directoryResumeCheckpoint) return true;
      if (task.status === "paused" || task.status === "pausing") {
        if (
          task.status !== before?.status
          || task.checkpointBytes !== before?.checkpointBytes
          || task.resumeStage !== before?.resumeStage
          || task.downloadCheckpointBytes !== before?.downloadCheckpointBytes
          || task.uploadCheckpointBytes !== before?.uploadCheckpointBytes
        ) return true;
      }
      if (
        !task.parentTaskId
        && task.status !== before?.status
        && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      ) return true;
    }
    return false;
  };
  // Progress ticks used to call every listener synchronously (React transfer
  // center + any owner sync). Coalesce to one paint per animation frame so we
  // do not add another 200–500ms of lag on top of the main-process throttle
  // (stacked delays made the bar jump and feel frozen).
  let progressNotifyHandle: ReturnType<typeof setTimeout> | number | null = null;
  const cancelScheduledProgressNotify = () => {
    if (progressNotifyHandle == null) return;
    if (typeof globalThis.cancelAnimationFrame === "function" && typeof progressNotifyHandle === "number") {
      globalThis.cancelAnimationFrame(progressNotifyHandle);
    } else {
      clearTimeout(progressNotifyHandle as ReturnType<typeof setTimeout>);
    }
    progressNotifyHandle = null;
  };
  const scheduleProgressNotify = () => {
    if (progressNotifyHandle != null) return;
    const run = () => {
      progressNotifyHandle = null;
      for (const listener of progressListeners) listener();
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      progressNotifyHandle = globalThis.requestAnimationFrame(run);
    } else {
      progressNotifyHandle = setTimeout(run, 16);
    }
  };

  const ensureSnapshot = () => {
    if (!snapshotDirty) return snapshot;
    snapshot = buildSnapshot(tasks);
    snapshotDirty = false;
    return snapshot;
  };

  const settleFinishedTransferControlState = (
    candidates: readonly TransferTask[],
    allTasks: readonly TransferTask[] = tasks,
  ) => {
    const allTaskIds = new Set(allTasks.map((task) => task.id));
    const childIdsByRoot = new Map<string, string[]>();
    for (const task of allTasks) {
      if (!task.parentTaskId) continue;
      const childIds = childIdsByRoot.get(task.parentTaskId) ?? [];
      childIds.push(task.id);
      childIdsByRoot.set(task.parentTaskId, childIds);
    }
    for (const task of candidates) {
      if (!TERMINAL_OWNER_STATUSES.has(task.status)) continue;
      if (task.parentTaskId && allTaskIds.has(task.parentTaskId)) continue;
      if (isTransferWalkInFlight(task.id)) continue;
      const childIds = childIdsByRoot.get(task.id) ?? [];
      const relatedChildIds = settleTransferCancelTree(task.id, childIds);
      settleTransferControlEpochTree(task.id, relatedChildIds);
    }
  };

  const emit = (persistImmediately = false) => {
    if (deferRestoreReplayEmits) {
      snapshotDirty = true;
      persistenceDirty = persistenceDirty || persistImmediately;
      return;
    }
    // Lifecycle / structural changes must paint immediately. Drop any pending
    // progress coalesce so we do not notify twice with a stale intermediate snapshot.
    cancelScheduledProgressNotify();
    const shouldPersistImmediately = persistImmediately
      || hasCriticalPersistenceChange(snapshot.tasks, tasks);
    // Store terminal state is authoritative for background/detached work. A
    // live renderer walk keeps its controls until TransferRuntime.runWalk
    // settles; everything else can release its whole tree here.
    settleFinishedTransferControlState(tasks, tasks);
    if (settlementObservers.size > 0) {
      for (const task of tasks) {
        if (!TERMINAL_OWNER_STATUSES.has(task.status)) continue;
        for (const observer of settlementObservers.get(task.id) ?? []) {
          if (!observer.settled && matchesObservedTask(observer.expected, task)) observer.settled = task;
        }
      }
    }
    const beforePrune = tasks;
    tasks = pruneSftpTransferHistory(tasks);
    const retainedIds = new Set(tasks.map((task) => task.id));
    const removed = beforePrune.filter((task) => !retainedIds.has(task.id));
    if (removed.length > 0) {
      for (const [ownerId, published] of lastPublishedByOwner) {
        if (published.size === 0) continue;
        const retained = new Map(
          [...published].filter(([taskId]) => retainedIds.has(taskId)),
        );
        if (retained.size === 0) lastPublishedByOwner.delete(ownerId);
        else if (retained.size !== published.size) lastPublishedByOwner.set(ownerId, retained);
      }
    }
    snapshotDirty = false;
    snapshot = buildSnapshot(tasks);
    refreshBadgeSnapshot();
    persist(shouldPersistImmediately);
    notifyDedicatedResumeWaiters();
    for (const listener of listeners) listener();
    for (const listener of progressListeners) listener();
    // Notify only after the store snapshot is final. Owners must remove the
    // whole group atomically; per-row callbacks republish the remaining stale
    // rows and recursively re-enter pruning for large completed epochs.
    notifyOwnersOfPrunedTasks(removed);
  };

  /** Progress-only: mutate tasks, defer snapshot rebuild, wake progress UI only. */
  const emitProgress = (persistImmediately = false) => {
    if (deferRestoreReplayEmits) {
      snapshotDirty = true;
      persistenceDirty = persistenceDirty || persistImmediately;
      return;
    }
    snapshotDirty = true;
    // Never JSON.stringify/localStorage on the pure-progress path. Sync storage
    // on large directory histories freezes CSS spinners every few seconds.
    // Pause / complete / fingerprint / lifecycle still force persist below.
    if (persistImmediately) {
      snapshotDirty = false;
      snapshot = buildSnapshot(tasks);
      refreshBadgeSnapshot();
      persist(true);
      notifyDedicatedResumeWaiters();
      cancelScheduledProgressNotify();
      for (const listener of listeners) listener();
      for (const listener of progressListeners) listener();
      return;
    }
    notifyDedicatedResumeWaiters();
    scheduleProgressNotify();
  };
  const findOwner = (taskId: string) => tasks.find((task) => task.id === taskId)?.ownerId;
  const isAlreadyCompactedCompletedChild = (candidate: TransferTask) => {
    if (candidate.status !== "completed" || !candidate.parentTaskId) return false;
    if (!Number.isSafeInteger(candidate.directoryEntryIndex)) return false;
    const parent = tasks.find((task) => task.id === candidate.parentTaskId);
    const covered = parent?.directoryResumeCheckpoint?.coveredEntries ?? 0;
    if ((candidate.directoryEntryIndex ?? covered) >= covered) return false;
    return !tasks.some((task) => (
      task.parentTaskId === candidate.parentTaskId
      && task.directoryEntryIndex === candidate.directoryEntryIndex
    ));
  };
  const findAdopter = (task: TransferTask) => [...controllers.entries()].find(([, controls]) => (
    controls.adopt && controls.canAdopt?.(task)
  ));
  const prepareAdopter = async (task: TransferTask) => {
    let adopter = findAdopter(task);
    let preparationError: string | undefined;
    let cancelled = false;
    if (!adopter && typeof globalThis.window !== "undefined") {
      // Open the SFTP panel on the active terminal tab first so a preparer can
      // register, then ask it to reconnect the required hosts.
      globalThis.window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
        detail: { task, forResume: true },
      }));
      // ~45s is enough for MFA/password prompts; longer felt like a hang.
      const maxAttempts = 90;
      let prepareDispatched = false;
      for (let attempt = 0; attempt < maxAttempts && !adopter && !preparationError; attempt += 1) {
        const currentTask = tasks.find((candidate) => candidate.id === task.id);
        if (!currentTask || ["cancelled", "completed"].includes(currentTask.status)) {
          cancelled = true;
          break;
        }
        preparationError = resumePreparationFailures.get(task.id);
        if (preparationError) break;
        const preparer = [...controllers.entries()].find(([, controls]) => controls.canPrepareAdoption);
        if (preparer && !prepareDispatched) {
          prepareDispatched = true;
          globalThis.window.dispatchEvent(new CustomEvent("netcatty:prepare-sftp-transfer-resume", {
            detail: {
              task,
              targetOwnerId: preparer[0],
              reportFailure: (error: string) => {
                preparationError = error;
                resumePreparationFailures.set(task.id, error);
              },
            },
          }));
        } else if (!preparer && attempt === 10) {
          // Re-request panel open if nothing registered after a few seconds.
          globalThis.window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
            detail: { task, forResume: true },
          }));
          prepareDispatched = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        adopter = findAdopter(task);
      }
      if (!adopter && !preparationError && !cancelled) {
        preparationError = resumePreparationFailures.get(task.id)
          ?? "Could not reconnect in time. Open an SFTP panel and try again.";
      }
    }
    resumePreparationFailures.delete(task.id);
    return { adopter, error: preparationError, cancelled };
  };
  const resolveLiveController = (taskId: string) => {
    const ownerId = findOwner(taskId);
    const candidate = ownerId ? controllers.get(ownerId) : undefined;
    if (!candidate) return undefined;
    // Stale owner after tab close: registered but no longer tracking the task.
    if (typeof candidate.ownsTask === "function" && !candidate.ownsTask(taskId)) {
      return undefined;
    }
    return candidate;
  };

  const invoke = async (taskId: string, requestedAction: "pause" | "resume" | "cancel" | "retry" | "prioritize") => {
    let action = requestedAction;
    let controller = resolveLiveController(taskId);
    let task = tasks.find((candidate) => candidate.id === taskId);
    if (action === "cancel") {
      // External folder walks outlive their originating panel. Stop their
      // process-level controller from the same global cancel entry used by all
      // transfer UIs, whether or not the terminal tab still exists.
      await cancelExternalUploadRuntime(taskId);
    }
    // Intentional resume/retry must clear a pre-start cancel latch left by an
    // earlier cancel that never hit startTransferNow (same transferId).
    if (action === "resume" || action === "retry") {
      try {
        await netcattyBridge.get()?.clearPendingTransferCancel?.(taskId);
      } catch {
        // best-effort
      }
    }
    // Compressed soft-control is process-global: do not gate on a live panel owner.
    const liveCompressedJob = task?.controlKind === "compressed-upload"
      && task.reconnectRequired !== true
      && task.status !== "interrupted"
      && task.status !== "attention";
    if (liveCompressedJob && (action === "pause" || action === "resume" || action === "cancel")) {
      const bridge = netcattyBridge.get();
      if (action === "pause") {
        // Control epoch supersedes races; bridge lifecycleEpoch is stamped on success.
        const pauseControlEpoch = bumpTransferControlEpoch(taskId);
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "pausing" as const,
          pauseUnavailableReason: undefined,
          speed: 0,
        } : candidate);
        emit();
        const result = await (bridge?.pauseCompressedUpload?.(taskId)
          ?? { success: false, deferred: false, reason: "Pause unavailable" });
        const latest = tasks.find((candidate) => candidate.id === taskId);
        if (!latest || latest.status === "cancelled") return;
        // Drop stale paint if a newer control resume already superseded this pause.
        if (!isTransferControlEpochCurrent(taskId, pauseControlEpoch)
          && (latest.status === "transferring" || latest.status === "paused")) {
          return;
        }
        const bridgeEpoch = Number.isFinite(result.lifecycleEpoch)
          ? (result.lifecycleEpoch as number)
          : undefined;
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: result.success
            ? (result.deferred ? "pausing" as const : "paused" as const)
            : "transferring" as const,
          pauseUnavailableReason: result.success ? undefined : result.reason,
          speed: result.success ? 0 : candidate.speed,
          ...(bridgeEpoch !== undefined ? { lifecycleEpoch: bridgeEpoch } : null),
        } : candidate);
        emit();
        if (!result.success && result.reason) notify.warning(result.reason, "SFTP");
        return;
      }
      if (action === "resume") {
        bumpTransferControlEpoch(taskId);
        const result = await (bridge?.resumeCompressedUpload?.(taskId)
          ?? { success: false, reason: "Resume unavailable" });
        const latest = tasks.find((candidate) => candidate.id === taskId);
        if (!latest || latest.status === "cancelled") return;
        const bridgeEpoch = Number.isFinite(result.lifecycleEpoch)
          ? (result.lifecycleEpoch as number)
          : undefined;
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: result.success ? "transferring" as const : candidate.status,
          error: result.success ? undefined : (result.reason ?? candidate.error),
          pauseUnavailableReason: result.success ? undefined : candidate.pauseUnavailableReason,
          speed: 0,
          // Bridge epoch or clear so fanout progress is not stale-dropped.
          lifecycleEpoch: result.success ? bridgeEpoch : candidate.lifecycleEpoch,
        } : candidate);
        emit();
        if (!result.success && result.reason) notify.warning(result.reason, "SFTP");
        return;
      }
      const result = await (bridge?.cancelCompressedUpload?.(taskId)
        ?? { success: false });
      if (!result.success) {
        const reason = "Could not cancel the compressed upload.";
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention" as const,
          error: reason,
          speed: 0,
        } : candidate);
        emit();
        notify.warning(reason, "SFTP");
        return;
      }
      markTransferCancelledTree(taskId);
      releaseTransferPauseTree(taskId);
      tasks = tasks.map((candidate) => candidate.id === taskId ? {
        ...candidate,
        status: "cancelled" as const,
        error: undefined,
        endTime: Date.now(),
        speed: 0,
        phase: undefined,
      } : candidate);
      emit();
      return;
    }
    // After app restart (or any reconnectRequired task), a retained panel owner
    // often cannot resume (missing panes / dead sftpId). Prefer a dedicated
    // transfer session instead of failing with "Reconnect the source and target".
    // Never dedicated-resume rows waiting on conflict resolution — that would
    // stream with replace semantics and skip Replace/Skip/Duplicate UI.
    const needsDedicatedReconnect = action === "resume" && !!task && !task.conflict && (
      task.reconnectRequired === true
      || task.status === "interrupted"
      || (task.status === "attention" && !task.conflict)
      || task.ownerId === "background-agent"
    );
    if (needsDedicatedReconnect && controller && !controller.canAdopt?.(task)) {
      controller = undefined;
    }
    // Prefer the live owner controller for pause/resume of still-active work.
    // Do NOT drop it just because canAdopt is false when the transfer is still
    // live in the backend — downloads often have only a remote pane open.
    //
    // Only paint "Reconnecting…" when we truly need a dedicated/session reopen.
    // Soft-paused live streams after tab close must soft-resume without this
    // flash (otherwise Resume feels laggy / "broken").
    if (action === "resume" && task && needsDedicatedReconnect) {
      tasks = tasks.map((candidate) => candidate.id === taskId ? {
        ...candidate,
        status: "pending",
        error: undefined,
        speed: 0,
        phase: undefined,
        reconnectRequired: true,
        lifecycleEpoch: undefined,
      } : candidate);
      emit();
    }
    // The transfer center can render before vault startup has installed the
    // dedicated reconnect handler. Only wait when nothing else can take the
    // job yet (no owner controller and no panel adopter).
    if (
      needsDedicatedReconnect
      && !dedicatedResumeHandler
      && !controller
      && task
      && !findAdopter(task)
    ) {
      await waitForDedicatedResumeHandler(taskId);
      task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status === "cancelled" || task.status === "completed") return;
      // A panel may have registered while we waited for vault startup.
      controller = resolveLiveController(taskId);
    }
    // Unified soft pause/resume — process-global, not tied to panel/terminal
    // lifecycle. Controllers only sync local React lists after the store paints.
    if (action === "pause" || action === "resume") {
      const controlHost: TransferControlHost = {
        getTasks: () => tasks,
        setTasks: (next) => {
          tasks = next;
          emit();
        },
        getBridge: defaultTransferControlBridge,
      };
      const notifyOwners = () => {
        for (const controls of controllers.values()) {
          try { controls.syncOwnedTasks?.(); } catch { /* best-effort */ }
        }
      };

      if (action === "pause") {
        await softPauseTransfer(controlHost, taskId);
        notifyOwners();
        return;
      }

      // Soft-resume whenever a walk may still be alive, even if reconnectRequired
      // was set spuriously. Dedicated only when the live stream is truly gone.
      const preferSoft = !needsDedicatedReconnect || isTransferWalkInFlight(taskId);
      if (preferSoft) {
        const soft = await softResumeTransfer(controlHost, taskId);
        if (soft.handled) {
          notifyOwners();
          return;
        }
        if (action === "resume") {
          const reason = soft.reason || "Transfer session is no longer active";
          // Transient / verification soft-misses must NOT hard-reconnect: that
          // rehomes ownerId to dedicated-resume (panel queue disappears) and can
          // race a still-live paused stream → "reconnecting" then stuck paused.
          // "Resume unavailable" / not found = no live bridge stream (restart or
          // tests without a bridge) — those must still hard-reconnect / adopt.
          const streamGone = /no longer active|not active|not found|session is no longer|Resume unavailable|Transfer not found/i
            .test(reason);
          if (!streamGone) {
            tasks = tasks.map((candidate) => candidate.id === taskId ? {
              ...candidate,
              status: "paused" as const,
              reconnectRequired: false,
              speed: 0,
              phase: undefined,
              error: reason,
              pauseUnavailableReason: undefined,
            } : candidate);
            emit();
            notifyOwners();
            return;
          }
          // Soft could not rejoin a dead stream. Demote so the hard reconnect /
          // adopt path below can run even when a stale panel owner remains.
          tasks = tasks.map((candidate) => candidate.id === taskId ? {
            ...candidate,
            status: "interrupted" as const,
            reconnectRequired: true,
            speed: 0,
            phase: undefined,
            error: candidate.error
              ?? `${reason}. Resume will reconnect.`,
          } : candidate);
          emit();
          task = tasks.find((candidate) => candidate.id === taskId);
          controller = undefined;
          notifyOwners();
        }
      }
    }

    // Preferred path after app restart / closed server: open a dedicated SFTP
    // session from vault credentials and continue from the checkpoint. Does not
    // require any UI panel. Single files resume the stream; directories re-walk
    // the tree, skip completed children, and resume partial files.
    const softFailedNeedsHard = action === "resume"
      && !!task
      && task.reconnectRequired === true
      && task.status === "interrupted";
    if (
      (!controller || needsDedicatedReconnect || softFailedNeedsHard)
      && action === "resume"
      && task
      && !task.conflict
      && dedicatedResumeHandler
    ) {
      // Same source+target already writing elsewhere — do not open a second
      // stream into the same destination (.part / rename race).
      const pathConflict = findActivePathConflict(tasks, task);
      if (pathConflict) {
        const conflictError = pathConflictMessage(pathConflict);
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention" as const,
          error: conflictError,
          reconnectRequired: true,
          speed: 0,
          phase: undefined,
        } : candidate);
        emit();
        // Surface exclusivity failures immediately — silent attention rows look
        // like a dead Resume click after path races.
        notify.warning(conflictError, "SFTP");
        return;
      }
      const previousOwnerId = task.ownerId;
      // Detach parent + directory children so publishOwner cannot clobber
      // in-flight dedicated progress with a stale interrupted/paused snapshot.
      tasks = tasks.map((candidate) => {
        if (candidate.id !== taskId && candidate.parentTaskId !== taskId) return candidate;
        if (candidate.id === taskId) {
          return {
            ...candidate,
            ownerId: "dedicated-resume",
            status: "pending" as const,
            error: undefined,
            reconnectRequired: true,
            speed: 0,
            phase: undefined,
            updatedAt: Date.now(),
            lifecycleEpoch: undefined,
          };
        }
        // Re-home children (keep completed status for skip-on-resume).
        return {
          ...candidate,
          ownerId: "dedicated-resume",
          updatedAt: Date.now(),
          lifecycleEpoch: undefined,
        };
      });
      emit();
      const latest = tasks.find((candidate) => candidate.id === taskId) ?? task;
      const result = await dedicatedResumeHandler({
        ...latest,
        ownerId: "dedicated-resume",
        reconnectRequired: true,
      });
      // Cancel/pause may finish while dedicated resume was still reconnecting.
      const afterDedicated = tasks.find((candidate) => candidate.id === taskId);
      if (!afterDedicated || afterDedicated.status === "cancelled") {
        const childIds = tasks
          .filter((candidate) => candidate.parentTaskId === taskId)
          .map((candidate) => candidate.id);
        try { await netcattyBridge.get()?.cancelTransfer?.(taskId); } catch { /* best-effort */ }
        for (const childId of childIds) {
          try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
        }
        const cancelIds = new Set([taskId, ...childIds]);
        tasks = tasks.map((candidate) => cancelIds.has(candidate.id) && candidate.status !== "completed" ? {
          ...candidate,
          status: "cancelled",
          error: undefined,
          endTime: candidate.endTime ?? Date.now(),
          speed: 0,
        } : candidate);
        emit();
        return;
      }
      if (result.success) {
        // Stream / directory finished successfully. Even if the user hit pause
        // during reconnect (status demoted to interrupted), work is done —
        // promote to completed rather than leaving a false interrupted row.
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          ownerId: "dedicated-resume",
          status: "completed",
          transferredBytes: Math.max(
            candidate.transferredBytes,
            candidate.totalBytes || candidate.transferredBytes,
          ),
          speed: 0,
          endTime: Date.now(),
          error: undefined,
          reconnectRequired: false,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
      if (afterDedicated.status === "paused" || afterDedicated.status === "interrupted") {
        // Keep interrupted/paused without calling cancelTransfer — that would
        // poison pendingCancelTransferIds and break a later same-id resume.
        // Finalize any children still marked transferring after abort wind-down.
        const childIds = tasks
          .filter((candidate) => candidate.parentTaskId === taskId
            && ["transferring", "pausing", "pending", "queued"].includes(candidate.status))
          .map((candidate) => candidate.id);
        if (childIds.length > 0) {
          for (const childId of childIds) {
            try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
          }
          tasks = tasks.map((candidate) => childIds.includes(candidate.id) ? {
            ...candidate,
            status: "interrupted",
            speed: 0,
            reconnectRequired: true,
            phase: undefined,
          } : candidate);
          emit();
        }
        return;
      }
      // Abort throws "Transfer cancelled" when shouldAbort (pause/interrupt).
      // Do not force-cancel a row the user already re-activated (transferring/
      // pending after a quick Resume during wind-down).
      const cancelLike = /cancelled|canceled/i.test(result.error || "");
      if (cancelLike) {
        const liveAfter = tasks.find((candidate) => candidate.id === taskId);
        // Soft-unpause may have painted transferring while the held dedicated
        // walk was already dying. If no invocation remains, demote so Resume works.
        if (
          liveAfter
          && ["transferring", "pending", "queued", "paused", "pausing"].includes(liveAfter.status)
        ) {
          if (!resumeInvocations.has(taskId) && liveAfter.status === "transferring") {
            tasks = tasks.map((candidate) => candidate.id === taskId || candidate.parentTaskId === taskId
              ? {
                ...candidate,
                status: candidate.status === "completed" || candidate.status === "cancelled"
                  ? candidate.status
                  : "interrupted" as const,
                speed: 0,
                reconnectRequired: true,
                phase: undefined,
              }
              : candidate);
            emit();
          }
          return;
        }
        const cancelIds = new Set([
          taskId,
          ...tasks.filter((candidate) => candidate.parentTaskId === taskId).map((c) => c.id),
        ]);
        tasks = tasks.map((candidate) => cancelIds.has(candidate.id) && candidate.status !== "completed" ? {
          ...candidate,
          status: "cancelled",
          error: undefined,
          endTime: candidate.endTime ?? Date.now(),
          speed: 0,
          reconnectRequired: false,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
      // Source changed / partial directory attention — keep progress, show retry UI.
      if (result.needsAttention) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          ownerId: "dedicated-resume",
          status: "attention",
          error: result.error,
          reconnectRequired: false,
          speed: 0,
          phase: undefined,
          retryable: true,
          ...(result.resetCheckpoint
            ? { checkpointBytes: 0, transferredBytes: 0 }
            : null),
        } : candidate);
        emit();
        return;
      }
      // Soft failure for server-to-server (needs panel) — restore prior owner
      // so a live controller can still resume, or fall through to adoption.
      if (result.error && /SFTP panel|both hosts/i.test(result.error)) {
        const restoreOwner = previousOwnerId && previousOwnerId !== "dedicated-resume"
          ? previousOwnerId
          : undefined;
        const restoredTask = {
          ...(tasks.find((candidate) => candidate.id === taskId) ?? task),
          ownerId: restoreOwner || "dedicated-resume",
          status: "attention" as const,
          error: result.error,
          reconnectRequired: true,
          speed: 0,
          phase: undefined,
        };
        if (restoreOwner) {
          tasks = tasks.map((candidate) => candidate.id === taskId ? restoredTask : candidate);
          emit();
          controller = controllers.get(restoreOwner);
          // Re-home via adopt (not resume) — the panel dropped the row while
          // ownership was dedicated-resume, so resume would no-op.
          if (controller?.canAdopt?.(restoredTask) && controller.adopt) {
            await controller.adopt({ ...restoredTask, ownerId: restoreOwner, reconnectRequired: true });
            return;
          }
          // Live owner cannot adopt (missing host panes) — clear so prepareAdopter runs.
          controller = undefined;
        }
      } else if (result.error) {
        // A failed directory may have more exception children than the history
        // cap can retain. Keeping its compact skip checkpoint would make an
        // evicted failed child indistinguishable from a compacted completion.
        // Fall back to an explicit fresh Retry: bounded history, no silent skip.
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: candidate.isDirectory ? "failed" : "attention",
          error: result.error,
          reconnectRequired: candidate.isDirectory ? false : true,
          speed: 0,
          phase: undefined,
          ...(candidate.isDirectory ? {
            checkpointBytes: 0,
            directoryResumeCheckpoint: undefined,
            endTime: Date.now(),
          } : null),
        } : candidate);
        emit();
        return;
      }
    }
    if (!controller && action === "resume") {
      const prepared = task ? await prepareAdopter(task) : undefined;
      const adopter = prepared?.adopter;
      const currentTask = tasks.find((candidate) => candidate.id === taskId);
      if (prepared?.cancelled || !currentTask || ["cancelled", "completed"].includes(currentTask.status)) return;
      if (task && adopter) {
        const [adopterId, adopterControls] = adopter;
        // Rehome parent + directory children together so completed child
        // checkpoints survive publishOwner / foreign-owner stripping.
        tasks = tasks.map((candidate) => (
          candidate.id === taskId || candidate.parentTaskId === taskId
            ? { ...candidate, ownerId: adopterId }
            : candidate
        ));
        emit();
        await adopterControls.adopt?.({ ...task, ownerId: adopterId, reconnectRequired: true });
        return;
      }
      if (task) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention",
          error: prepared?.error ?? "Could not reconnect. Check the host credentials and try again.",
          reconnectRequired: true,
        } : candidate);
        emit();
      }
    }
    if (!controller && action === "cancel" && task && ["paused", "interrupted", "attention", "pending", "queued", "transferring", "pausing"].includes(task.status)) {
      const childIds = tasks
        .filter((candidate) => candidate.parentTaskId === taskId)
        .map((candidate) => candidate.id);
      // Stop surviving processTransfer walks immediately (panel-local
      // cancelledTasksRef is gone after unmount).
      markTransferCancelledTree(taskId, childIds);
      releaseTransferPauseTree(taskId, childIds);
      try {
        globalSftpTransferScheduler.cancel(taskId);
        for (const childId of childIds) globalSftpTransferScheduler.cancel(childId);
      } catch {
        // best-effort
      }
      try {
        await netcattyBridge.get()?.cancelTransfer?.(taskId);
        for (const childId of childIds) {
          try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
        }
      } catch {
        // Best-effort backend cancel when the owning panel is gone / no window.
      }
      try {
        await netcattyBridge.get()?.cleanupTransferArtifacts?.({
          transferId: taskId,
          sourcePath: task.sourcePath,
          targetPath: task.targetPath,
          stagedTargetPath: task.stagedTargetPath,
        });
      } catch {
        // best-effort temp/.part cleanup
      }
      const cancelIds = new Set([taskId, ...childIds]);
      tasks = tasks.map((candidate) => cancelIds.has(candidate.id) ? {
        ...candidate,
        status: "cancelled",
        error: undefined,
        endTime: Date.now(),
        speed: 0,
        conflict: undefined,
      } : candidate);
      emit();
      return;
    }
    // pause/resume always handled above (unified soft-control or dedicated).
    // Controllers remain for cancel/retry/prioritize when a live owner exists.
    if (action === "pause" || action === "resume") return;
    controller = resolveLiveController(taskId);
    if (!controller) return;
    await controller[action](taskId);
  };

  const store: SftpTransferCenterStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    getSnapshot: () => ensureSnapshot(),
    getBadgeSnapshot: () => badgeSnapshot,
    admitTaskRun(incoming, pausedAtResume) {
      const rootId = incoming.parentTaskId ?? incoming.id;
      if (isTransferOrRootCancelled(rootId, incoming.id)) return "cancelled";
      const parent = incoming.parentTaskId ? tasks.find((task) => task.id === rootId) : undefined;
      if (parent?.status === "cancelled") return "cancelled";
      const index = tasks.findIndex((task) => task.id === incoming.id);
      const existing = index < 0 ? undefined : tasks[index];
      if (existing && (existing.sourcePath !== incoming.sourcePath || existing.targetPath !== incoming.targetPath
        || existing.parentTaskId !== incoming.parentTaskId)) return "conflict";
      if (existing?.status === "cancelled") return "cancelled";
      if (existing?.status === "completed") {
        return matchesObservedTask(incoming, existing) ? "completed" : "conflict";
      }
      const resumesUnchangedPause = existing === pausedAtResume
        && existing?.status === "paused"
        && (parent?.status === "pending" || parent?.status === "transferring");
      if (isTransferOrRootPauseLatched(rootId, incoming.id)
        || parent?.status === "paused" || parent?.status === "pausing"
        || (existing?.status === "paused" && !resumesUnchangedPause) || existing?.status === "pausing") return "paused";
      if (parent?.status === "completed") return "conflict";
      if (!existing) return "ready";
      if (existing.status === "transferring"
        && existing.directoryEntryIndex === incoming.directoryEntryIndex
        && existing.directoryEntryIdentity === incoming.directoryEntryIdentity) return "ready";
      // Explicit retry may leave failed/interrupted and replace its manifest identity.
      // Do not overwrite byte checkpoints with a delayed renderer snapshot.
      const next = tasks.slice();
      next[index] = {
        ...existing,
        directoryEntryIndex: incoming.directoryEntryIndex,
        directoryEntryIdentity: incoming.directoryEntryIdentity,
        ...(existing.status === "transferring" ? {} : {
          status: "transferring" as const,
          lifecycleEpoch: undefined,
          error: undefined,
          endTime: undefined,
          reconnectRequired: false,
        }),
      };
      tasks = next;
      emitProgress(false);
      return "ready";
    },
    observeTaskSettlement(expected) {
      const observer: { expected: TransferTask; settled?: TransferTask } = { expected: { ...expected } };
      const observers = settlementObservers.get(expected.id) ?? new Set();
      observers.add(observer);
      settlementObservers.set(expected.id, observers);
      let disposed = false;
      return {
        read() {
          if (disposed) return undefined;
          if (observer.settled) return observer.settled;
          const current = tasks.find((task) => task.id === expected.id);
          return current && matchesObservedTask(observer.expected, current) ? current : undefined;
        },
        dispose() {
          disposed = true;
          observer.settled = undefined;
          observers.delete(observer);
          if (observers.size === 0) settlementObservers.delete(expected.id);
        },
      };
    },
    getTask(taskId) {
      return tasks.find((task) => task.id === taskId);
    },
    getOwnerTasks(ownerId) {
      return tasks.filter((task) => task.ownerId === ownerId).map((task) => ({ ...task }));
    },
    publishOwner(ownerId, ownerTasks) {
      const previousTasks = tasks;
      let changed = false;
      let persistImmediately = false;
      const incoming = new Map(ownerTasks.map((task) => [task.id, task]));
      const previousPublished = lastPublishedByOwner.get(ownerId);
      lastPublishedByOwner.set(ownerId, incoming);
      const existingIds = new Set(tasks.map((task) => task.id));
      // Resolve parent status from the store first when runtime owns the walk
      // (panel is view-only for live lifecycle), else prefer the panel snapshot.
      const resolveParentStatus = (parentTaskId: string | undefined): TransferTask["status"] | undefined => {
        if (!parentTaskId) return undefined;
        const storeParent = tasks.find((candidate) => candidate.id === parentTaskId);
        if (
          storeParent
          && (isTransferWalkInFlight(parentTaskId)
            || isTransferPauseLatched(parentTaskId)
            || storeParent.status === "paused"
            || storeParent.status === "pausing")
        ) {
          return storeParent.status;
        }
        return incoming.get(parentTaskId)?.status ?? storeParent?.status;
      };
      tasks = tasks.flatMap((task) => {
        // Tasks reassigned to dedicated-resume (or other owners) are not
        // clobbered by this panel's local snapshot.
        if (task.ownerId !== ownerId) return [task];
        const replacement = incoming.get(task.id);
        if (!replacement) {
          // Runtime-owned live walks keep their store row even when the panel
          // unmounts and stops publishing (no orphan drop of in-flight work).
          if (
            isTransferWalkInFlight(task.id)
            || (task.parentTaskId && isTransferWalkInFlight(task.parentTaskId))
            || isTransferPauseLatched(task.id)
            || (task.parentTaskId && isTransferPauseLatched(task.parentTaskId))
            || task.status === "transferring"
            || task.status === "pausing"
            || task.status === "paused"
            || task.status === "queued"
            || task.status === "pending"
          ) {
            return [task];
          }
          changed = true;
          persistImmediately = true;
          return [];
        }
        // setTransfers keeps unchanged rows by reference. If this exact owner
        // row was already published, the store may only be newer (for example
        // from global progress), so leave it untouched without comparing every
        // field of thousands of directory children.
        if (previousPublished?.get(task.id) === replacement) return [task];
        let merged = mergeOwnerPublishedTask(
          task,
          replacement,
          ownerId,
          resolveParentStatus(replacement.parentTaskId ?? task.parentTaskId),
        );
        // Runtime writer is authority for live walks: panel cannot roll lifecycle
        // back past the process-global control epoch (soft pause/resume).
        const runtimeOwned = isTransferWalkInFlight(task.id)
          || (task.parentTaskId ? isTransferWalkInFlight(task.parentTaskId) : false)
          || isTransferOrRootPauseLatched(task.parentTaskId ?? task.id, task.id);
        if (runtimeOwned) {
          const storeEpoch = Number.isFinite(task.lifecycleEpoch)
            ? (task.lifecycleEpoch as number)
            : getTransferControlEpoch(task.parentTaskId ?? task.id);
          const panelEpoch = Number.isFinite(replacement.lifecycleEpoch)
            ? (replacement.lifecycleEpoch as number)
            : -1;
          if (storeEpoch > panelEpoch) {
            merged = {
              ...merged,
              status: task.status,
              lifecycleEpoch: task.lifecycleEpoch ?? merged.lifecycleEpoch,
              speed: (task.status === "paused" || task.status === "pausing") ? 0 : merged.speed,
              transferredBytes: Math.max(task.transferredBytes ?? 0, merged.transferredBytes ?? 0),
              checkpointBytes: Math.max(task.checkpointBytes ?? 0, merged.checkpointBytes ?? 0),
            };
          }
        }
        if (areTransferTasksEquivalent(task, merged)) return [task];
        if (
          merged.sourceFingerprint !== task.sourceFingerprint
          || (
            merged.status !== task.status
            && (merged.status === "paused" || merged.status === "pausing")
          )
          || (
            merged.status !== task.status
            && !merged.parentTaskId
            && (merged.status === "completed" || merged.status === "failed" || merged.status === "cancelled")
          )
        ) {
          persistImmediately = true;
        }
        changed = true;
        return [merged];
      });
      for (const task of ownerTasks) {
        // Never re-introduce a panel row that already exists under another owner
        // (e.g. completed via dedicated resume while the panel still holds interrupted).
        if (!existingIds.has(task.id)) {
          if (isAlreadyCompactedCompletedChild(task)) continue;
          const parentStatus = resolveParentStatus(task.parentTaskId);
          const parentHoldsPause = parentStatus === "paused" || parentStatus === "pausing";
          const seeded = { ...task, ownerId, updatedAt: task.updatedAt ?? Date.now() };
          if (
            parentHoldsPause
            && !["completed", "cancelled", "failed", "paused", "pausing"].includes(seeded.status)
          ) {
            seeded.status = parentStatus === "pausing" ? "pausing" : "paused";
            seeded.speed = 0;
          }
          tasks.push(seeded);
          if (
            seeded.sourceFingerprint !== undefined
            || seeded.status === "paused"
            || seeded.status === "pausing"
            || (!seeded.parentTaskId && (
              seeded.status === "completed" || seeded.status === "failed" || seeded.status === "cancelled"
            ))
          ) {
            persistImmediately = true;
          }
          changed = true;
        }
      }
      if (!changed) {
        tasks = previousTasks;
        return;
      }
      emit(persistImmediately);
    },
    registerOwner(ownerId, controls) {
      controllers.set(ownerId, controls);
      return () => {
        if (controllers.get(ownerId) === controls) {
          controllers.delete(ownerId);
          lastPublishedByOwner.delete(ownerId);
          settleFinishedTransferControlState(
            tasks.filter((task) => task.ownerId === ownerId),
            tasks,
          );
        }
      };
    },
    setDedicatedResumeHandler(handler) {
      dedicatedResumeHandler = handler;
      notifyDedicatedResumeWaiters();
    },
    patchTask(taskId, updates) {
      const index = tasks.findIndex((task) => task.id === taskId);
      if (index < 0) return;
      const task = tasks[index];
      let changed = false;
      const applyOne = () => {
        // Never resurrect a user-stopped row via dedicated-resume progress.
        if (task.status === "cancelled") return task;
        // Dedicated-owned rows may move pending → transferring while a panel
        // still holds a local interrupted copy that is no longer authoritative.
        // Force-quit continue rehomes to dedicated-resume first; allow that owner
        // (and explicit ownerId updates in the patch) to leave interrupted.
        const nextOwner = updates.ownerId ?? task.ownerId;
        const currentEpoch = Number.isFinite(task.lifecycleEpoch)
          ? (task.lifecycleEpoch as number)
          : -1;
        const incomingEpoch = Number.isFinite(updates.lifecycleEpoch)
          ? (updates.lifecycleEpoch as number)
          : -1;
        const explicitResume = updates.status === "transferring"
          && (incomingEpoch > currentEpoch
            || (incomingEpoch >= currentEpoch && updates.lifecycleEpoch !== undefined)
            || nextOwner === "dedicated-resume"
            || task.ownerId === "dedicated-resume");
        if (
          nextOwner !== "dedicated-resume"
          && task.ownerId !== "dedicated-resume"
          && (task.status === "paused" || task.status === "interrupted")
          && (updates.status === "transferring" || updates.status === "pending" || updates.status === "completed")
          && !explicitResume
        ) {
          return task;
        }
        changed = true;
        const merged = { ...task, ...updates, updatedAt: Date.now() };
        // Soft-drain / walk progress must not move the visible bar after Pause.
        // Latch or paused/pausing freezes transferredBytes/speed unless this patch
        // is an explicit resume (transferring + epoch, or dedicated-resume).
        const pauseHeld = isTransferOrRootPauseLatched(task.parentTaskId ?? task.id, task.id)
          || isTransferPauseLatched(task.id)
          || task.status === "paused"
          || task.status === "pausing"
          || (!!task.parentTaskId && (
            isTransferPauseLatched(task.parentTaskId)
            || (() => {
              const parent = tasks.find((candidate) => candidate.id === task.parentTaskId);
              return parent?.status === "paused" || parent?.status === "pausing";
            })()
          ));
        if (pauseHeld && !explicitResume) {
          // Keep lifecycle at paused/pausing; allow checkpoint metadata only.
          if (task.status === "pausing" || task.status === "paused") {
            merged.status = task.status;
          } else {
            merged.status = "paused";
          }
          merged.transferredBytes = task.transferredBytes;
          merged.speed = 0;
          if (updates.checkpointBytes !== undefined) {
            merged.checkpointBytes = Math.max(
              task.checkpointBytes ?? 0,
              Number(updates.checkpointBytes) || 0,
            );
          } else {
            merged.checkpointBytes = task.checkpointBytes;
          }
          if (updates.resumeStage !== undefined) merged.resumeStage = updates.resumeStage;
          if (updates.downloadCheckpointBytes !== undefined) {
            merged.downloadCheckpointBytes = updates.downloadCheckpointBytes;
          }
          if (updates.uploadCheckpointBytes !== undefined) {
            merged.uploadCheckpointBytes = updates.uploadCheckpointBytes;
          }
          if (updates.sourceFingerprint !== undefined) {
            merged.sourceFingerprint = updates.sourceFingerprint;
          }
          return merged;
        }
        // Dedicated-resume / dual-writer progress must never roll the bar back
        // while the row is still live (force-quit continue freezes at checkpoint
        // if a late lower sample wins).
        if (
          updates.transferredBytes !== undefined
          && !["completed", "cancelled", "failed"].includes(merged.status)
          && (updates.status === "transferring" || merged.status === "transferring" || merged.status === "pausing")
        ) {
          merged.transferredBytes = Math.max(task.transferredBytes ?? 0, Number(updates.transferredBytes) || 0);
        }
        if (
          updates.checkpointBytes !== undefined
          && !["completed", "cancelled", "failed"].includes(merged.status)
        ) {
          merged.checkpointBytes = Math.max(task.checkpointBytes ?? 0, Number(updates.checkpointBytes) || 0);
        }
        return merged;
      };
      const nextTask = applyOne();
      if (!changed || nextTask === task) return;
      const next = tasks.slice();
      next[index] = nextTask;
      tasks = next;
      if (changed) {
        const lifecycleChanged = (
          (updates.status !== undefined && updates.status !== task.status)
          || (updates.error !== undefined && updates.error !== task.error)
          || (updates.endTime !== undefined && updates.endTime !== task.endTime)
          || (updates.conflict !== undefined && updates.conflict !== task.conflict)
          || (
            updates.reconnectRequired !== undefined
            && updates.reconnectRequired !== task.reconnectRequired
          )
        );
        // Only a *new* fingerprint must flush + persist immediately. Progress
        // IPC always echoes the current fingerprint once computed; treating
        // "key present" as critical disabled emitProgress coalesce and re-pegged
        // the renderer (~1 notify per tick during resumable uploads).
        const fingerprintChanged = updates.sourceFingerprint !== undefined
          && updates.sourceFingerprint !== task.sourceFingerprint;
        const directoryCheckpointChanged = Object.prototype.hasOwnProperty.call(
          updates,
          "directoryResumeCheckpoint",
        ) && updates.directoryResumeCheckpoint !== task.directoryResumeCheckpoint;
        if (fingerprintChanged) emit(true);
        else if (directoryCheckpointChanged) emit(true);
        else if (lifecycleChanged) emit();
        else emitProgress(false);
      }
    },
    upsertTasks(incoming) {
      if (incoming.length === 0) return;
      const byId = new Map(incoming.map((task) => [task.id, task]));
      const seen = new Set<string>();
      const parentTerminal = new Map<string, TransferTask["status"]>();
      for (const task of tasks) {
        if (!task.parentTaskId) parentTerminal.set(task.id, task.status);
      }
      tasks = tasks.map((task) => {
        const replacement = byId.get(task.id);
        if (!replacement) return task;
        seen.add(task.id);
        if (task.status === "cancelled" && replacement.status !== "cancelled") return task;
        return { ...task, ...replacement, updatedAt: Date.now() };
      });
      for (const task of incoming) {
        if (seen.has(task.id)) continue;
        if (isAlreadyCompactedCompletedChild(task)) continue;
        // Do not resurrect work under a cancelled/completed directory parent.
        if (task.parentTaskId) {
          const parentStatus = parentTerminal.get(task.parentTaskId)
            ?? tasks.find((candidate) => candidate.id === task.parentTaskId)?.status;
          if (parentStatus === "cancelled" || parentStatus === "completed") continue;
        }
        tasks.push({ ...task, updatedAt: task.updatedAt ?? Date.now() });
      }
      emit();
    },
    canControl(taskId) {
      const ownerId = findOwner(taskId);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return false;
      const hasLiveOwner = !!ownerId && controllers.has(ownerId);
      if (hasLiveOwner) return true;
      // After restart (or panel unmount) unfinished tasks stay in the store with
      // no owner controller. The global center must still be able to resume,
      // cancel, or dismiss them — otherwise they become dead rows.
      const terminal = task.status === "completed" || task.status === "cancelled";
      // Failed rows stay controllable so orphan Retry/Resume can still run after restart.
      if (!terminal && task.status !== "failed") return true;
      if (task.status === "failed") return true;
      return !!(task && [...controllers.values()].some((controls) => (
        controls.adopt && controls.canAdopt?.(task)
      )));
    },
    pause: (taskId) => invoke(taskId, "pause"),
    async resume(taskId) {
      const startFresh = () => {
        const running = invoke(taskId, "resume").finally(() => {
          if (resumeInvocations.get(taskId) === running) resumeInvocations.delete(taskId);
        });
        resumeInvocations.set(taskId, running);
        return running;
      };

      const existing = resumeInvocations.get(taskId);
      if (existing) {
        // Dedicated resume holds the invocation for the full stream lifetime.
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (task?.status === "cancelled") return existing;

        // Soft-unpause live backend streams when still paused under a held run.
        // Dedicated *directory* walks treat status===paused as shouldAbort between
        // files, so soft-rejoin is unsafe (dying promise + false transferring).
        // Wind down soft-paused children then startFresh from checkpoints.
        // Single-file dedicated (and non-directory live streams) soft-unpause.
        if (task && (task.status === "paused" || task.status === "pausing")) {
          const childIds = tasks
            .filter((candidate) => candidate.parentTaskId === taskId
              && (candidate.status === "paused"
                || candidate.status === "pausing"
                || candidate.status === "transferring"))
            .map((candidate) => candidate.id);

          // Always clear process-global latches + control epoch so walks wake and
          // late soft-drain / pauseWatch cannot re-pause streams. Do not stamp
          // control epoch as task.lifecycleEpoch (bridge-aligned only).
          bumpTransferControlEpoch(taskId);
          releaseTransferPauseTree(taskId, childIds);

          if (task.ownerId === "dedicated-resume" && task.isDirectory) {
            const bridge = netcattyBridge.get();
            // Cancel soft-paused child streams so the held walk settles. When a
            // child is not in activeTransfers, cancelTransfer leaves a sticky
            // pendingCancel latch — clear it before startFresh reuses the same
            // child transferIds (otherwise startStreamTransfer aborts immediately).
            for (const id of childIds) {
              try { await bridge?.cancelTransfer?.(id); } catch { /* best-effort wind-down */ }
              try { await bridge?.clearPendingTransferCancel?.(id); } catch { /* best-effort */ }
            }
            try { await bridge?.clearPendingTransferCancel?.(taskId); } catch { /* best-effort */ }
            try {
              await existing;
            } catch { /* previous aborted / cancelled */ }
            // Clear again after wind-down in case cancel raced during await.
            for (const id of childIds) {
              try { await bridge?.clearPendingTransferCancel?.(id); } catch { /* best-effort */ }
            }
            try { await bridge?.clearPendingTransferCancel?.(taskId); } catch { /* best-effort */ }
            return resumeInvocations.get(taskId) ?? startFresh();
          }

          try {
            const resumeIds = [taskId, ...childIds.filter((id) => id !== taskId)];
            const results = await Promise.all(resumeIds.map(async (id) =>
              netcattyBridge.get()?.resumeTransfer?.(id) ?? { success: false },
            ));
            const after = tasks.find((candidate) => candidate.id === taskId);
            if (after?.status === "cancelled") return existing;
            // Only rejoin when at least one backend stream actually resumed.
            // Empty/all-fail must not paint transferring over a dead held run.
            const successIds = resumeIds.filter((_, index) => results[index]?.success);
            if (successIds.length > 0) {
              const resumed = new Set(successIds);
              // Align with softResumeTransfer: prefer bridge lifecycleEpoch; clear
              // if omitted so main-process progress is not stale-dropped.
              let bridgeEpoch: number | undefined;
              for (let index = 0; index < results.length; index += 1) {
                if (!results[index]?.success) continue;
                const epoch = (results[index] as { lifecycleEpoch?: number } | undefined)?.lifecycleEpoch;
                if (!Number.isFinite(epoch)) continue;
                bridgeEpoch = bridgeEpoch === undefined
                  ? (epoch as number)
                  : Math.max(bridgeEpoch, epoch as number);
              }
              tasks = tasks.map((candidate) => {
                if (candidate.id === taskId || resumed.has(candidate.id)) {
                  return {
                    ...candidate,
                    status: "transferring" as const,
                    error: undefined,
                    reconnectRequired: false,
                    pauseUnavailableReason: undefined,
                    phase: undefined,
                    lifecycleEpoch: bridgeEpoch,
                  };
                }
                return candidate;
              });
              emit();
              return existing;
            }
          } catch {
            // Fall through to await + restart.
          }
          try {
            await existing;
          } catch { /* previous aborted */ }
          return resumeInvocations.get(taskId) ?? startFresh();
        }

        // After demotion to interrupted/attention/failed while work unwinds:
        // wait then re-invoke (do not rejoin a dying canceling promise).
        if (task && (task.status === "interrupted" || task.status === "attention" || task.status === "failed")) {
          try {
            await existing;
          } catch { /* previous aborted */ }
          return resumeInvocations.get(taskId) ?? startFresh();
        }
        return existing;
      }
      return startFresh();
    },
    cancel: (taskId) => invoke(taskId, "cancel"),
    async retry(taskId) {
      const ownerId = findOwner(taskId);
      const task = tasks.find((candidate) => candidate.id === taskId);
      // The background-agent controller can only reopen an SFTP channel on the
      // original terminal session. Failed rows survive an app restart but that
      // session id does not, so Retry must take the same fresh dedicated path
      // as any other restored task. Pause/resume of a still-live backend stream
      // remains handled by invoke() and the process-global bridge controls.
      const controller = ownerId === "background-agent"
        ? undefined
        : controllers.get(ownerId ?? "");
      if (controller) {
        await controller.retry(taskId);
        return;
      }
      // Orphaned after restart: clear checkpoint so Retry truly restarts, then
      // resume (dedicated or adopt) from byte 0.
      if (task) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "interrupted",
          error: undefined,
          checkpointBytes: 0,
          transferredBytes: 0,
          downloadCheckpointBytes: undefined,
          uploadCheckpointBytes: undefined,
          resumeStage: undefined,
          sourceFingerprint: undefined,
          reconnectRequired: true,
          speed: 0,
          endTime: undefined,
          lifecycleEpoch: undefined,
        } : candidate);
        emit();
        try {
          await netcattyBridge.get()?.cleanupTransferArtifacts?.({
            transferId: taskId,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            stagedTargetPath: task.stagedTargetPath,
          });
        } catch {
          // best-effort
        }
      }
      await this.resume(taskId);
    },
    async prioritize(taskId) {
      const ownerId = findOwner(taskId);
      const controller = controllers.get(ownerId ?? "");
      if (controller) {
        void controller.prioritize(taskId);
        return;
      }
      // Orphan: still bump store priority and ask backend / renderer scheduler.
      tasks = tasks.map((candidate) => candidate.id === taskId
        ? { ...candidate, priority: Date.now(), updatedAt: Date.now() }
        : candidate);
      emit();
      try {
        void netcattyBridge.get()?.prioritizeTransfer?.(taskId);
      } catch {
        // best-effort
      }
      try {
        globalSftpTransferScheduler.prioritize(taskId);
      } catch {
        // Scheduler may be empty in pure node tests.
      }
    },
    async resolveConflict(taskId, action, applyToAll) {
      let ownerId = findOwner(taskId);
      let controller = controllers.get(ownerId ?? "");
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!controller && task) {
        const prepared = await prepareAdopter(task);
        if (prepared.cancelled) return;
        const adopter = prepared.adopter;
        if (!adopter) {
          tasks = tasks.map((candidate) => candidate.id === taskId ? {
            ...candidate,
            status: "attention",
            error: prepared.error ?? "Could not open an SFTP panel to resolve this conflict.",
            reconnectRequired: true,
          } : candidate);
          emit();
          return;
        }
        const [adopterId, adopterControls] = adopter;
        const current = tasks.find((candidate) => candidate.id === taskId);
        if (!current || current.status === "cancelled" || current.status === "completed") return;
        ownerId = adopterId;
        controller = adopterControls;
        tasks = tasks.map((candidate) => candidate.id === taskId ? { ...candidate, ownerId: adopterId } : candidate);
        emit();
        await adopterControls.adopt?.({ ...current, ownerId: adopterId });
        const afterAdopt = tasks.find((candidate) => candidate.id === taskId);
        if (!afterAdopt || afterAdopt.status === "cancelled") return;
      }
      await controller?.resolveConflict?.(taskId, action, applyToAll);
    },
    dismiss(taskId) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const ownerId = task?.ownerId;
      const controller = ownerId ? controllers.get(ownerId) : undefined;
      if (controller) {
        controller.dismiss(taskId, task);
      }
      const removing = tasks.filter((candidate) => (
        candidate.id === taskId || candidate.parentTaskId === taskId
      ));
      settleFinishedTransferControlState(removing, removing);
      tasks = tasks.filter((task) => task.id !== taskId && task.parentTaskId !== taskId);
      emit(true);
    },
    clearTerminal(status) {
      const terminal = new Set<TransferTask["status"]>(["completed", "failed", "cancelled"]);
      const unfinishedParents = new Set(
        tasks.filter((task) => !terminal.has(task.status)).map((task) => task.id),
      );
      // Do not wipe completed children of an unfinished directory parent —
      // those rows are resume checkpoints, not disposable history.
      const removing = tasks.filter((task) =>
        terminal.has(task.status)
        && (status === undefined || task.status === status)
        && !(task.parentTaskId && unfinishedParents.has(task.parentTaskId)),
      );
      const removingIds = new Set(removing.map((task) => task.id));
      settleFinishedTransferControlState(removing, removing);
      tasks = tasks.filter((task) => !removingIds.has(task.id) && !removingIds.has(task.parentTaskId ?? ""));
      emit(true);
      notifyOwnersOfPrunedTasks(removing);
    },
    markReconnectRequired(taskId, error) {
      tasks = tasks.map((task) => task.id === taskId ? {
        ...task,
        status: "attention",
        error: error ?? "The original server connection is unavailable",
        reconnectRequired: true,
        speed: 0,
        lifecycleEpoch: undefined,
      } : task);
      emit();
    },
    reportResumePreparationFailure(taskId, error) {
      resumePreparationFailures.set(taskId, error);
    },
    ingestBackgroundEvent(event) {
      if (restoreMigrationPending && !replayingRestoreEvents) {
        const pending = backgroundEventsDuringRestore.get(event.transferId) ?? [];
        pending.push({ sequence: restoreEventSequence, event: { ...event } });
        restoreEventSequence += 1;
        backgroundEventsDuringRestore.set(event.transferId, pending);
        return;
      }
      let existing = tasks.find((task) => task.id === event.transferId);
      const eventParent = event.parentTaskId
        ? tasks.find((task) => task.id === event.parentTaskId)
        : undefined;
      // Hot reload / mixed-version delivery can leave an already-created child
      // looking like a top-level background row. The first hierarchy-aware
      // event repairs it in place instead of leaving a duplicate control row.
      if (existing && eventParent && existing.parentTaskId !== event.parentTaskId) {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          ownerId: eventParent.ownerId ?? task.ownerId,
          parentTaskId: event.parentTaskId,
          directoryEntryIndex: event.directoryEntryIndex ?? task.directoryEntryIndex,
          directoryEntryIdentity: event.directoryEntryIdentity ?? task.directoryEntryIdentity,
          background: false,
        } : task);
        existing = tasks.find((task) => task.id === event.transferId);
      }
      // A delayed child progress event can arrive after the renderer compacted
      // that completed child into its parent checkpoint. Never resurrect it as
      // a live row, especially after the parent itself has finished.
      if (!existing && eventParent) {
        if (["completed", "failed", "cancelled"].includes(eventParent.status)) return;
        const covered = eventParent.directoryResumeCheckpoint?.coveredEntries ?? 0;
        if (
          Number.isSafeInteger(event.directoryEntryIndex)
          && (event.directoryEntryIndex ?? covered) < covered
        ) return;
      }
      const persistImmediately = event.type === "paused"
        || event.type === "pausing"
        || (
          !existing?.parentTaskId
          && (event.type === "completed" || event.type === "failed" || event.type === "cancelled")
        )
        || (event.sourceFingerprint !== undefined && event.sourceFingerprint !== existing?.sourceFingerprint);
      const terminal = existing
        && (existing.status === "cancelled" || existing.status === "completed" || existing.status === "failed");
      // Never resurrect a finished/cancelled agent row with late queued/progress.
      if (terminal && event.type !== "cancelled") {
        // Allow a late explicit cancel to stick; ignore everything else.
        if (event.type === "completed" || event.type === "failed") {
          // Keep existing terminal state (prefer cancelled over late completed).
          return;
        }
        if (event.type === "queued" || event.type === "started" || event.type === "progress" || event.type === "pausing" || event.type === "resumed" || event.type === "paused") {
          return;
        }
      }
      if (existing && event.type === "progress") {
        const parent = existing.parentTaskId
          ? tasks.find((task) => task.id === existing.parentTaskId)
          : undefined;
        const pauseHeld = existing.status === "paused"
          || existing.status === "pausing"
          || parent?.status === "paused"
          || parent?.status === "pausing"
          || isTransferOrRootPauseLatched(existing.parentTaskId ?? existing.id, existing.id)
          || isTransferPauseLatched(existing.id);
        const lifecycleStatus = event.lifecycleState === "paused"
          ? "paused"
          : event.lifecycleState === "pausing"
            ? "pausing"
            : event.lifecycleState === "queued"
              ? "queued"
              : "transferring";
        const sameLifecycle = event.lifecycleState === undefined
          ? existing.status === "transferring"
          : existing.status === lifecycleStatus;
        const sameOptional = <T>(incoming: T | undefined, current: T | undefined) => (
          incoming === undefined || incoming === current
        );
        if (
          !pauseHeld
          && sameLifecycle
          && existing.error === undefined
          && existing.endTime === undefined
          && sameOptional(event.transferred, existing.transferredBytes)
          && sameOptional(event.totalBytes, existing.totalBytes)
          && sameOptional(event.speed, existing.speed)
          && sameOptional(event.checkpointBytes, existing.checkpointBytes)
          && sameOptional(event.resumeStage, existing.resumeStage)
          && sameOptional(event.downloadCheckpointBytes, existing.downloadCheckpointBytes)
          && sameOptional(event.uploadCheckpointBytes, existing.uploadCheckpointBytes)
          && sameOptional(event.sourceFingerprint, existing.sourceFingerprint)
          && sameOptional(event.phase, existing.phase)
          && sameOptional(event.lifecycleEpoch, existing.lifecycleEpoch)
          && sameOptional(event.resumable, existing.resumable)
          && sameOptional(event.pauseUnavailableReason, existing.pauseUnavailableReason)
        ) {
          return;
        }
      }
      if ((event.type === "queued" || event.type === "started" || event.type === "progress") && !existing) {
        const sourcePath = event.sourcePath ?? "";
        const targetPath = event.targetPath ?? "";
        tasks.push({
          id: event.transferId,
          ownerId: eventParent?.ownerId
            ?? (event.controlKind === "compressed-upload" ? "background-transfer" : "background-agent"),
          fileName: event.fileName ?? (
            targetPath.split(/[\\/]/).pop()
            || sourcePath.split(/[\\/]/).pop()
            || event.transferId
          ),
          sourcePath,
          targetPath,
          sourceConnectionId: event.direction === "upload" ? "local" : (event.sessionId ?? "agent"),
          targetConnectionId: event.direction === "download" ? "local" : (event.sessionId ?? "agent"),
          sourceHostId: event.sourceHostId,
          targetHostId: event.targetHostId,
          parentTaskId: event.parentTaskId,
          directoryEntryIndex: event.directoryEntryIndex,
          directoryEntryIdentity: event.directoryEntryIdentity,
          direction: event.direction ?? "upload",
          status: event.type === "queued" ? "queued" : "transferring",
          totalBytes: event.totalBytes ?? 0,
          transferredBytes: event.transferred ?? 0,
          speed: event.speed ?? 0,
          startTime: event.startedAt ?? Date.now(),
          isDirectory: event.isDirectory ?? false,
          origin: "agent",
          background: !event.parentTaskId,
          resumable: event.resumable ?? true,
          pauseUnavailableReason: event.pauseUnavailableReason,
          controlKind: event.controlKind,
          phase: event.phase,
          lifecycleEpoch: event.lifecycleEpoch,
        });
      } else if (existing && (event.type === "queued" || event.type === "started")) {
        tasks = tasks.map((task) => {
          if (task.id !== event.transferId) return task;
          const currentEpoch = Number.isFinite(task.lifecycleEpoch) ? (task.lifecycleEpoch as number) : -1;
          const incomingEpoch = Number.isFinite(event.lifecycleEpoch) ? (event.lifecycleEpoch as number) : -1;
          const acceptsLifecycle = task.lifecycleEpoch === undefined
            ? true
            : event.lifecycleEpoch !== undefined && incomingEpoch >= currentEpoch;
          return {
            ...task,
            status: acceptsLifecycle
              ? (event.type === "queued" ? "queued" : "transferring")
              : task.status,
            error: acceptsLifecycle ? undefined : task.error,
            endTime: acceptsLifecycle ? undefined : task.endTime,
            fileName: event.fileName ?? task.fileName,
            totalBytes: event.totalBytes ?? task.totalBytes,
            isDirectory: event.isDirectory ?? task.isDirectory,
            controlKind: event.controlKind ?? task.controlKind,
            parentTaskId: event.parentTaskId ?? task.parentTaskId,
            directoryEntryIndex: event.directoryEntryIndex ?? task.directoryEntryIndex,
            directoryEntryIdentity: event.directoryEntryIdentity ?? task.directoryEntryIdentity,
            background: event.parentTaskId ? false : task.background,
            phase: event.phase ?? task.phase,
            resumable: event.resumable ?? task.resumable,
            pauseUnavailableReason: event.pauseUnavailableReason ?? task.pauseUnavailableReason,
            lifecycleEpoch: acceptsLifecycle && event.lifecycleEpoch !== undefined
              ? event.lifecycleEpoch
              : task.lifecycleEpoch,
          };
        });
      } else if (existing && event.type === "progress") {
        tasks = tasks.map((task) => {
          if (task.id !== event.transferId) return task;
          // Main-process progress must re-open a live bar even if the panel is
          // hidden and no longer painting "transferring" via React callbacks.
          const nextTransferred = event.transferred === undefined
            ? task.transferredBytes
            : Math.max(task.transferredBytes ?? 0, Number(event.transferred) || 0);
          const currentEpoch = Number.isFinite(task.lifecycleEpoch) ? (task.lifecycleEpoch as number) : -1;
          const incomingEpoch = Number.isFinite(event.lifecycleEpoch) ? (event.lifecycleEpoch as number) : -1;
          const staleLifecycle = task.lifecycleEpoch !== undefined
            && (event.lifecycleEpoch === undefined || incomingEpoch < currentEpoch);
          if (staleLifecycle) return task;
          const acceptsLifecycle = incomingEpoch >= currentEpoch;
          const lifecycleStatus = event.lifecycleState === "paused"
            ? "paused"
            : event.lifecycleState === "pausing"
              ? "pausing"
              : event.lifecycleState === "queued"
                ? "queued"
                : "transferring";
          // Soft-drain continues writing after Pause, but the bar must freeze as
          // soon as the user asked to pause. Only an explicit resume (higher
          // epoch + transferring) may move bytes again.
          // Also freeze children when the folder parent is paused/latched — otherwise
          // soft-drain progress re-opens them as "transferring" and the collapsed
          // current-file row blinks in and out under an already-paused parent.
          const parentRow = task.parentTaskId
            ? tasks.find((candidate) => candidate.id === task.parentTaskId)
            : undefined;
          const parentHoldsPause = !!parentRow && (
            parentRow.status === "paused"
            || parentRow.status === "pausing"
            || isTransferPauseLatched(parentRow.id)
          );
          const selfLatched = isTransferOrRootPauseLatched(
            task.parentTaskId ?? task.id,
            task.id,
          ) || isTransferPauseLatched(task.id);
          const uiPauseLatched = task.status === "paused"
            || task.status === "pausing"
            || parentHoldsPause
            || selfLatched;
          const explicitResume = lifecycleStatus === "transferring"
            && event.lifecycleEpoch !== undefined
            && incomingEpoch > currentEpoch;
          if (uiPauseLatched && !explicitResume) {
            const nextCheckpoint = Math.max(
              task.checkpointBytes ?? 0,
              Number(event.checkpointBytes) || 0,
            );
            const holdStatus = event.lifecycleState === "paused" && acceptsLifecycle
              ? "paused" as const
              : (task.status === "paused" || task.status === "pausing"
                ? task.status
                : parentHoldsPause
                  ? (parentRow!.status === "pausing" ? "pausing" as const : "paused" as const)
                  : "pausing" as const);
            return {
              ...task,
              // Keep pausing until backend confirms paused; never flip back to
              // transferring from soft-drain progress.
              status: holdStatus,
              speed: 0,
              checkpointBytes: nextCheckpoint || task.checkpointBytes,
              resumeStage: event.resumeStage ?? task.resumeStage,
              downloadCheckpointBytes: event.downloadCheckpointBytes ?? task.downloadCheckpointBytes,
              uploadCheckpointBytes: event.uploadCheckpointBytes ?? task.uploadCheckpointBytes,
              sourceFingerprint: event.sourceFingerprint ?? task.sourceFingerprint,
              resumable: event.resumable ?? task.resumable,
              pauseUnavailableReason: event.pauseUnavailableReason ?? task.pauseUnavailableReason,
              updatedAt: Date.now(),
              lifecycleEpoch: acceptsLifecycle && event.lifecycleEpoch !== undefined
                ? event.lifecycleEpoch
                : task.lifecycleEpoch,
            };
          }
          const nextStatus = event.lifecycleEpoch !== undefined && acceptsLifecycle
            ? lifecycleStatus
            : task.lifecycleEpoch === undefined
              ? ((task.status === "paused" || task.status === "pausing") ? task.status : "transferring")
              : task.status;
          const keepPaused = nextStatus === "paused" || nextStatus === "pausing";
          return {
            ...task,
            status: nextStatus,
            transferredBytes: keepPaused ? task.transferredBytes : nextTransferred,
            totalBytes: event.totalBytes === undefined
              ? task.totalBytes
              : Math.max(task.totalBytes ?? 0, Number(event.totalBytes) || 0),
            speed: keepPaused ? 0 : (event.speed ?? task.speed),
            checkpointBytes: event.checkpointBytes === undefined
              ? task.checkpointBytes
              : Math.max(task.checkpointBytes ?? 0, Number(event.checkpointBytes) || 0),
            resumeStage: event.resumeStage ?? task.resumeStage,
            downloadCheckpointBytes: event.downloadCheckpointBytes ?? task.downloadCheckpointBytes,
            uploadCheckpointBytes: event.uploadCheckpointBytes ?? task.uploadCheckpointBytes,
            sourceFingerprint: event.sourceFingerprint ?? task.sourceFingerprint,
            phase: event.phase ?? task.phase,
            resumable: event.resumable ?? task.resumable,
            pauseUnavailableReason: event.pauseUnavailableReason ?? task.pauseUnavailableReason,
            error: keepPaused ? task.error : undefined,
            endTime: undefined,
            // A single-file dedicated resume reports bytes through the global
            // main-process event stream, not the dedicated renderer callback.
            // The first accepted live progress proves reconnect is over; keep
            // no stale reconnect flag that would hide the Pause action forever.
            reconnectRequired: task.ownerId === "dedicated-resume"
              && lifecycleStatus === "transferring"
              ? false
              : task.reconnectRequired,
            updatedAt: Date.now(),
            lifecycleEpoch: acceptsLifecycle && event.lifecycleEpoch !== undefined
              ? event.lifecycleEpoch
              : task.lifecycleEpoch,
          };
        });
        if (event.resumable === false && existing.parentTaskId) {
          tasks = tasks.map((task) => task.id === existing.parentTaskId ? {
            ...task,
            resumable: false,
            pauseUnavailableReason: event.pauseUnavailableReason ?? task.pauseUnavailableReason,
          } : task);
        }
      } else if (existing && (event.type === "pausing" || event.type === "paused" || event.type === "resumed")) {
        tasks = tasks.map((task) => {
          if (task.id !== event.transferId) return task;
          const currentEpoch = Number.isFinite(task.lifecycleEpoch) ? (task.lifecycleEpoch as number) : -1;
          const incomingEpoch = Number.isFinite(event.lifecycleEpoch) ? (event.lifecycleEpoch as number) : -1;
          const acceptsLifecycle = task.lifecycleEpoch === undefined
            ? true
            : event.lifecycleEpoch !== undefined && incomingEpoch >= currentEpoch;
          return {
            ...task,
            status: acceptsLifecycle
              ? (event.type === "pausing" ? "pausing" : event.type === "paused" ? "paused" : "transferring")
              : task.status,
            speed: acceptsLifecycle && event.type !== "resumed" ? 0 : task.speed,
            checkpointBytes: event.checkpointBytes ?? task.checkpointBytes,
            resumeStage: event.resumeStage ?? task.resumeStage,
            downloadCheckpointBytes: event.downloadCheckpointBytes ?? task.downloadCheckpointBytes,
            uploadCheckpointBytes: event.uploadCheckpointBytes ?? task.uploadCheckpointBytes,
            sourceFingerprint: event.sourceFingerprint ?? task.sourceFingerprint,
            phase: event.phase ?? task.phase,
            lifecycleEpoch: acceptsLifecycle && event.lifecycleEpoch !== undefined
              ? event.lifecycleEpoch
              : task.lifecycleEpoch,
          };
        });
      } else if (existing && event.type !== "started") {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          status: event.type === "completed" ? "completed" : event.type === "cancelled" ? "cancelled" : "failed",
          transferredBytes: event.transferred === undefined
            ? task.transferredBytes
            : Math.max(task.transferredBytes ?? 0, Number(event.transferred) || 0),
          totalBytes: event.totalBytes === undefined
            ? task.totalBytes
            : Math.max(task.totalBytes ?? 0, Number(event.totalBytes) || 0),
          checkpointBytes: event.checkpointBytes === undefined
            ? task.checkpointBytes
            : Math.max(task.checkpointBytes ?? 0, Number(event.checkpointBytes) || 0),
          error: event.error,
          endTime: event.endedAt ?? Date.now(),
          speed: 0,
          reconnectRequired: event.type === "failed" ? task.reconnectRequired : false,
          phase: undefined,
        } : task);
      }
      // Progress-only ticks skip prune + coalesce listener paints; lifecycle
      // events still take the full emit path so UI never lags on pause/cancel.
      if (event.type === "progress" && !persistImmediately) {
        emitProgress(false);
      } else {
        emit(persistImmediately);
      }
    },
  };

  if (shouldRestoreCooperatively && persistedRaw) {
    void restoreSftpTransferHistoryCooperatively(persistedRaw).then((migrated) => {
      const replayBufferedBackgroundEvents = () => {
        const buffered = [...backgroundEventsDuringRestore.values()]
          .flat()
          .sort((left, right) => left.sequence - right.sequence);
        backgroundEventsDuringRestore.clear();
        if (buffered.length === 0) return;
        replayingRestoreEvents = true;
        deferRestoreReplayEmits = true;
        try {
          for (const { event } of buffered) store.ingestBackgroundEvent(event);
        } finally {
          deferRestoreReplayEmits = false;
          replayingRestoreEvents = false;
        }
      };
      if (!migrated.valid) {
        replayBufferedBackgroundEvents();
        restoreMigrationPending = false;
        // Preserve invalid/unsupported source data unless a live mutation must
        // be made durable. This mirrors the old best-effort restore behavior.
        if (snapshotDirty || persistenceDirty) emit(true);
        else writePersistence();
        return;
      }

      // New transfers may have arrived while the old snapshot was migrating.
      // Keep the live row for an ID collision, then run the canonical bounded
      // prune once more over the now-small merged result.
      const liveIds = new Set(tasks.map((task) => task.id));
      tasks = pruneSftpTransferHistory([
        ...migrated.tasks.filter((task) => !liveIds.has(task.id)),
        ...tasks,
      ]);
      replayBufferedBackgroundEvents();
      restoreMigrationPending = false;
      emit(true);
    }).catch((error) => {
      const buffered = [...backgroundEventsDuringRestore.values()]
        .flat()
        .sort((left, right) => left.sequence - right.sequence);
      backgroundEventsDuringRestore.clear();
      replayingRestoreEvents = true;
      deferRestoreReplayEmits = true;
      try {
        for (const { event } of buffered) store.ingestBackgroundEvent(event);
      } finally {
        deferRestoreReplayEmits = false;
        replayingRestoreEvents = false;
      }
      restoreMigrationPending = false;
      console.warn("[SFTP] Could not migrate legacy transfer history", error);
      // Do not erase the legacy value on a migration failure. Only flush if a
      // live task mutation was already waiting for durability.
      if (snapshotDirty || persistenceDirty) emit(true);
      else writePersistence();
    });
  }

  return store;
}

const browserPersistence: StorePersistence | undefined = typeof globalThis.localStorage === "undefined"
  ? undefined
  : {
      read: () => globalThis.localStorage.getItem(STORAGE_KEY_SFTP_TRANSFER_CENTER),
      write: (value) => { localStorageAdapter.writeString(STORAGE_KEY_SFTP_TRANSFER_CENTER, value); },
    };

export const sftpTransferCenterStore = createSftpTransferCenterStore(browserPersistence);

export function useSftpTransferCenter(): SftpTransferCenterSnapshot {
  return useSyncExternalStore(
    sftpTransferCenterStore.subscribe,
    sftpTransferCenterStore.getSnapshot,
    sftpTransferCenterStore.getSnapshot,
  );
}

/** Badge only — stable when counts are unchanged so TopTabs does not re-render every progress byte. */
export function useSftpTransferCenterBadge(): { count: number; hasAttention: boolean } {
  return useSyncExternalStore(
    sftpTransferCenterStore.subscribe,
    sftpTransferCenterStore.getBadgeSnapshot,
    sftpTransferCenterStore.getBadgeSnapshot,
  );
}

/**
 * Live row from the transfer center store. Progress ticks patch the store without
 * re-rendering the whole SFTP panel via setTransfersState — queue rows subscribe
 * here so bars/spinners still move.
 */
export function useSftpTransferTask(taskId: string, fallback: TransferTask): TransferTask {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  return useSyncExternalStore(
    sftpTransferCenterStore.subscribeProgress,
    () => sftpTransferCenterStore.getTask(taskId) ?? fallbackRef.current,
    () => fallbackRef.current,
  );
}
