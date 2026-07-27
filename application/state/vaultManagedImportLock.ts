type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const fallbackTails = new Map<string, Promise<void>>();
/**
 * Tracks whether *this window* currently owns the lock after acquiring it
 * through `withVaultImportLock`. Used so nested helpers can skip a second
 * acquire (Web Locks are not re-entrant) without letting independent concurrent
 * work bypass the queue.
 */
const heldDepth = new Map<string, number>();

function lockNameFor(key: string): string {
  return `netcatty:vault-import:${key}`;
}

export function isVaultImportLockHeld(key: string): boolean {
  return (heldDepth.get(lockNameFor(key)) ?? 0) > 0;
}

/**
 * Run `run` while holding the shared vault lock.
 *
 * Concurrent callers in the same window are serialized. Nested helpers that are
 * already inside an outer critical section must use `withVaultImportLockIfNeeded`
 * (or check `isVaultImportLockHeld`) so they do not request the same lock again.
 */
export async function withVaultImportLock<T>(
  key: string,
  run: () => Promise<T>,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  const lockName = lockNameFor(key);

  const execute = async (): Promise<T> => {
    heldDepth.set(lockName, (heldDepth.get(lockName) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const next = (heldDepth.get(lockName) ?? 1) - 1;
      if (next <= 0) heldDepth.delete(lockName);
      else heldDepth.set(lockName, next);
    }
  };

  if (lockManager) return lockManager.request(lockName, execute);
  if (typeof window !== "undefined") {
    throw new Error("Cross-window Vault import locking is unavailable");
  }

  const previous = fallbackTails.get(lockName) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  fallbackTails.set(lockName, tail);
  await previous;
  try {
    return await execute();
  } finally {
    release();
    if (fallbackTails.get(lockName) === tail) fallbackTails.delete(lockName);
  }
}

/** Acquire the lock only when this window does not already own it. */
export async function withVaultImportLockIfNeeded<T>(
  key: string,
  run: () => Promise<T>,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  if (isVaultImportLockHeld(key)) return run();
  return withVaultImportLock(key, run, lockManager);
}
