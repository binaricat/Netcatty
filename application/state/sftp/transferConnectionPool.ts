/**
 * Transfer channel pool (FileZilla-style concurrency, not a second SSH stack).
 *
 * Bulk transfers share the main-process SSH transport registry. This pool only
 * limits how many SFTP channels (sftpIds) may be open per host for parallel
 * transfers, and reuses a busy-vs-idle slot within that cap.
 *
 * A released channel stays available for a short bounded idle window so a
 * directory of sequential small files does not reopen one SFTP channel per
 * file. The global idle cap prevents many visited hosts from retaining an
 * unbounded number of channels; SSH transports remain owned by the unified
 * main-process registry.
 */

export const DEFAULT_TRANSFER_CONNECTIONS_PER_HOST = 2;
export const MIN_TRANSFER_CONNECTIONS_PER_HOST = 1;
export const MAX_TRANSFER_CONNECTIONS_PER_HOST = 4;

export const DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS = 5_000;
export const DEFAULT_MAX_IDLE_TRANSFER_CONNECTIONS = 16;

export type TransferPoolOpenFn = (poolKey: string) => Promise<string>;
export type TransferPoolCloseFn = (sftpId: string) => void | Promise<void>;
export type TransferPoolSessionLeaseFn = (sftpId: string, leaseId: string) => void | Promise<void>;

export interface TransferConnectionLease {
  sftpId: string;
  poolKey: string;
  /** Drop the holder count; last holder enters the short idle park. */
  release: () => void;
  /** Drop holder, remove from pool, and close — use when the session is dead. */
  discard: () => void;
}

interface PoolSlot {
  sftpId: string;
  /** Main-process hold that keeps this SFTP channel alive between child files. */
  sessionLeaseId: string;
  holders: Set<string>;
  lastUsedAt: number;
  idleSince?: number;
  idleOrder?: number;
  idleTimer?: unknown;
  /** Session is dead; do not hand out to new transfers. Close when idle. */
  unhealthy?: boolean;
  opening?: Promise<string>;
}

export interface TransferConnectionPoolOptions {
  maxPerHost?: number;
  idleTtlMs?: number;
  /** Global cap across all host pools; oldest idle channels are evicted first. */
  maxIdleConnections?: number;
  closeSession?: TransferPoolCloseFn;
  retainSession?: TransferPoolSessionLeaseFn;
  releaseSession?: TransferPoolSessionLeaseFn;
  now?: () => number;
  /** Deterministic timer hooks for tests. */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface TransferPoolKeyInput {
  hostId?: string;
  hostname?: string;
  port?: number;
  username?: string;
  protocol?: string;
  sftpSudo?: boolean;
  /** Full resolved transport identity; kept private inside the in-memory pool. */
  connectionOptions?: NetcattySSHOptions;
}

export interface TransferPoolKeyCache {
  get(host: object, createInput: () => TransferPoolKeyInput): Promise<string>;
}

/**
 * Resolving a transfer identity includes credential expansion and SHA-256.
 * Directory transfers may acquire a lease once per file, so cache that work
 * by the immutable Host object for the lifetime of the current vault inputs.
 */
export function createTransferPoolKeyCache(
  build: (input: TransferPoolKeyInput) => Promise<string> = buildTransferPoolKey,
): TransferPoolKeyCache {
  const cache = new WeakMap<object, Promise<string>>();
  return {
    get(host, createInput) {
      const existing = cache.get(host);
      if (existing) return existing;
      const pending = Promise.resolve().then(() => build(createInput()));
      cache.set(host, pending);
      void pending.catch(() => {
        if (cache.get(host) === pending) cache.delete(host);
      });
      return pending;
    },
  };
}

export interface TransferConnectionPool {
  acquire(poolKey: string, transferId: string, open: TransferPoolOpenFn): Promise<TransferConnectionLease>;
  release(poolKey: string, sftpId: string, transferId: string): void;
  /** Remove a dead session from the pool and close it (best-effort). */
  discard(sftpId: string): void;
  getStats(poolKey?: string): {
    poolKeys: number;
    connections: number;
    busy: number;
    idle: number;
    holders: number;
    pendingOpenLocks: number;
  };
  /** Close channels whose idle deadline has passed. */
  closeIdle(now?: number): Promise<number>;
  closeAll(): Promise<void>;
  setMaxPerHost(max: number): void;
  setIdleTtlMs(ms: number): void;
  getIdleTtlMs(): number;
}

function normalizeMaxPerHost(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_TRANSFER_CONNECTIONS_PER_HOST;
  return Math.min(
    MAX_TRANSFER_CONNECTIONS_PER_HOST,
    Math.max(MIN_TRANSFER_CONNECTIONS_PER_HOST, value as number),
  );
}

function normalizeIdleTtlMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS;
  if (!Number.isFinite(value)) return DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxIdleConnections(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_IDLE_TRANSFER_CONNECTIONS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_IDLE_TRANSFER_CONNECTIONS;
  return Math.max(0, Math.floor(value));
}

export function createTransferConnectionPool(
  options: TransferConnectionPoolOptions = {},
): TransferConnectionPool {
  let maxPerHost = normalizeMaxPerHost(options.maxPerHost);
  let idleTtlMs = normalizeIdleTtlMs(options.idleTtlMs);
  const maxIdleConnections = normalizeMaxIdleConnections(options.maxIdleConnections);
  const closeSession = options.closeSession;
  const retainSession = options.retainSession;
  const releaseSession = options.releaseSession;
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let nextIdleOrder = 1;

  /** poolKey -> open slots for that host endpoint */
  const pools = new Map<string, PoolSlot[]>();
  /** Serialize opens per host so we never exceed maxPerHost under concurrency */
  const openLocks = new Map<string, Promise<void>>();

  const getList = (poolKey: string): PoolSlot[] => {
    let list = pools.get(poolKey);
    if (!list) {
      list = [];
      pools.set(poolKey, list);
    }
    return list;
  };

  const withOpenLock = async <T>(poolKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = openLocks.get(poolKey) ?? Promise.resolve();
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
    // Chain waiters so concurrent acquires never exceed maxPerHost.
    const tail = previous.catch(() => {}).then(() => gate);
    openLocks.set(poolKey, tail);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      releaseLock();
      // A later waiter replaces our tail. Only the last waiter may remove the
      // per-host serialization entry, otherwise concurrent opens can overlap.
      if (openLocks.get(poolKey) === tail) openLocks.delete(poolKey);
    }
  };

