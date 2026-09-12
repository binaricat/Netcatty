import { useCallback, useEffect, useMemo, useState } from "react";
import { Host, Identity, KnownHost, PortForwardingRule, SSHKey } from "../../domain/models";
import {
  migratePortForwardingRulesFromStorage,
  toPersistedPortForwardingRules,
} from "../../domain/portForwardingPersistence";
import { getNextVaultOrder, normalizeVaultOrder, reorderVaultItems, sortByVaultOrder, type VaultOrderPosition } from "../../domain/vaultOrder";
import {
  STORAGE_KEY_PF_PREFER_FORM_MODE,
  STORAGE_KEY_PF_VIEW_MODE,
  STORAGE_KEY_PORT_FORWARDING,
} from "../../infrastructure/config/storageKeys";
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from "../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  clearReconnectTimer,
  getActiveConnection,
  hasActivePortForwardRuntime,
  getPortForwardRuntimeAuthority,
  initReconnectCancelListener,
  reconcileWithBackend,
  startAllPortForwards,
  startPortForward,
  stopAllActivePortForwards,
  stopAllPortForwards,
  stopAndCleanupRule,
  stopAndCleanupRuleAndWait,
  stopPortForward,
  syncWithBackend,
  type StartAllPortForwardsResult,
  type StopAllActivePortForwardsResult,
} from "../../infrastructure/services/portForwardingService";
import { useStoredViewMode, ViewMode } from "./useStoredViewMode";

// Module-level ref-counts: these side effects must run at most once per
// window, not per hook instance (the hook mounts from both App.tsx
// and PortForwardingNew.tsx).  Ref-counting ensures the resources
// stay alive as long as ANY instance is mounted.
let reconnectCancelListenerRefs = 0;
let reconnectCancelCleanup: (() => void) | undefined;
let heartbeatRefs = 0;
let heartbeatIntervalId: ReturnType<typeof setInterval> | undefined;
let runtimeSubscriptionRefs = 0;
let runtimeSubscriptionCleanup: (() => void) | undefined;

export type { ViewMode };

export type SortMode = "manual" | "az" | "za" | "newest" | "oldest";

export interface UsePortForwardingStateResult {
  rules: PortForwardingRule[];
  selectedRuleId: string | null;
  viewMode: ViewMode;
  sortMode: SortMode;
  search: string;
  preferFormMode: boolean;

  setSelectedRuleId: (id: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setSortMode: (mode: SortMode) => void;
  setSearch: (query: string) => void;
  setPreferFormMode: (prefer: boolean) => void;

  addRule: (
    rule: Omit<PortForwardingRule, "id" | "createdAt" | "status">,
  ) => PortForwardingRule;
  updateRule: (id: string, updates: Partial<PortForwardingRule>) => void;
  deleteRule: (id: string) => void;
  duplicateRule: (id: string) => void;
  reorderRule: (sourceId: string, targetId: string, position: VaultOrderPosition) => void;
  importRules: (rules: PortForwardingRule[]) => void;

  setRuleStatus: (
    id: string,
    status: PortForwardingRule["status"],
    error?: string,
  ) => void;

  startTunnel: (
    rule: PortForwardingRule,
    host: Host,
    hosts: Host[],
    keys: SSHKey[],
    identities: Identity[],
    onStatusChange?: (status: PortForwardingRule["status"], error?: string) => void,
    enableReconnect?: boolean,
    terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number },
    knownHosts?: KnownHost[],
  ) => Promise<{ success: boolean; error?: string }>;
  stopTunnel: (
    ruleId: string,
    onStatusChange?: (status: PortForwardingRule["status"], error?: string) => void,
  ) => Promise<{ success: boolean; error?: string }>;
  startAllTunnels: (
    rules: PortForwardingRule[],
    resolveHost: (rule: PortForwardingRule) => Host | undefined,
    hosts: Host[],
    keys: SSHKey[],
    identities: Identity[],
    terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number },
    knownHosts?: KnownHost[],
    hostNotFoundMessage?: string,
  ) => Promise<StartAllPortForwardsResult>;
  stopAllTunnels: (rules: PortForwardingRule[]) => Promise<StopAllActivePortForwardsResult>;
  stopRuleTunnels: (ruleId: string) => Promise<{ success: boolean; error?: string }>;
  hasRuntimeTunnel: (ruleId: string) => boolean;
  hasAnyRuntimeTunnel: () => boolean;

  filteredRules: PortForwardingRule[];
  selectedRule: PortForwardingRule | undefined;
}

