/**
 * Process-wide pause latches for SFTP transfers.
 *
 * Must outlive any React owner (SFTP panel / vault page). Directory walks and
 * stream workers wait on these latches; the global transfer center sets them
 * on Pause and clears them on Resume whether or not a panel is mounted.
 */

const pausedIds = new Set<string>();
const barriers = new Map<string, { promise: Promise<void>; resolve: () => void }>();
// A completed child's history row can disappear while its worker still waits
// for the folder to resume. Keep the paused tree independent of UI history.
const pausedChildren = new Map<string, Set<string>>();

function ensureBarrier(taskId: string): { promise: Promise<void>; resolve: () => void } {
  let barrier = barriers.get(taskId);
  if (barrier) return barrier;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  barrier = { promise, resolve };
  barriers.set(taskId, barrier);
  return barrier;
}

export function isTransferPauseLatched(taskId: string): boolean {
  return pausedIds.has(taskId);
}

export function isTransferOrRootPauseLatched(rootTaskId: string, taskId?: string): boolean {
  return pausedIds.has(rootTaskId) || (!!taskId && pausedIds.has(taskId));
}

/** Latch pause for a task id. Idempotent; creates a waiter barrier. */
export function latchTransferPause(taskId: string): void {
  pausedIds.add(taskId);
  ensureBarrier(taskId);
}

/** Release pause and wake every waiter. Idempotent. */
export function releaseTransferPause(taskId: string): void {
  pausedIds.delete(taskId);
  const barrier = barriers.get(taskId);
  if (!barrier) return;
  barriers.delete(taskId);
  barrier.resolve();
}

export function releaseTransferPauseTree(rootTaskId: string, childIds: readonly string[] = []): void {
  const children = new Set([...childIds, ...(pausedChildren.get(rootTaskId) ?? [])]);
  pausedChildren.delete(rootTaskId);
  releaseTransferPause(rootTaskId);
  for (const id of children) releaseTransferPause(id);
}

export function latchTransferPauseTree(rootTaskId: string, childIds: readonly string[] = []): void {
  if (childIds.length > 0) {
    const children = pausedChildren.get(rootTaskId) ?? new Set<string>();
    for (const id of childIds) children.add(id);
    pausedChildren.set(rootTaskId, children);
  }
  latchTransferPause(rootTaskId);
  for (const id of childIds) latchTransferPause(id);
}

export async function waitUntilTransferPauseReleased(taskId: string): Promise<void> {
  while (pausedIds.has(taskId)) {
    const barrier = ensureBarrier(taskId);
    await barrier.promise;
  }
}

export async function waitWhileTransferOrRootPaused(
  rootTaskId: string,
  taskId?: string,
): Promise<void> {
  while (isTransferOrRootPauseLatched(rootTaskId, taskId)) {
    const latchId = pausedIds.has(rootTaskId) ? rootTaskId : (taskId as string);
    await waitUntilTransferPauseReleased(latchId);
  }
}

/** Test helper — clear all latches between cases. */
export function resetTransferPauseLatchesForTests(): void {
  const ids = [...pausedIds];
  for (const id of ids) releaseTransferPause(id);
  pausedIds.clear();
  barriers.clear();
  pausedChildren.clear();
}

export function listTransferPauseLatchesForTests(): string[] {
  return [...pausedIds].sort();
}
