import type { TransferStatus, TransferTask } from "../../domain/models";

export const DEDICATED_RESUME_LARGE_HISTORY_THRESHOLD = 4_096;
export const DEDICATED_RESUME_CHILD_UPDATE_BATCH_SIZE = 512;

export interface DedicatedResumeChildUpdateBatcher {
  push(task: TransferTask): void;
  discard(taskId: string): void;
  flush(): void;
}

export interface DedicatedResumeProgressBatcher<T> {
  push(progress: T): void;
  finish(): void;
}

/**
 * A restarted directory can retain tens of thousands of exception rows. The
 * store intentionally performs full history compaction on each upsert, so
 * feeding it one child transition at a time becomes quadratic. Keep only the
 * latest state for each retained child and compact in fixed-size batches.
 */
export function createDedicatedResumeChildUpdateBatcher(deps: {
  getTaskCount: () => number;
  hasTask: (taskId: string) => boolean;
  upsertTasks: (tasks: readonly TransferTask[]) => void;
}): DedicatedResumeChildUpdateBatcher {
  const pending = new Map<string, TransferTask>();
  const flush = () => {
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    deps.upsertTasks(batch);
  };
  return {
    push(task) {
      const shouldBatch = !!task.parentTaskId
        && deps.getTaskCount() >= DEDICATED_RESUME_LARGE_HISTORY_THRESHOLD
        && deps.hasTask(task.id);
      if (!shouldBatch) {
        deps.upsertTasks([task]);
        return;
      }
      pending.set(task.id, task);
      if (pending.size >= DEDICATED_RESUME_CHILD_UPDATE_BATCH_SIZE) flush();
    },
    discard: (taskId) => { pending.delete(taskId); },
    flush,
  };
}

/** Only rows still owned by an active resume may accept a deferred rAF sample. */
export function canApplyDedicatedResumeProgress(status: TransferStatus): boolean {
  return status === "pending" || status === "queued" || status === "transferring";
}

/**
 * Coalesce renderer progress without letting a callback outlive the resume
 * invocation that scheduled it. finish() preserves the newest sample once,
 * cancels the scheduled paint, and permanently rejects late callbacks.
 */
export function createDedicatedResumeProgressBatcher<T>(deps: {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  canApply: () => boolean;
  apply: (progress: T) => void;
}): DedicatedResumeProgressBatcher<T> {
  let pending: T | undefined;
  let frame: number | null = null;
  let finished = false;

  const applyPending = () => {
    const progress = pending;
    pending = undefined;
    if (progress !== undefined && deps.canApply()) deps.apply(progress);
  };
  const flushFrame = () => {
    frame = null;
    if (finished) return;
    applyPending();
  };

  return {
    push(progress) {
      if (finished) return;
      pending = progress;
      if (frame == null) frame = deps.requestFrame(flushFrame);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (frame != null) {
        deps.cancelFrame(frame);
        frame = null;
      }
      // Preserve the final durable checkpoint while the row is still active.
      // The caller can now publish its completed/failed/attention result with
      // no scheduled callback left that could overwrite the terminal state.
      applyPending();
    },
  };
}