// Global Store State
let globalRules: PortForwardingRule[] = [];
let isInitialized = false;
// Until the first successful authoritative snapshot, treat runtime as unknown.
let snapshotAvailable = false;
const listeners = new Set<(rules: PortForwardingRule[]) => void>();

// Store Actions
const notifyListeners = () => {
  listeners.forEach((listener) => listener(globalRules));
};

const persistPortForwardingConfig = (rules: PortForwardingRule[]) => {
  localStorageAdapter.write(
    STORAGE_KEY_PORT_FORWARDING,
    toPersistedPortForwardingRules(rules),
  );
};

/** Persist configuration only — never write runtime phases to storage. */
const setGlobalRules = (newRules: PortForwardingRule[]) => {
  globalRules = normalizeVaultOrder(newRules);
  notifyListeners();
  persistPortForwardingConfig(globalRules);
};

/** Update the in-memory projection without touching localStorage. */
const setRuntimeProjection = (newRules: PortForwardingRule[]) => {
  globalRules = normalizeVaultOrder(newRules);
  notifyListeners();
};

export type NormalizeRulesOptions = {
  reconciledGoneRuleIds?: ReadonlySet<string>;
  snapshotAvailable?: boolean;
};

const isGoneRuleIdSet = (
  value: ReadonlySet<string> | NormalizeRulesOptions,
): value is ReadonlySet<string> => (
  typeof (value as ReadonlySet<string>).has === "function"
  && !("snapshotAvailable" in (value as object))
  && !("reconciledGoneRuleIds" in (value as object))
);

export const normalizeRulesWithConnections = (
  rules: PortForwardingRule[],
  reconciledGoneRuleIdsOrOptions: ReadonlySet<string> | NormalizeRulesOptions = new Set(),
): PortForwardingRule[] => {
  const options: NormalizeRulesOptions = isGoneRuleIdSet(reconciledGoneRuleIdsOrOptions)
    ? { reconciledGoneRuleIds: reconciledGoneRuleIdsOrOptions }
    : reconciledGoneRuleIdsOrOptions;

  const reconciledGoneRuleIds = options.reconciledGoneRuleIds ?? new Set<string>();
  const authorityAvailable = options.snapshotAvailable ?? snapshotAvailable;

  return rules.map((rule): PortForwardingRule => {
    const connection = getActiveConnection(rule.id);
    if (connection) {
      return {
        ...rule,
        status: connection.status,
        error: connection.error,
      };
    }

    if (reconciledGoneRuleIds.has(rule.id)) {
      return {
        ...rule,
        status: "inactive" as const,
        error: undefined,
      };
    }

    if (!authorityAvailable) {
      return {
        ...rule,
        status: "unknown" as const,
      };
    }

    if (rule.status === "error") return rule;

    return {
      ...rule,
      status: "inactive" as const,
      error: undefined,
    };
  });
};

export const havePortForwardingRuntimeStatesChanged = (
  current: PortForwardingRule[],
  next: PortForwardingRule[],
): boolean => {
  if (current.length !== next.length) return true;
  return next.some((rule, index) => {
    const existing = current[index];
    return existing?.id !== rule.id
      || existing.status !== rule.status
      || existing.error !== rule.error;
  });
};

export const hasPortForwardingRuntimePresenceChanged = (reconciliation: {
  gone: string[];
  appeared: string[];
}): boolean => reconciliation.gone.length > 0 || reconciliation.appeared.length > 0;