  const clearIdleTimer = (slot: PoolSlot) => {
    if (slot.idleTimer === undefined) return;
    clearTimeoutFn(slot.idleTimer);
    slot.idleTimer = undefined;
  };

  const detachSlot = (poolKey: string, list: PoolSlot[], idx: number): PoolSlot | undefined => {
    const [slot] = list.splice(idx, 1);
    if (slot) clearIdleTimer(slot);
    if (list.length === 0) pools.delete(poolKey);
    else pools.set(poolKey, list);
    return slot;
  };

  const closeSlot = async (slot: PoolSlot) => {
    if (releaseSession) {
      try {
        await releaseSession(slot.sftpId, slot.sessionLeaseId);
      } catch {
        // best-effort; the explicit close below is still required
      }
    }
    try {
      await closeSession?.(slot.sftpId);
    } catch {
      // best-effort
    }
  };

  const closeSessionBestEffort = (slot: PoolSlot) => {
    void closeSlot(slot);
  };

  const removeAndCloseSlot = (poolKey: string, list: PoolSlot[], idx: number) => {
    const slot = detachSlot(poolKey, list, idx);
    if (slot) {
      closeSessionBestEffort(slot);
    }
  };

  const createRetainedSlot = async (sftpId: string, transferId: string): Promise<PoolSlot> => {
    const sessionLeaseId = `pool:${sftpId}`;
    try {
      await retainSession?.(sftpId, sessionLeaseId);
    } catch (error) {
      try { await closeSession?.(sftpId); } catch { /* best-effort */ }
      throw error;
    }
    return {
      sftpId,
      sessionLeaseId,
      holders: new Set([transferId]),
      lastUsedAt: now(),
    };
  };

