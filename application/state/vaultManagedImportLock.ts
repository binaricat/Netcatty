type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const fallbackTails = new Map<string, Promise<void>>();

export async function withVaultImportLock<T>(
  key: string,
  run: () => Promise<T>,
  lockManager: LockManagerLike | null | undefined = (
    typeof navigator === "undefined" ? undefined : navigator.locks
  ),
): Promise<T> {
  const lockName = `netcatty:vault-import:${key}`;
  if (lockManager) return lockManager.request(lockName, run);
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
    return await run();
  } finally {
    release();
    if (fallbackTails.get(lockName) === tail) fallbackTails.delete(lockName);
  }
}
