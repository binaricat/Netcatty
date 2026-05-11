import { useCallback, useEffect, useMemo, useState } from "react";
import { Host, Identity, PortForwardingRule, SSHKey } from "../../domain/models";
import {
  STORAGE_KEY_PF_PREFER_FORM_MODE,
  STORAGE_KEY_PF_VIEW_MODE,
  STORAGE_KEY_PORT_FORWARDING,
} from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  clearReconnectTimer,
  getActiveConnection,
  initReconnectCancelListener,
  reconcileWithBackend,
  startPortForward,
  stopAllPortForwards,
  stopAndCleanupRule,
  stopPortForward,
  syncWithBackend,
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

export type { ViewMode };

export type SortMode = "az" | "za" | "newest" | "oldest";

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
  ) => Promise<{ success: boolean; error?: string }>;
  stopTunnel: (
    ruleId: string,
    onStatusChange?: (status: PortForwardingRule["status"]) => void,
  ) => Promise<{ success: boolean; error?: string }>;

  filteredRules: PortForwardingRule[];
  selectedRule: PortForwardingRule | undefined;
}

// Global Store State
let globalRules: PortForwardingRule[] = [];
let isInitialized = false;
const listeners = new Set<(rules: PortForwardingRule[]) => void>();

// Store Actions
const notifyListeners = () => {
  listeners.forEach((listener) => listener(globalRules));
};

const setGlobalRules = (newRules: PortForwardingRule[]) => {
  globalRules = newRules;
  notifyListeners();
  localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, newRules);
};

const normalizeRulesWithConnections = (rules: PortForwardingRule[]): PortForwardingRule[] => {
  return rules.map((rule): PortForwardingRule => {
    const connection = getActiveConnection(rule.id);
    if (connection) {
      return {
        ...rule,
        status: connection.status,
        error: connection.error,
      };
    }

    return {
      ...rule,
      status: "inactive" as const,
      error: undefined,
    };
  });
};

// Initialization Logic
const initializeStore = async () => {
  if (isInitialized) return;
  isInitialized = true;

  await syncWithBackend();

  const saved = localStorageAdapter.read<PortForwardingRule[]>(
    STORAGE_KEY_PORT_FORWARDING,
  );
  if (saved && Array.isArray(saved)) {
    setGlobalRules(normalizeRulesWithConnections(saved));
  }
};

export const usePortForwardingState = (): UsePortForwardingStateResult => {
  const [rules, setRules] = useState<PortForwardingRule[]>(globalRules);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useStoredViewMode(
    STORAGE_KEY_PF_VIEW_MODE,
    "grid",
  );
  const [sortMode, setSortMode] = useState<SortMode>("newest");
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

  // Listen for storage events for cross-window sync (main window <-> tray panel)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      // Only handle changes from our specific key
      if (e.key !== STORAGE_KEY_PORT_FORWARDING) return;

      // Parse the new value
      if (e.newValue) {
        try {
          const newRules = JSON.parse(e.newValue) as PortForwardingRule[];
          if (Array.isArray(newRules)) {
            // Update global state without triggering another localStorage write
            globalRules = normalizeRulesWithConnections(newRules);
            notifyListeners();
          }
        } catch {
          // ignore parse errors
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
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

  // Periodic heartbeat: reconcile renderer state with the backend every 4s.
  // Ref-counted — same pattern as the reconnect cancel listener.
  useEffect(() => {
    heartbeatRefs++;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (heartbeatRefs === 1) {
      const HEARTBEAT_INTERVAL_MS = 4_000;

      const tick = async () => {
        const { gone, appeared } = await reconcileWithBackend();
        if (gone.length === 0 && appeared.length === 0) return;

        // Re-derive statuses from the now-updated activeConnections map
        setGlobalRules(normalizeRulesWithConnections(globalRules));
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
      };
      const updated = [...globalRules, copy];
      setGlobalRules(updated);
      setSelectedRuleId(copy.id);
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
    setGlobalRules(normalizeRulesWithConnections(newRules));
  }, []);

  const setRuleStatus = useCallback(
    (id: string, status: PortForwardingRule["status"], error?: string) => {
      const updated = globalRules.map((r) => {
        if (r.id !== id) return r;
        return {
          ...r,
          status,
          error,
          lastUsedAt: status === "active" ? Date.now() : r.lastUsedAt,
        };
      });
      setGlobalRules(updated);
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
    ) => {
      return startPortForward(rule, host, hosts, keys, identities, (status, error) => {
        setRuleStatus(rule.id, status, error);
        onStatusChange?.(status, error ?? undefined);
      }, enableReconnect, terminalSettings);
    },
    [setRuleStatus],
  );

  const stopTunnel = useCallback(
    async (
      ruleId: string,
      onStatusChange?: (status: PortForwardingRule["status"]) => void,
    ) => {
      // Clear any pending reconnect timer when manually stopping
      clearReconnectTimer(ruleId);
      return stopPortForward(ruleId, (status) => {
        setRuleStatus(ruleId, status);
        onStatusChange?.(status);
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
    importRules,

    setRuleStatus,
    startTunnel,
    stopTunnel,

    filteredRules,
    selectedRule,
  };
};
