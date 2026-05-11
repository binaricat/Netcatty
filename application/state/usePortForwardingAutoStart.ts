/**
 * Hook for auto-starting port forwarding rules on app launch.
 * This should be used at the App level to ensure auto-start happens
 * when the application starts, not when the user navigates to the port forwarding page.
 */
import { useCallback, useEffect, useRef } from "react";
import { GroupConfig, Host, Identity, PortForwardingRule, ProxyProfile, SSHKey } from "../../domain/models";
import { resolveGroupDefaults, applyGroupDefaults } from "../../domain/groupConfig";
import { materializeHostProxyProfile } from "../../domain/proxyProfiles";
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
  isVaultInitialized: boolean;
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  proxyProfiles: ProxyProfile[];
  groupConfigs: GroupConfig[];
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
}

const AUTO_START_PROXY_NOT_READY_ERROR = "Proxy or jump host configuration is not ready";
const AUTO_START_AUTH_NOT_READY_ERROR = "Host authentication configuration is not ready";

export const isAutoStartProxyReady = (
  host: Host,
  allHosts: Host[],
  proxyProfiles: ProxyProfile[],
  groupConfigs: GroupConfig[],
  seen = new Set<string>(),
): boolean => {
  if (!host || seen.has(host.id)) return true;
  seen.add(host.id);

  const validProxyProfileIds: ReadonlySet<string> = new Set(proxyProfiles.map((profile) => profile.id));
  const rawGroupDefaults = host.group
    ? resolveGroupDefaults(host.group, groupConfigs)
    : {};
  const groupDefaults = host.group
    ? resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds })
    : {};
  const missingHostProxyProfile = Boolean(
    host.proxyProfileId && !validProxyProfileIds.has(host.proxyProfileId),
  );
  const missingGroupProxyProfile = Boolean(
    !host.proxyConfig &&
    !host.proxyProfileId &&
    rawGroupDefaults.proxyProfileId &&
    !validProxyProfileIds.has(rawGroupDefaults.proxyProfileId),
  );
  const effectiveHost = applyGroupDefaults(host, groupDefaults, { validProxyProfileIds });
  const hasProxyReplacement = Boolean(
    effectiveHost.proxyConfig ||
    (effectiveHost.proxyProfileId && validProxyProfileIds.has(effectiveHost.proxyProfileId)),
  );

  if ((missingHostProxyProfile || missingGroupProxyProfile) && !hasProxyReplacement) {
    return false;
  }

  const chainIds = effectiveHost.hostChain?.hostIds || [];
  for (const chainId of chainIds) {
    const chainHost = allHosts.find((candidate) => candidate.id === chainId);
    if (!chainHost) return false;
    if (!isAutoStartProxyReady(chainHost, allHosts, proxyProfiles, groupConfigs, seen)) return false;
  }

  return true;
};

export const getAutoStartRuleBlockReason = (
  rule: PortForwardingRule,
  hosts: Host[],
  proxyProfiles: ProxyProfile[],
  groupConfigs: GroupConfig[],
  isHostAuthReady: (host: Host) => boolean,
): string | undefined => {
  if (!rule.hostId) return "Rule host is not configured";
  const host = hosts.find((candidate) => candidate.id === rule.hostId);
  if (!host) return "Host not found";
  if (!isHostAuthReady(host)) return AUTO_START_AUTH_NOT_READY_ERROR;
  if (!isAutoStartProxyReady(host, hosts, proxyProfiles, groupConfigs)) {
    return AUTO_START_PROXY_NOT_READY_ERROR;
  }
  return undefined;
};

/**
 * Auto-starts port forwarding rules that have autoStart enabled.
 * This hook should be called at the App level to run on app launch.
 */