const mergeRulesWithKnownConnections = (rules: PortForwardingRule[]): PortForwardingRule[] => {
  return normalizeRulesWithConnections(
    migratePortForwardingRulesFromStorage(rules),
    { snapshotAvailable },
  );
};

/**
 * Apply a runtime status update to the in-memory projection only.
 * Auto-start and reconnect paths use this instead of writing localStorage.
 */
export const applyPortForwardingRuntimeStatus = (
  ruleId: string,
  status: PortForwardingRule["status"],
  error?: string,
): void => {
  if (globalRules.length === 0) {
    const stored = localStorageAdapter.read<PortForwardingRule[]>(
      STORAGE_KEY_PORT_FORWARDING,
    );
    if (stored && Array.isArray(stored)) {
      globalRules = normalizeVaultOrder(
        migratePortForwardingRulesFromStorage(stored),
      );
    }
  }

  const updated = globalRules.map((rule) => {
    if (rule.id !== ruleId) return rule;
    return {
      ...rule,
      status,
      error,
      lastUsedAt: status === "active" ? Date.now() : rule.lastUsedAt,
    };
  });
  setRuntimeProjection(updated);
};

const isPortForwardingStorageEvent = (event: Event): boolean => {
  const key = event.type === "storage"
    ? (event as StorageEvent).key
    : (event as CustomEvent<{ key?: string }>).detail?.key;
  return key === STORAGE_KEY_PORT_FORWARDING;
};

export const createPortForwardingStorageSyncHandlers = ({
  onRules,
}: {
  onRules: (rules: PortForwardingRule[]) => void;
}) => {
  const readStoredRules = (): PortForwardingRule[] | null => {
    const storedRules = localStorageAdapter.read<PortForwardingRule[]>(
      STORAGE_KEY_PORT_FORWARDING,
    );
    return storedRules && Array.isArray(storedRules) ? storedRules : null;
  };

  return {
    handleAdapterChange(event: Event) {
      if (!isPortForwardingStorageEvent(event)) return;
      const storedRules = readStoredRules();
      if (storedRules) onRules(mergeRulesWithKnownConnections(storedRules));
    },
    handleBrowserStorage(event: Event) {
      if (!isPortForwardingStorageEvent(event)) return;
      const storedRules = readStoredRules();
      if (storedRules) onRules(mergeRulesWithKnownConnections(storedRules));
    },
  };
};

const applyRuntimeSnapshotProjection = (
  goneRuleIds: ReadonlySet<string> = new Set(),
  authorityAvailable = snapshotAvailable,
  appearedRuleIds: readonly string[] = [],
) => {
  const normalizedRules = normalizeRulesWithConnections(globalRules, {
    reconciledGoneRuleIds: goneRuleIds,
    snapshotAvailable: authorityAvailable,
  });
  if (havePortForwardingRuntimeStatesChanged(globalRules, normalizedRules)) {
    setRuntimeProjection(normalizedRules);
  } else if (hasPortForwardingRuntimePresenceChanged({
    gone: [...goneRuleIds],
    appeared: appearedRuleIds,
  })) {
    globalRules = normalizedRules;
    notifyListeners();
  }
};

// Initialization Logic
const initializeStore = async () => {
  if (isInitialized) return;
  isInitialized = true;

  await syncWithBackend();
  snapshotAvailable = getPortForwardRuntimeAuthority().available;

  const saved = localStorageAdapter.read<PortForwardingRule[]>(
    STORAGE_KEY_PORT_FORWARDING,
  );
  if (saved && Array.isArray(saved)) {
    // Hydrate config from storage, then overlay the live runtime projection.
    // Do not re-persist — that would churn storage with migrated status fields.
    const migrated = migratePortForwardingRulesFromStorage(saved);
    setRuntimeProjection(normalizeRulesWithConnections(migrated, {
      snapshotAvailable,
    }));
  }
};

