type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const fallbackTails = new Map<string, Promise<void>>();

/**
 * Opaque handle granted only to the callback that currently owns the vault
 * lock. Nested helpers must receive this handle to continue under the same
 * critical section; independent concurrent work cannot invent one.
 */
export type VaultLockHandle = {
  readonly key: string;
  readonly token: symbol;
};

const activeHandleByKey = new Map<string, VaultLockHandle>();

function lockNameFor(key: string): string {
  return `netcatty:vault-import:${key}`;
}

export function isVaultImportLockHeld(key: string): boolean {
  return activeHandleByKey.has(key);
}

export function isActiveVaultLockHandle(
  key: string,
  handle: VaultLockHandle | null | undefined,
): boolean {
  if (!handle || handle.key !== key) return false;
  return activeHandleByKey.get(key) === handle;
}

/**
 * Run `run` while holding the shared vault lock.
 *
 * Concurrent callers are always serialized. Nested work must receive the
 * returned handle and pass it to `withVaultImportLockIfNeeded` — a bare
 * "is held" check is intentionally not enough to skip the queue.
 */
export async function withVaultImportLock<T>(
  key: string,
  run: (lock: VaultLockHandle) => Promise<T>,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  const lockName = lockNameFor(key);

  const execute = async (): Promise<T> => {
    const handle: VaultLockHandle = {
      key,
      token: Symbol(`vault-lock:${key}`),
    };
    activeHandleByKey.set(key, handle);
    try {
      return await run(handle);
    } finally {
      if (activeHandleByKey.get(key) === handle) activeHandleByKey.delete(key);
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

/**
 * Continue under an outer critical section when `lock` is the active handle;
 * otherwise acquire the shared lock for this independent caller.
 */
export async function withVaultImportLockIfNeeded<T>(
  key: string,
  run: (lock: VaultLockHandle) => Promise<T>,
  lock?: VaultLockHandle | null,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  if (isActiveVaultLockHandle(key, lock)) {
    return run(lock as VaultLockHandle);
  }
  return withVaultImportLock(key, run, lockManager);
}