  const scheduleIdleClose = (poolKey: string, slot: PoolSlot, delayMs?: number) => {
    clearIdleTimer(slot);
    if (slot.holders.size > 0) return;
    const list = pools.get(poolKey);
    const idx = list?.indexOf(slot) ?? -1;
    if (!list || idx < 0) return;
    if (slot.unhealthy || idleTtlMs <= 0) {
      removeAndCloseSlot(poolKey, list, idx);
      return;
    }

    const remaining = delayMs ?? Math.max(0, (slot.idleSince ?? now()) + idleTtlMs - now());
    if (remaining <= 0) {
      removeAndCloseSlot(poolKey, list, idx);
      return;
    }
    const handle = setTimeoutFn(() => {
      slot.idleTimer = undefined;
      const currentList = pools.get(poolKey);
      const currentIdx = currentList?.indexOf(slot) ?? -1;
      if (!currentList || currentIdx < 0 || slot.holders.size > 0) return;
      const deadline = (slot.idleSince ?? slot.lastUsedAt) + idleTtlMs;
      const remainingAtFire = deadline - now();
      if (remainingAtFire > 0) {
        scheduleIdleClose(poolKey, slot, remainingAtFire);
        return;
      }
      removeAndCloseSlot(poolKey, currentList, currentIdx);
    }, remaining);
    slot.idleTimer = handle;
    const maybeTimer = handle as { unref?: () => void } | null;
    maybeTimer?.unref?.();
  };

  const enforceGlobalIdleCap = () => {
    const idleSlots: Array<{ poolKey: string; slot: PoolSlot }> = [];
    for (const [poolKey, list] of pools.entries()) {
      for (const slot of list) {
        if (slot.holders.size === 0) idleSlots.push({ poolKey, slot });
      }
    }
    idleSlots.sort((left, right) => {
      if (left.slot.lastUsedAt !== right.slot.lastUsedAt) {
        return left.slot.lastUsedAt - right.slot.lastUsedAt;
      }
      return (left.slot.idleOrder ?? 0) - (right.slot.idleOrder ?? 0);
    });
    for (let index = 0; index < idleSlots.length - maxIdleConnections; index += 1) {
      const candidate = idleSlots[index]!;
      const currentList = pools.get(candidate.poolKey);
      const currentIdx = currentList?.indexOf(candidate.slot) ?? -1;
      if (currentList && currentIdx >= 0 && candidate.slot.holders.size === 0) {
        removeAndCloseSlot(candidate.poolKey, currentList, currentIdx);
      }
    }
  };

  const pickSlot = (list: PoolSlot[]): PoolSlot | null => {
    // Never hand out sessions marked dead by a prior discard.
    const healthy = list.filter((slot) => !slot.unhealthy);
    if (healthy.length === 0) return null;
    // Prefer idle connections, else least-loaded (FileZilla-style multiplexing).
    const sorted = [...healthy].sort((a, b) => {
      if (a.holders.size !== b.holders.size) return a.holders.size - b.holders.size;
      return a.lastUsedAt - b.lastUsedAt;
    });
    return sorted[0] ?? null;
  };

  const release = (poolKey: string, sftpId: string, transferId: string) => {
    const list = pools.get(poolKey);
    if (!list) return;
    const idx = list.findIndex((candidate) => candidate.sftpId === sftpId);
    if (idx < 0) return;
    const slot = list[idx]!;
    if (!slot.holders.delete(transferId)) return;
    slot.lastUsedAt = now();
    if (slot.holders.size === 0) {
      if (slot.unhealthy) {
        removeAndCloseSlot(poolKey, list, idx);
        return;
      }
      slot.idleSince = slot.lastUsedAt;
      slot.idleOrder = nextIdleOrder;
      nextIdleOrder += 1;
      scheduleIdleClose(poolKey, slot, idleTtlMs);
      enforceGlobalIdleCap();
    }
  };

  /**
   * Mark a session unusable for new work. Only closes the underlying session
   * when no other holders remain — multiplexed siblings must not be killed.
   */
  const discard = (sftpId: string, options?: { transferId?: string }) => {
    if (!sftpId) return;
    for (const [poolKey, list] of pools.entries()) {
      const idx = list.findIndex((slot) => slot.sftpId === sftpId);
      if (idx < 0) continue;
      const slot = list[idx]!;
      if (options?.transferId) slot.holders.delete(options.transferId);
      slot.unhealthy = true;
      slot.lastUsedAt = now();
      if (slot.holders.size > 0) {
        // Peers still using this socket; close when the last one releases.
        return;
      }
      removeAndCloseSlot(poolKey, list, idx);
      return;
    }
  };

  const makeLease = (poolKey: string, sftpId: string, transferId: string): TransferConnectionLease => ({
    sftpId,
    poolKey,
    release: () => release(poolKey, sftpId, transferId),
    discard: () => discard(sftpId, { transferId }),
  });

