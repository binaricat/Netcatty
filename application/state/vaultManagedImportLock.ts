type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const fallbackTails = new Map<string, Promise<void>>();
/** Same-window re-entrancy depth. Web Locks are not re-entrant across nested awaits. */
const heldDepth = new Map<string, number>();

function lockNameFor(key: string): string {
  return `netcatty:vault-import:${key}`;
}

export function isVaultImportLockHeld(key: string): boolean {
  return (heldDepth.get(lockNameFor(key)) ?? 0) > 0;
}

export async function withVaultImportLock<T>(
  key: string,
  run: () => Promise<T>,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  const lockName = lockNameFor(key);
  const depth = heldDepth.get(lockName) ?? 0;
  if (depth > 0) {
    heldDepth.set(lockName, depth + 1);
    try {
      return await run();
    } finally {
      const next = (heldDepth.get(lockName) ?? 1) - 1;
      if (next <= 0) heldDepth.delete(lockName);
      else heldDepth.set(lockName, next);
    }
  }

  const execute = async (): Promise<T> => {
    heldDepth.set(lockName, 1);
    try {
      return await run();
    } finally {
      heldDepth.delete(lockName);
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