const subscribeToPortForwardRuntime = (): (() => void) => {
  const bridge = netcattyBridge.get();
  if (!bridge?.subscribePortForwardRuntime || !bridge.onPortForwardRuntime) {
    return () => undefined;
  }

  let disposed = false;
  let unsubscribeEvent: (() => void) | undefined;
  let observedEpoch: string | undefined;
  let observedRevision = -1;
  let syncChain: Promise<void> = Promise.resolve();

  const enqueueRuntimeSync = (task: () => Promise<void>) => {
    syncChain = syncChain.then(async () => {
      if (disposed) return;
      await task();
    }).catch(() => undefined);
    return syncChain;
  };

  const resyncFromSnapshot = async () => {
    try {
      const snapshot = await bridge.subscribePortForwardRuntime!();
      if (disposed) return;
      observedEpoch = snapshot.epoch;
      observedRevision = snapshot.revision;
      // Reconcile (not sync-only) so tunnels absent after an epoch change are pruned.
      const reconciliation = await reconcileWithBackend();
      if (disposed) return;
      snapshotAvailable = reconciliation.snapshotAvailable;
      if (!reconciliation.snapshotAvailable) {
        applyRuntimeSnapshotProjection(new Set(), false);
        return;
      }
      applyRuntimeSnapshotProjection(
        new Set(reconciliation.gone),
        true,
        reconciliation.appeared,
      );
    } catch {
      if (disposed) return;
      snapshotAvailable = false;
      applyRuntimeSnapshotProjection(new Set(), false);
    }
  };

  unsubscribeEvent = bridge.onPortForwardRuntime((event) => {
    if (disposed) return;
    if (observedEpoch && event.epoch !== observedEpoch) {
      void enqueueRuntimeSync(resyncFromSnapshot);
      return;
    }
    if (observedRevision >= 0 && event.revision > observedRevision + 1) {
      void enqueueRuntimeSync(resyncFromSnapshot);
      return;
    }
    observedEpoch = event.epoch;
    observedRevision = event.revision;
    void enqueueRuntimeSync(async () => {
      const reconciliation = await reconcileWithBackend();
      if (disposed) return;
      snapshotAvailable = reconciliation.snapshotAvailable;
      if (!reconciliation.snapshotAvailable) {
        applyRuntimeSnapshotProjection(new Set(), false);
        return;
      }
      applyRuntimeSnapshotProjection(
        new Set(reconciliation.gone),
        true,
        reconciliation.appeared,
      );
    });
  });

  void enqueueRuntimeSync(resyncFromSnapshot);

  return () => {
    disposed = true;
    unsubscribeEvent?.();
    void bridge.unsubscribePortForwardRuntime?.();
  };
};