  const acquire = async (
    poolKey: string,
    transferId: string,
    open: TransferPoolOpenFn,
  ): Promise<TransferConnectionLease> => {
    if (!poolKey) throw new Error("Transfer pool key is required");
    if (!transferId) throw new Error("Transfer id is required");

    return withOpenLock(poolKey, async () => {
      const list = getList(poolKey);
      // Count only healthy slots toward the open budget; unhealthy ones drain
      // as holders leave and should not block opening a replacement connection.
      const healthyCount = list.filter((slot) => !slot.unhealthy).length;
      const existing = pickSlot(list);
      // Reuse when we already have max healthy connections, or when an idle one exists.
      // FileZilla-style: open a second connection only when the first is busy.
      // Idle slots are available during the short reuse window.
      if (existing && (existing.holders.size === 0 || healthyCount >= maxPerHost)) {
        clearIdleTimer(existing);
        existing.idleSince = undefined;
        existing.idleOrder = undefined;
        existing.holders.add(transferId);
        existing.lastUsedAt = now();
        return makeLease(poolKey, existing.sftpId, transferId);
      }

      if (healthyCount < maxPerHost) {
        let sftpId: string;
        try {
          sftpId = await open(poolKey);
        } catch (error) {
          // getList() installs the per-host array before opening. A failed
          // connection must not leave one empty key behind forever in the
          // process-wide pool (notably when many different hosts are tried).
          if (list.length === 0 && pools.get(poolKey) === list) {
            pools.delete(poolKey);
          }
          throw error;
        }
        const slot = await createRetainedSlot(sftpId, transferId);
        // The last holder of the old list can release while open() is awaiting,
        // which removes that empty list from `pools`. Re-read/recreate the
        // canonical list before publishing the new slot; otherwise the lease is
        // returned from a detached array and can never be released or closed.
        getList(poolKey).push(slot);
        return makeLease(poolKey, sftpId, transferId);
      }

      // Should be unreachable when maxPerHost >= 1, but keep safe fallback.
      const fallback = pickSlot(list);
      if (!fallback) {
        const sftpId = await open(poolKey);
        const slot = await createRetainedSlot(sftpId, transferId);
        list.push(slot);
        return makeLease(poolKey, sftpId, transferId);
      }
      fallback.holders.add(transferId);
      clearIdleTimer(fallback);
      fallback.idleSince = undefined;
      fallback.idleOrder = undefined;
      fallback.lastUsedAt = now();
      return makeLease(poolKey, fallback.sftpId, transferId);
    });
  };

  const closeIdle = async (sweepNow = now()): Promise<number> => {
    const toClose: PoolSlot[] = [];
    for (const [poolKey, list] of pools.entries()) {
      const kept: PoolSlot[] = [];
      for (const slot of list) {
        const expired = slot.holders.size === 0
          && (slot.unhealthy || idleTtlMs <= 0 || (slot.idleSince ?? slot.lastUsedAt) + idleTtlMs <= sweepNow);
        if (expired) {
          clearIdleTimer(slot);
          toClose.push(slot);
          continue;
        }
        kept.push(slot);
      }
      if (kept.length === 0) pools.delete(poolKey);
      else pools.set(poolKey, kept);
    }
    let closed = 0;
    for (const slot of toClose) {
      closed += 1;
      await closeSlot(slot);
    }
    return closed;
  };

  const closeAll = async () => {
    const toClose = [...pools.values()].flatMap((list) => list);
    pools.clear();
    for (const slot of toClose) clearIdleTimer(slot);
    for (const slot of toClose) {
      await closeSlot(slot);
    }
  };

  const getStats = (poolKey?: string) => {
    const lists = poolKey ? [pools.get(poolKey) ?? []] : [...pools.values()];
    let connections = 0;
    let busy = 0;
    let idle = 0;
    let holders = 0;
    for (const list of lists) {
      for (const slot of list) {
        connections += 1;
        holders += slot.holders.size;
        if (slot.holders.size > 0) busy += 1;
        else idle += 1;
      }
    }
    const pendingOpenLocks = poolKey
      ? (openLocks.has(poolKey) ? 1 : 0)
      : openLocks.size;
    return { poolKeys: pools.size, connections, busy, idle, holders, pendingOpenLocks };
  };

