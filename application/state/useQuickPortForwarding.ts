import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { isSavedVaultHost } from '../../domain/ephemeralHosts';
import type {
  Host,
  Identity,
  KnownHost,
  PortForwardingRule,
  SSHKey,
  TerminalSettings,
} from '../../domain/models';
import { isPortForwardingAutoReconnectEnabled } from '../../domain/portForwardingReconnect';
import {
  buildQuickForwardRuleLabel,
  canQuickForwardSession,
  findExactReusableForwardRule,
  resolveForwardRemoteHost,
} from '../../domain/systemManager/portForwardQuick';
import type { ListeningPortInfo } from '../../domain/systemManager/types';
import {
  clearReconnectTimer,
  startPortForward,
  stopPortForward,
} from '../../infrastructure/services/portForwardingService';
import type { TerminalSession } from '../../types';
import { usePortForwardingState } from './usePortForwardingState';

export interface QuickPortForwardingContext {
  session: TerminalSession | null;
  sessionHost: Host | null;
  /** Authenticated session host override (e.g. interactive password/user). */
  authHost?: Host | null;
  /** Saved vault hosts, used to determine if rules should be persisted to Vault. */
  vaultHosts: Host[];
  /** Materialized hosts (group defaults + proxy profiles) for jump-host resolution. */
  effectiveHosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts: KnownHost[];
  terminalSettings: TerminalSettings;
}

export interface StartQuickForwardParams {
  port: ListeningPortInfo;
  localPort: number;
  bindAddress: string;
}

export interface StartQuickForwardResult {
  success: boolean;
  rule?: PortForwardingRule;
  error?: string;
}

// In-memory store for quick-forwards launched from unsaved / ephemeral sessions
// so they never write dangling hostId references to localStorage or cloud sync.
const ephemeralRulesMap = new Map<string, PortForwardingRule>();
let ephemeralRulesSnapshot: PortForwardingRule[] = [];
const ephemeralListeners = new Set<() => void>();

function notifyEphemeralListeners(): void {
  ephemeralRulesSnapshot = Array.from(ephemeralRulesMap.values());
  ephemeralListeners.forEach((listener) => listener());
}

function subscribeEphemeralRules(listener: () => void): () => void {
  ephemeralListeners.add(listener);
  return () => {
    ephemeralListeners.delete(listener);
  };
}

function getEphemeralRulesSnapshot(): PortForwardingRule[] {
  return ephemeralRulesSnapshot;
}

function upsertEphemeralRule(rule: PortForwardingRule): void {
  ephemeralRulesMap.set(rule.id, rule);
  notifyEphemeralListeners();
}

function updateEphemeralRuleStatus(
  ruleId: string,
  status: PortForwardingRule['status'],
  error?: string,
): void {
  const existing = ephemeralRulesMap.get(ruleId);
  if (!existing) return;
  if (status === 'inactive') {
    ephemeralRulesMap.delete(ruleId);
  } else {
    ephemeralRulesMap.set(ruleId, {
      ...existing,
      status,
      error,
      lastUsedAt: status === 'active' ? Date.now() : existing.lastUsedAt,
    });
  }
  notifyEphemeralListeners();
}

function deleteEphemeralRule(ruleId: string): void {
  if (!ephemeralRulesMap.delete(ruleId)) return;
  notifyEphemeralListeners();
}

export function resetEphemeralQuickForwardsForTests(): void {
  ephemeralRulesMap.clear();
  ephemeralRulesSnapshot = [];
  ephemeralListeners.clear();
}