export const usePortForwardingState = (): UsePortForwardingStateResult => {
  const [rules, setRules] = useState<PortForwardingRule[]>(globalRules);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_PF_VIEW_MODE,
    "grid",
  );
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [search, setSearch] = useState("");
  const [preferFormMode, setPreferFormModeState] = useState<boolean>(() => {
    return localStorageAdapter.readBoolean(STORAGE_KEY_PF_PREFER_FORM_MODE) ?? false;
  });

  const setPreferFormMode = useCallback((prefer: boolean) => {
    setPreferFormModeState(prefer);
    localStorageAdapter.writeBoolean(STORAGE_KEY_PF_PREFER_FORM_MODE, prefer);
  }, []);

  // Initialize store on mount (only once globally)
  useEffect(() => {
    void initializeStore();
  }, []);

  // Subscribe to global store
  useEffect(() => {
    // If global state was updated before we subscribed (e.g. init finished), update local state
    if (rules !== globalRules) {
      setRules(globalRules);
    }

    const listener = (newRules: PortForwardingRule[]) => {
      setRules(newRules);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [rules]);

  // Config sync across windows. Runtime phases are no longer written to
  // storage, so these handlers only refresh rule configuration and overlay
  // whatever live tunnels this window already knows about.
  useEffect(() => {
    const target = globalThis as typeof globalThis & {
      addEventListener?: (type: string, listener: EventListener) => void;
      removeEventListener?: (type: string, listener: EventListener) => void;
    };
    if (typeof target.addEventListener !== "function") return;

    const handlers = createPortForwardingStorageSyncHandlers({
      onRules: (newRules) => {
        globalRules = newRules;
        notifyListeners();
      },
    });

    target.addEventListener(
      LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
      handlers.handleAdapterChange,
    );
    target.addEventListener("storage", handlers.handleBrowserStorage);
    return () => {
      target.removeEventListener?.(
        LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
        handlers.handleAdapterChange,
      );
      target.removeEventListener?.("storage", handlers.handleBrowserStorage);
    };
  }, []);

  // Listen for cross-window reconnect cancellation events.
  // Ref-counted so the listener stays alive as long as ANY hook
  // instance is mounted (App.tsx outlives PortForwardingNew.tsx).
  useEffect(() => {
    reconnectCancelListenerRefs++;
    let cleanup: (() => void) | undefined;
    if (reconnectCancelListenerRefs === 1) {
      cleanup = initReconnectCancelListener();
      reconnectCancelCleanup = cleanup;
    }
    return () => {
      reconnectCancelListenerRefs--;
      if (reconnectCancelListenerRefs === 0 && reconnectCancelCleanup) {
        reconnectCancelCleanup();
        reconnectCancelCleanup = undefined;
      }
    };
  }, []);

  // Authoritative runtime subscription (snapshot + ordered events). Heartbeat
  // below remains as a recovery fallback for revision gaps / missed events.
  useEffect(() => {
    runtimeSubscriptionRefs++;
    if (runtimeSubscriptionRefs === 1) {
      runtimeSubscriptionCleanup = subscribeToPortForwardRuntime();
    }
    return () => {
      runtimeSubscriptionRefs--;
      if (runtimeSubscriptionRefs === 0 && runtimeSubscriptionCleanup) {
        runtimeSubscriptionCleanup();
        runtimeSubscriptionCleanup = undefined;
      }
    };
  }, []);

  // Periodic heartbeat: reconcile renderer state with the backend every 4s.
  // Ref-counted — same pattern as the reconnect cancel listener.
  useEffect(() => {
    heartbeatRefs++;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (heartbeatRefs === 1) {
      const HEARTBEAT_INTERVAL_MS = 4_000;

      const tick = async () => {
        const reconciliation = await reconcileWithBackend();
        snapshotAvailable = reconciliation.snapshotAvailable;
        if (!reconciliation.snapshotAvailable) {
          // Snapshot failure must surface as unknown/stale — never as inactive.
          applyRuntimeSnapshotProjection(new Set(), false);
          return;
        }
        // Always re-derive the visible state from the live connection map.
        // Runtime phases stay in memory only.
        const normalizedRules = normalizeRulesWithConnections(
          globalRules,
          {
            reconciledGoneRuleIds: new Set(reconciliation.gone),
            snapshotAvailable: true,
          },
        );
        if (havePortForwardingRuntimeStatesChanged(globalRules, normalizedRules)) {
          setRuntimeProjection(normalizedRules);
        } else if (hasPortForwardingRuntimePresenceChanged(reconciliation)) {
          globalRules = normalizedRules;
          notifyListeners();
        }
      };

      intervalId = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      heartbeatIntervalId = intervalId;
    }
    return () => {
      heartbeatRefs--;
      if (heartbeatRefs === 0 && heartbeatIntervalId !== undefined) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = undefined;
      }
    };
  }, []);

  const addRule = useCallback(
    (
      rule: Omit<PortForwardingRule, "id" | "createdAt" | "status">,
    ): PortForwardingRule => {
      const newRule: PortForwardingRule = {
        ...rule,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        status: "inactive",
        order: getNextVaultOrder(globalRules),
      };
      const updated = [...globalRules, newRule];
      setGlobalRules(updated);
      setSelectedRuleId(newRule.id);
      return newRule;
    },
    [],
  );

  const updateRule = useCallback(
    (id: string, updates: Partial<PortForwardingRule>) => {
      const updated = globalRules.map((r) =>
        r.id === id ? { ...r, ...updates } : r,
      );
      setGlobalRules(updated);
    },
    [],
  );

  const deleteRule = useCallback(
    (id: string) => {
      // Stop any active tunnel before removing the rule
      stopAndCleanupRule(id);
      const updated = globalRules.filter((r) => r.id !== id);
      setGlobalRules(updated);
      if (selectedRuleId === id) {
        setSelectedRuleId(null);
      }
    },
    [selectedRuleId],
  );

  const duplicateRule = useCallback(
    (id: string) => {
      const original = globalRules.find((r) => r.id === id);
      if (!original) return;

      const copy: PortForwardingRule = {
        ...original,
        id: crypto.randomUUID(),
        label: `${original.label} (Copy)`,
        createdAt: Date.now(),
        status: "inactive",
        error: undefined,
        lastUsedAt: undefined,
        order: getNextVaultOrder(globalRules),
      };
      const updated = [...globalRules, copy];
      setGlobalRules(updated);
      setSelectedRuleId(copy.id);
    },
    [],
  );

  const reorderRule = useCallback(
    (sourceId: string, targetId: string, position: VaultOrderPosition) => {
      setGlobalRules(reorderVaultItems(globalRules, sourceId, targetId, position));
      setSortMode("manual");
    },
    [],
  );

  const importRules = useCallback((newRules: PortForwardingRule[]) => {
    // When clearing all rules (e.g. "Clear local data"), stop ALL tunnels
    // and broadcast per-rule reconnect cancellation.  stopAllPortForwards
    // handles the backend, but we also need per-rule broadcasts so other
    // windows cancel their pending reconnect timers.
    if (newRules.length === 0) {
      // Read from localStorage since globalRules may be empty (uninitialized)
      const storedRules = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      const rulesToCancel = globalRules.length > 0
        ? globalRules
        : (storedRules && Array.isArray(storedRules) ? storedRules : []);
      for (const rule of rulesToCancel) {
        stopAndCleanupRule(rule.id);
      }
      // Safety net: also stop anything the renderer doesn't know about
      void stopAllPortForwards();
    }

    // Stop tunnels for rules that are being removed or whose connection
    // config has changed (same ID but different host/port/type means the
    // old tunnel is pointing at stale parameters and must be torn down).
    //
    // Use globalRules as the diff baseline.  In a freshly opened settings
    // window, globalRules may still be empty because initializeStore is
    // async.  Fall back to reading directly from localStorage to avoid
    // missing tunnels that need to be stopped.
    let diffBaseline = globalRules;
    if (diffBaseline.length === 0 && newRules.length > 0) {
      const stored = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      if (stored && Array.isArray(stored) && stored.length > 0) {
        diffBaseline = stored;
      }
    }
    const newRulesById = new Map(newRules.map((r) => [r.id, r]));
    for (const existing of diffBaseline) {
      const incoming = newRulesById.get(existing.id);
      if (!incoming) {
        // Rule removed entirely
        stopAndCleanupRule(existing.id);
      } else if (
        existing.type !== incoming.type ||
        existing.localPort !== incoming.localPort ||
        existing.remoteHost !== incoming.remoteHost ||
        existing.remotePort !== incoming.remotePort ||
        existing.bindAddress !== incoming.bindAddress ||
        existing.hostId !== incoming.hostId
      ) {
        // Connection-relevant config changed — tear down the old tunnel
        stopAndCleanupRule(existing.id);
      }
    }
    setGlobalRules(normalizeRulesWithConnections(
      migratePortForwardingRulesFromStorage(newRules),
    ));
  }, []);

  const setRuleStatus = useCallback(
    (id: string, status: PortForwardingRule["status"], error?: string) => {
      applyPortForwardingRuntimeStatus(id, status, error);
    },
    [],
  );

  const startTunnel = useCallback(
    async (
      rule: PortForwardingRule,
      host: Host,
      hosts: Host[],
      keys: SSHKey[],
      identities: Identity[],
      onStatusChange?: (
        status: PortForwardingRule["status"],
        error?: string,
      ) => void,
      enableReconnect = false,
      terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number },
      knownHosts?: KnownHost[],
    ) => {
      return startPortForward(rule, host, hosts, keys, identities, (status, error) => {
        setRuleStatus(rule.id, status, error);
        onStatusChange?.(status, error ?? undefined);
      }, enableReconnect, terminalSettings, knownHosts);
    },
    [setRuleStatus],
  );

  const stopTunnel = useCallback(
    async (
      ruleId: string,
      onStatusChange?: (status: PortForwardingRule["status"], error?: string) => void,
    ) => {
      // Clear any pending reconnect timer when manually stopping
      clearReconnectTimer(ruleId);
      return stopPortForward(ruleId, (status, error) => {
        setRuleStatus(ruleId, status, error);
        onStatusChange?.(status, error);
      });
    },
    [setRuleStatus],
  );

  const hasRuntimeTunnel = useCallback((ruleId: string) => {
    const connection = getActiveConnection(ruleId);
    return connection !== undefined && connection.status !== "inactive";
  }, []);

  const hasAnyRuntimeTunnel = useCallback(() => hasActivePortForwardRuntime(), []);

  const startAllTunnels = useCallback(
    async (
      targetRules: PortForwardingRule[],
      resolveHost: (rule: PortForwardingRule) => Host | undefined,
      hosts: Host[],
      keys: SSHKey[],
      identities: Identity[],
      terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number },
      knownHosts?: KnownHost[],
      hostNotFoundMessage?: string,
    ) => {
      return startAllPortForwards(
        targetRules,
        resolveHost,
        hosts,
        keys,
        identities,
        (ruleId, status, error) => {
          setRuleStatus(ruleId, status, error);
        },
        terminalSettings,
        knownHosts,
        (ruleId) => globalRules.find((rule) => rule.id === ruleId),
        hostNotFoundMessage,
      );
    },
    [setRuleStatus],
  );

  const stopAllTunnels = useCallback(
    async (targetRules: PortForwardingRule[]) => {
      return stopAllActivePortForwards(targetRules, (ruleId, status, error) => {
        setRuleStatus(ruleId, status, error);
      });
    },
    [setRuleStatus],
  );

  // Filter and sort rules
  const filteredRules = useMemo(() => {
    let result = [...rules];

    // Filter by search
    if (search.trim()) {
      const s = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.label.toLowerCase().includes(s) ||
          r.type.toLowerCase().includes(s) ||
          r.localPort.toString().includes(s) ||
          r.remoteHost?.toLowerCase().includes(s) ||
          r.remotePort?.toString().includes(s),
      );
    }

    // Sort
    switch (sortMode) {
      case "az":
        result.sort((a, b) => a.label.localeCompare(b.label));
        break;
      case "za":
        result.sort((a, b) => b.label.localeCompare(a.label));
        break;
      case "newest":
        result.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "oldest":
        result.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "manual":
        result = sortByVaultOrder(result);
        break;
    }

    return result;
  }, [rules, search, sortMode]);

  const selectedRule = rules.find((r) => r.id === selectedRuleId);

  return {
    rules,
    selectedRuleId,
    viewMode,
    sortMode,
    search,
    preferFormMode,

    setSelectedRuleId,
    setViewMode,
    setSortMode,
    setSearch,
    setPreferFormMode,

    addRule,
    updateRule,
    deleteRule,
    duplicateRule,
    reorderRule,
    importRules,

    setRuleStatus,
    startTunnel,
    stopTunnel,
    startAllTunnels,
    stopAllTunnels,
    stopRuleTunnels: stopAndCleanupRuleAndWait,
    hasRuntimeTunnel,
    hasAnyRuntimeTunnel,

    filteredRules,
    selectedRule,
  };
};