  return {
    acquire,
    release,
    discard,
    getStats,
    closeIdle,
    closeAll,
    setMaxPerHost(max: number) {
      maxPerHost = normalizeMaxPerHost(max);
    },
    setIdleTtlMs(ms: number) {
      idleTtlMs = normalizeIdleTtlMs(ms);
      for (const [poolKey, list] of [...pools.entries()]) {
        for (const slot of [...list]) {
          if (slot.holders.size > 0) continue;
          scheduleIdleClose(
            poolKey,
            slot,
            Math.max(0, (slot.idleSince ?? slot.lastUsedAt) + idleTtlMs - now()),
          );
        }
      }
      enforceGlobalIdleCap();
    },
    getIdleTtlMs() {
      return idleTtlMs;
    },
  };
}

/** Shared process-wide pool used by SFTP bulk transfers in the renderer. */
let sharedPool: TransferConnectionPool | null = null;

/**
 * Process-wide transfer channel pool (FileZilla-style, max 2 sftpIds per host).
 * `closeSession` is applied on first creation; later callers share the same pool.
 */
export function getSharedTransferConnectionPool(
  options?: TransferConnectionPoolOptions,
): TransferConnectionPool {
  if (!sharedPool) {
    sharedPool = createTransferConnectionPool({
      maxPerHost: DEFAULT_TRANSFER_CONNECTIONS_PER_HOST,
      ...options,
    });
  }
  return sharedPool;
}

/** Test-only: drop the singleton so tests start clean. */
export function resetSharedTransferConnectionPoolForTests(): void {
  sharedPool = null;
}

/** Deterministic serializer shared by the pool key and the route identity. */
const stableSerialize = (value: unknown): string => {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "sessionId")
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
};

/**
 * Secret fields never contribute to the persisted route identity
 * (`buildTransferRouteKey`). Their digests could act as offline verifiers for
 * credential guesses if the route identity leaks through localStorage-backed
 * transfer history (Codex P2 on PR #3516). `command` is included because a
 * command proxy's `ProxyCommand` line routinely embeds credentials (password
 * prompts, tokens), and the vault itself treats command-proxy contents as
 * secret; a rotated proxy command therefore no longer changes the route
 * identity, which is acceptable for a persistable value. Non-secret identity
 * references (auth method, keyId, keySource, identity file paths) stay in so a
 * credential *switch* still changes the route identity.
 */
const TRANSFER_ROUTE_SECRET_KEYS: ReadonlySet<string> = new Set([
  "password",
  "privateKey",
  "passphrase",
  "certificate",
  "sudoAutofillPassword",
  "command",
]);

const stripTransferRouteSecrets = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripTransferRouteSecrets);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (TRANSFER_ROUTE_SECRET_KEYS.has(key)) continue;
    out[key] = stripTransferRouteSecrets(item);
  }
  return out;
};

const transferIdentityBase = (input: TransferPoolKeyInput): string => {
  const port = input.port || 22;
  const user = input.username || "root";
  const protocol = input.protocol || "ssh";
  const sudo = input.sftpSudo ? "sudo" : "nosudo";
  const ep = `${input.hostname}:${port}:${user}:${protocol}:${sudo}`;
  return input.hostId ? `host:${input.hostId}|ep:${ep}` : `ep:${ep}`;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export async function buildTransferPoolKey(input: TransferPoolKeyInput): Promise<string> {
  // Include endpoint identity whenever hostname is known so session-time
  // hostname/port/username overrides do not share a pool with the vault host.
  if (input.hostname) {
    const base = transferIdentityBase(input);
    if (!input.connectionOptions) return base;
    return `${base}|identity:${await sha256Hex(stableSerialize(input.connectionOptions))}`;
  }
  if (input.hostId) return `host:${input.hostId}`;
  return "ep:unknown:22:root:ssh:nosudo";
}

/**
 * Persistable route identity for the download source-route guard. Same
 * endpoint base as the pool key, but the digest covers only non-secret
 * endpoint/proxy attributes so it can survive in localStorage-backed transfer
 * history without exposing a credential-derived verifier (Codex P2 on
 * PR #3516).
 */
export async function buildTransferRouteKey(input: TransferPoolKeyInput): Promise<string> {
  if (!input.hostname) return input.hostId ? `host:${input.hostId}` : "route:unknown";
  const base = transferIdentityBase(input);
  if (!input.connectionOptions) return base;
  return `${base}|route:${await sha256Hex(stableSerialize(stripTransferRouteSecrets(input.connectionOptions)))}`;
}
