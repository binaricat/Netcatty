import { useCallback, useEffect, useState } from 'react';
import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { getExternalAgentSdkBackend } from '../../infrastructure/ai/managedAgents';

interface NetcattyBridge {
  aiDiscoverAgents(options?: { refreshShellEnv?: boolean; apiKeyPresent?: boolean }): Promise<DiscoveredAgent[]>;
}

function getBridge(): NetcattyBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
}

export function useAgentDiscovery(
  externalAgents: ExternalAgentConfig[],
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

  const cursorApiKeyPresent = externalAgents.some(
    (agent) => agent.id === "discovered_cursor" && Boolean(agent.apiKey),
  );

  const discover = useCallback(async (discoverOptions?: { refreshShellEnv?: boolean }) => {
    const bridge = getBridge();
    if (!bridge) return;

    setIsDiscovering(true);
    try {
      const agents = await bridge.aiDiscoverAgents({
        ...discoverOptions,
        apiKeyPresent: cursorApiKeyPresent,
      });
      setDiscoveredAgents(agents);
    } catch (err) {
      console.error('Agent discovery failed:', err);
    } finally {
      setIsDiscovering(false);
    }
  }, [cursorApiKeyPresent]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const runDiscover = () => {
      if (!cancelled) void discover();
    };

    if (typeof requestIdleCallback === 'function') {
      const idleId = requestIdleCallback(runDiscover, { timeout: 2000 });
      return () => {
        cancelled = true;
        cancelIdleCallback(idleId);
      };
    }

    const timeoutId = setTimeout(runDiscover, 0);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [discover, enabled]);

  // Auto-update args for already-configured discovered agents when
  // the canonical args from discovery change (e.g. after an app update).
  useEffect(() => {
    if (!setExternalAgents || discoveredAgents.length === 0) return;

    setExternalAgents((prev) => {
      let changed = false;
      const next = prev.map((ea) => {
        // Only update agents that were auto-discovered (id starts with "discovered_")
        if (!ea.id.startsWith('discovered_')) return ea;

        const match = discoveredAgents.find(
          (da) => ea.command === da.path || ea.command === da.command,
        );
        if (!match) return ea;

        // Check if args, SDK backend, or Claude's resolved system path differ
        const currentArgs = JSON.stringify(ea.args || []);
        const newArgs = JSON.stringify(match.args);
        const backend = match.sdkBackend ?? match.command;
        const backendChanged = getExternalAgentSdkBackend(ea) !== backend
          || Boolean(ea.acpCommand)
          || JSON.stringify(ea.acpArgs || []) !== JSON.stringify([]);
        const matchPath = match.binPath || match.path;
        const env = match.command === 'claude'
          ? { ...(ea.env ?? {}), CLAUDE_CODE_EXECUTABLE: matchPath }
          : ea.env;
        const envChanged = match.command === 'claude'
          && ea.env?.CLAUDE_CODE_EXECUTABLE !== matchPath;
        if (currentArgs !== newArgs || backendChanged || envChanged) {
          changed = true;
          const { acpCommand: _legacyCommand, acpArgs: _legacyArgs, ...rest } = ea;
          return { ...rest, args: match.args, sdkBackend: backend, ...(env ? { env } : {}) };
        }
        return ea;
      });
      return changed ? next : prev;
    });
  }, [discoveredAgents, setExternalAgents]);

  // Filter out agents that are already configured as external agents
  const unconfiguredAgents = discoveredAgents.filter(
    (da) => !externalAgents.some(
      (ea) => ea.command === da.command || ea.command === da.path,
    ),
  );

  // Build ExternalAgentConfig from a discovered agent
  const enableAgent = useCallback(
    (agent: DiscoveredAgent): ExternalAgentConfig => {
      const backend = agent.sdkBackend ?? agent.command;
      return {
        id: `discovered_${agent.command}`,
        name: agent.name,
        command: agent.binPath || agent.path || agent.command,
        args: agent.args,
        icon: agent.icon,
        enabled: true,
        sdkBackend: backend,
        ...(agent.command === 'claude'
          ? { env: { CLAUDE_CODE_EXECUTABLE: agent.binPath || agent.path || '' } }
          : {}),
      };
    },
    [],
  );

  return {
    discoveredAgents,
    unconfiguredAgents,
    isDiscovering,
    rediscover: () => discover({ refreshShellEnv: true }),
    enableAgent,
  };
}
