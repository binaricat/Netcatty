type VaultInitializationState =
  | { status: "initializing" }
  | { status: "ready" }
  | { status: "failed"; error: Error };

export type VaultInitializationLease = symbol;

let vaultInitialized = false;
let vaultInitializationError: Error | null = null;
const initializationLeases = new Map<VaultInitializationLease, VaultInitializationState>();
const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

const publishLeaseState = (): void => {
  if ([...initializationLeases.values()].some(({ status }) => status === "ready")) {
    setVaultInitialized(true);
    return;
  }

  vaultInitialized = false;
  const hasInitializingLease = [...initializationLeases.values()]
    .some(({ status }) => status === "initializing");
  if (hasInitializingLease || initializationLeases.size === 0) {
    vaultInitializationError = null;
    return;
  }

  const failure = [...initializationLeases.values()]
    .find((state): state is Extract<VaultInitializationState, { status: "failed" }> =>
      state.status === "failed");
  if (failure) setVaultInitializationFailed(failure.error);
};

export function beginVaultInitialization(): VaultInitializationLease {
  const lease = Symbol("vault-initialization");
  initializationLeases.set(lease, { status: "initializing" });
  publishLeaseState();
  return lease;
}

export function completeVaultInitialization(lease: VaultInitializationLease): void {
  if (!initializationLeases.has(lease)) return;
  initializationLeases.set(lease, { status: "ready" });
  publishLeaseState();
}

export function failVaultInitialization(lease: VaultInitializationLease, error: unknown): void {
  if (!initializationLeases.has(lease)) return;
  initializationLeases.set(lease, {
    status: "failed",
    error: error instanceof Error ? error : new Error(String(error)),
  });
  publishLeaseState();
}

export function releaseVaultInitialization(lease: VaultInitializationLease): void {
  if (!initializationLeases.delete(lease)) return;
  publishLeaseState();
}

export function isVaultInitialized(): boolean {
  return vaultInitialized;
}

// Kept as the direct publication primitive for non-React callers and focused tests.
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
  vaultInitialized = false;
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