export const usePortForwardingAutoStart = ({
  isVaultInitialized,
  hosts,
  keys,
  identities,
  proxyProfiles,
  groupConfigs,
  terminalSettings,
}: UsePortForwardingAutoStartOptions): void => {
  const autoStartExecutedRef = useRef(false);
  const hostsRef = useRef<Host[]>(hosts);
  const keysRef = useRef<SSHKey[]>(keys);
  const identitiesRef = useRef<Identity[]>(identities);
  const proxyProfilesRef = useRef<ProxyProfile[]>(proxyProfiles);
  const groupConfigsRef = useRef<GroupConfig[]>(groupConfigs);
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;

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
    proxyProfilesRef.current = proxyProfiles;
  }, [proxyProfiles]);

  useEffect(() => {
    groupConfigsRef.current = groupConfigs;
  }, [groupConfigs]);

  const resolveEffectiveHost = useCallback((host: Host): Host => {
    const validProxyProfileIds: ReadonlySet<string> = new Set(proxyProfilesRef.current.map((profile) => profile.id));
    const withGroupDefaults = host.group
      ? applyGroupDefaults(
          host,
          resolveGroupDefaults(host.group, groupConfigsRef.current, { validProxyProfileIds }),
          { validProxyProfileIds },
        )
      : applyGroupDefaults(host, {}, { validProxyProfileIds });
    return materializeHostProxyProfile(withGroupDefaults, proxyProfilesRef.current);
  }, []);

  const resolveEffectiveHosts = useCallback(
    (items: Host[]): Host[] => items.map((host) => resolveEffectiveHost(host)),
    [resolveEffectiveHost],
  );

  const updateStoredRuleStatus = useCallback(
    (ruleId: string, status: PortForwardingRule["status"], error?: string) => {
      const currentRules = localStorageAdapter.read<PortForwardingRule[]>(
        STORAGE_KEY_PORT_FORWARDING,
      ) ?? [];

      const updatedRules = currentRules.map((rule) =>
        rule.id === ruleId
          ? {
              ...rule,
              status,
              error,
              lastUsedAt: status === "active" ? Date.now() : rule.lastUsedAt,
            }
          : rule,
      );

      localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, updatedRules);
    },
    [],
  );

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
      if (!rule) {
        const error = "Rule not found";
        onStatusChange("error", error);
        return { success: false, error };
      }
      if (!rule.hostId) {
        const error = "Rule host is not configured";
        onStatusChange("error", error);
        return { success: false, error };
      }

      const rawHost = hostsRef.current.find((h) => h.id === rule.hostId);
      if (!rawHost) {
        const error = "Host not found";
        onStatusChange("error", error);
        return { success: false, error };
      }
      const blockReason = getAutoStartRuleBlockReason(
        rule,
        hostsRef.current,
        proxyProfilesRef.current,
        groupConfigsRef.current,
        (host) => isHostAuthReady(host),
      );
      if (blockReason) {
        onStatusChange("error", blockReason);
        return { success: false, error: blockReason };
      }

      const host = resolveEffectiveHost(rawHost);
      return startPortForward(rule, host, resolveEffectiveHosts(hostsRef.current), keysRef.current, identitiesRef.current, onStatusChange, true, terminalSettingsRef.current);
    };

    setReconnectCallback(handleReconnect);
    return () => {
      setReconnectCallback(null);
    };
  }, [isHostAuthReady, resolveEffectiveHost, resolveEffectiveHosts]);

  // Auto-start rules on app launch
  useEffect(() => {
    if (autoStartExecutedRef.current) return;
    if (!isVaultInitialized) return;

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
        if (!r.autoStart) return false;
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
        const blockReason = getAutoStartRuleBlockReason(
          rule,
          hosts,
          proxyProfiles,
          groupConfigs,
          (host) => isHostAuthReady(host),
        );
        if (blockReason) {
          updateStoredRuleStatus(rule.id, "error", blockReason);
          continue;
        }

        if (!rawHost) continue;
        const host = resolveEffectiveHost(rawHost);
        void startPortForward(
          rule,
          host,
          resolveEffectiveHosts(hosts),
          keys,
          identities,
          (status, error) => {
            updateStoredRuleStatus(rule.id, status, error);
          },
          true, // Enable reconnect for auto-start rules
          // Read via ref so adjusting global keepalive after launch doesn't
          // re-trigger the auto-start effect (its dep array is intentionally
          // stable to fire once on vault init).
          terminalSettingsRef.current,
        );
      }
    };

    void runAutoStart();
  }, [
    groupConfigs,
    hosts,
    identities,
    isHostAuthReady,
    isVaultInitialized,
    keys,
    proxyProfiles,
    resolveEffectiveHost,
    resolveEffectiveHosts,
    updateStoredRuleStatus,
  ]);
};
