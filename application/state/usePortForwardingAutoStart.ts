/**
 * Hook for auto-starting port forwarding rules on app launch.
 * This should be used at the App level to ensure auto-start happens
 * when the application starts, not when the user navigates to the port forwarding page.
 */
import { useCallback, useEffect, useRef } from "react";
import { GroupConfig, Host, Identity, PortForwardingRule, SSHKey } from "../../domain/models";
import { resolveGroupDefaults, applyGroupDefaults } from "../../domain/groupConfig";
import { STORAGE_KEY_PORT_FORWARDING } from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  getActiveConnection,
  setReconnectCallback,
  startPortForward,
  syncWithBackend,
} from "../../infrastructure/services/portForwardingService";
import { logger } from "../../lib/logger";

export interface UsePortForwardingAutoStartOptions {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  groupConfigs: GroupConfig[];
}

/**
 * Auto-starts port forwarding rules that have autoStart enabled.
 * This hook should be called at the App level to run on app launch.
 */
export const usePortForwardingAutoStart = ({
  hosts,
  keys,
  identities,
  groupConfigs,
}: UsePortForwardingAutoStartOptions): void => {
  const autoStartExecutedRef = useRef(false);
  const hostsRef = useRef<Host[]>(hosts);
  const keysRef = useRef<SSHKey[]>(keys);
  const identitiesRef = useRef<Identity[]>(identities);
  const groupConfigsRef = useRef<GroupConfig[]>(groupConfigs);

  const isHostAuthReady = useCallback((host: Host, seen = new Set<string>()): boolean => {
    if (!host || seen.has(host.id)) return true;
    seen.add(host.id);

    if (host.identityId) {
      const identity = identitiesRef.current.find((candidate) => candidate.id === host.identityId);
      if (!identity) return false;
      if (identity.keyId && !keysRef.current.some((key) => key.id === identity.keyId)) {
        return false;
      }
    }
    if (host.identityFileId && !keysRef.current.some((key) => key.id === host.identityFileId)) {
      return false;
    }

    const chainIds = host.hostChain?.hostIds || [];
    for (const chainId of chainIds) {
      const chainHost = hostsRef.current.find((candidate) => candidate.id === chainId);
      if (!chainHost) return false;
      if (!isHostAuthReady(chainHost, seen)) return false;
    }

    return true;
  }, []);

  // Keep refs in sync
  useEffect(() => {
    hostsRef.current = hosts;
  }, [hosts]);

  useEffect(() => {
    keysRef.current = keys;
  }, [keys]);

  useEffect(() => {
    identitiesRef.current = identities;
  }, [identities]);

  useEffect(() => {
    groupConfigsRef.current = groupConfigs;
  }, [groupConfigs]);

  const resolveEffectiveHost = useCallback((host: Host): Host => {
    if (!host.group) return host;
    const defaults = resolveGroupDefaults(host.group, groupConfigsRef.current);
    return applyGroupDefaults(host, defaults);
  }, []);

  // Set up the reconnect callback
  useEffect(() => {
    const handleReconnect = async (
      ruleId: string,
      onStatusChange: (status: PortForwardingRule["status"], error?: string) => void,
    ) => {
      // Load the current rules from storage
      const rules = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      ) ?? [];
      
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule || !rule.hostId) {
        return { success: false, error: "Rule or host not found" };
      }

      const rawHost = hostsRef.current.find((h) => h.id === rule.hostId);
      if (!rawHost) {
        return { success: false, error: "Host not found" };
      }

      const host = resolveEffectiveHost(rawHost);
      return startPortForward(rule, host, hostsRef.current, keysRef.current, identitiesRef.current, onStatusChange, true);
    };

    setReconnectCallback(handleReconnect);
    return () => {
      setReconnectCallback(null);
    };
  }, []);

  // Auto-start rules on app launch
  useEffect(() => {
    if (autoStartExecutedRef.current) return;
    if (hosts.length === 0) return;

    const storedRules = localStorageAdapter.read<PortForwardingRule[]>(
      STORAGE_KEY_PORT_FORWARDING,
    ) ?? [];
    const pendingAutoStartRules = storedRules.filter((rule) => rule.autoStart && rule.hostId);
    if (pendingAutoStartRules.some((rule) => {
      const host = hosts.find((candidate) => candidate.id === rule.hostId);
      return !host || !isHostAuthReady(host);
    })) {
      return;
    }

    // Mark as executed immediately to prevent duplicate runs
    // (React StrictMode or dependency changes could cause re-runs)
    autoStartExecutedRef.current = true;

    const runAutoStart = async () => {
      // First sync with backend to get any active tunnels
      await syncWithBackend();

      // Load rules from storage
      const rules = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      ) ?? [];

      // Only start rules that are not already active
      const autoStartRules = rules.filter((r) => {
        if (!r.autoStart || !r.hostId) return false;
        // Check if there's an active connection for this rule
        const conn = getActiveConnection(r.id);
        // Only start if not already connecting or active
        return !conn || conn.status === 'inactive' || conn.status === 'error';
      });

      if (autoStartRules.length === 0) return;
      logger.info(`[PortForwardingAutoStart] Starting ${autoStartRules.length} auto-start rules`);

      // Start each auto-start rule
      for (const rule of autoStartRules) {
        const rawHost = hosts.find((h) => h.id === rule.hostId);
        if (rawHost) {
          const host = resolveEffectiveHost(rawHost);
          void startPortForward(
            rule,
            host,
            hosts,
            keys,
            identities,
            (status, error) => {
              // Update the rule status in storage
              const currentRules = localStorageAdapter.read<PortForwardingRule[]>(
                STORAGE_KEY_PORT_FORWARDING,
              ) ?? [];
              
              const updatedRules = currentRules.map((r) =>
                r.id === rule.id
                  ? {
                      ...r,
                      status,
                      error,
                      lastUsedAt: status === "active" ? Date.now() : r.lastUsedAt,
                    }
                  : r,
              );
              
              localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, updatedRules);
            },
            true, // Enable reconnect for auto-start rules
          );
        }
      }
    };

    void runAutoStart();
  }, [hosts, identities, isHostAuthReady, keys]);
};
