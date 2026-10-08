/**
 * Process-global registry of live processTransfer walks (directory or file).
 *
 * Survives SFTP panel / terminal-tab unmount so the global transfer center can
 * soft-resume a still-running walk instead of starting a second dedicated walk.
 */

const inFlightRootIds = new Set<string>();
const settlementWaiters = new Map<string, Set<() => void>>();

export function registerTransferWalk(rootTaskId: string): void {
  inFlightRootIds.add(rootTaskId);
}

export function unregisterTransferWalk(rootTaskId: string): void {
  inFlightRootIds.delete(rootTaskId);
  const waiters = settlementWaiters.get(rootTaskId);
  settlementWaiters.delete(rootTaskId);
  for (const resolve of waiters ?? []) resolve();
}

export function isTransferWalkInFlight(rootTaskId: string): boolean {
  return inFlightRootIds.has(rootTaskId);
}

/** Wait for the current walk to finish; cancellation must not resume a dying walk. */
export function waitForTransferWalkSettled(rootTaskId: string): Promise<void> {
  if (!inFlightRootIds.has(rootTaskId)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = settlementWaiters.get(rootTaskId) ?? new Set();
    waiters.add(resolve);
    settlementWaiters.set(rootTaskId, waiters);
  });
}

/** Test helper. */
export function resetTransferWalkRegistryForTests(): void {
  for (const id of inFlightRootIds) unregisterTransferWalk(id);
}

export function listTransferWalksForTests(): string[] {
  return [...inFlightRootIds].sort();
}
