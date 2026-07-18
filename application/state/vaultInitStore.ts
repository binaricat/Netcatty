let vaultInitialized = false;
let vaultInitializationError: Error | null = null;
const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

export function isVaultInitialized(): boolean {
  return vaultInitialized;
}

export function setVaultInitialized(value: boolean): void {
  vaultInitialized = value;
  if (!value) {
    vaultInitializationError = null;
    return;
  }
  vaultInitializationError = null;
  for (const waiter of readyWaiters) waiter.resolve();
  readyWaiters.clear();
}

export function setVaultInitializationFailed(error: unknown): void {
  vaultInitializationError = error instanceof Error ? error : new Error(String(error));
  for (const waiter of readyWaiters) waiter.reject(vaultInitializationError);
  readyWaiters.clear();
}

/** Wait until encrypted vault fields have finished decrypting into memory. */
export function waitForVaultInitialized(): Promise<void> {
  if (vaultInitialized) return Promise.resolve();
  if (vaultInitializationError) return Promise.reject(vaultInitializationError);
  return new Promise((resolve, reject) => readyWaiters.add({ resolve, reject }));
}