export function useQuickPortForwarding(context?: QuickPortForwardingContext) {
  const {
    rules: persistedRules,
    addRule,
    deleteRule,
    startTunnel,
    stopTunnel,
  } = usePortForwardingState();
  const ephemeralRules = useSyncExternalStore(
    subscribeEphemeralRules,
    getEphemeralRulesSnapshot,
    getEphemeralRulesSnapshot,
  );
  const [pendingRuleIds, setPendingRuleIds] = useState<ReadonlySet<string>>(() => new Set());

  const targetHost = context?.authHost ?? context?.sessionHost ?? null;
  const hostId = context?.sessionHost?.id;
  const canForward = useMemo(
    () => Boolean(context) && canQuickForwardSession(targetHost, context?.session),
    [context, targetHost],
  );

  const canPersistRule = useMemo(() => {
    if (!context?.sessionHost || !isSavedVaultHost(context.sessionHost)) return false;
    return context.vaultHosts.some((candidate) => candidate.id === context.sessionHost!.id);
  }, [context]);

  const allRules = useMemo(
    () => (ephemeralRules.length > 0 ? [...persistedRules, ...ephemeralRules] : persistedRules),
    [ephemeralRules, persistedRules],
  );

  const markPending = useCallback((ruleId: string, pending: boolean) => {
    setPendingRuleIds((prev) => {
      const has = prev.has(ruleId);
      if (pending === has) return prev;
      const next = new Set(prev);
      if (pending) next.add(ruleId);
      else next.delete(ruleId);
      return next;
    });
  }, []);

  const startQuickForward = useCallback(
    async ({
      port,
      localPort,
      bindAddress,
    }: StartQuickForwardParams): Promise<StartQuickForwardResult> => {
      if (!context || !targetHost || !hostId || !canForward) {
        return { success: false, error: 'Port forwarding is unavailable for this session.' };
      }

      const remoteHost = resolveForwardRemoteHost(port);
      const label = buildQuickForwardRuleLabel(
        context.sessionHost?.label || context.session?.hostLabel || targetHost.hostname,
        port,
        localPort,
        remoteHost,
      );

      if (canPersistRule) {
        const reusableRule = findExactReusableForwardRule(persistedRules, {
          hostId,
          remoteHost,
          remotePort: port.port,
          localPort,
          bindAddress,
        });

        const rule = reusableRule ?? addRule({
          label,
          type: 'local',
          localPort,
          bindAddress,
          remoteHost,
          remotePort: port.port,
          hostId,
          autoStart: false,
        });
        const createdNewRule = !reusableRule;

        markPending(rule.id, true);
        try {
          const result = await startTunnel(
            rule,
            targetHost,
            context.effectiveHosts,
            context.keys,
            context.identities,
            undefined,
            isPortForwardingAutoReconnectEnabled(rule),
            context.terminalSettings,
            context.knownHosts,
          );
          if (!result.success) {
            if (createdNewRule) {
              deleteRule(rule.id);
            }
            return { success: false, error: result.error };
          }
          return { success: true, rule };
        } finally {
          markPending(rule.id, false);
        }
      }

      // Ephemeral / unsaved quick-connect session: run tunnel in-memory without
      // persisting a dangling hostId into Vault or cloud sync.
      const ephemeralRule: PortForwardingRule = {
        id: crypto.randomUUID(),
        label,
        type: 'local',
        localPort,
        bindAddress,
        remoteHost,
        remotePort: port.port,
        hostId,
        autoStart: false,
        status: 'connecting',
        createdAt: Date.now(),
      };
      upsertEphemeralRule(ephemeralRule);
      markPending(ephemeralRule.id, true);
      try {
        const result = await startPortForward(
          ephemeralRule,
          targetHost,
          context.effectiveHosts,
          context.keys,
          context.identities,
          (status, error) => {
            updateEphemeralRuleStatus(ephemeralRule.id, status, error);
          },
          false,
          context.terminalSettings,
          context.knownHosts,
        );
        if (!result.success) {
          deleteEphemeralRule(ephemeralRule.id);
          return { success: false, error: result.error };
        }
        return { success: true, rule: ephemeralRule };
      } finally {
        markPending(ephemeralRule.id, false);
      }
    },
    [
      addRule,
      canForward,
      canPersistRule,
      context,
      deleteRule,
      hostId,
      markPending,
      persistedRules,
      startTunnel,
      targetHost,
    ],
  );

  const stopQuickForward = useCallback(
    async (rule: PortForwardingRule): Promise<{ success: boolean; error?: string }> => {
      markPending(rule.id, true);
      try {
        if (ephemeralRulesMap.has(rule.id)) {
          clearReconnectTimer(rule.id);
          const result = await stopPortForward(rule.id, (status, error) => {
            updateEphemeralRuleStatus(rule.id, status, error);
          });
          if (result.success) {
            deleteEphemeralRule(rule.id);
          }
          return result;
        }
        return await stopTunnel(rule.id);
      } finally {
        markPending(rule.id, false);
      }
    },
    [markPending, stopTunnel],
  );

  return {
    canForward,
    hostId,
    allRules,
    pendingRuleIds,
    startQuickForward,
    stopQuickForward,
  };
}
