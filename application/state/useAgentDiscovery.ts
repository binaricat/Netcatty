import { useCallback, useEffect, useState } from 'react';
import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';

interface NetcattyBridge {
  aiDiscoverAgents(): Promise<DiscoveredAgent[]>;
}

function getBridge(): NetcattyBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
}

export function useAgentDiscovery(
  externalAgents: ExternalAgentConfig[],
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void,
) {
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

  const discover = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) return;

    setIsDiscovering(true);
    try {
      const agents = await bridge.aiDiscoverAgents();
      setDiscoveredAgents(agents);
    } catch (err) {
      console.error('Agent discovery failed:', err);
    } finally {
      setIsDiscovering(false);
    }
  }, []);

  // Discover on mount
  useEffect(() => {
    discover();
  }, [discover]);

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

        // Check if args, ACP config, or Claude's resolved system path differ
        const currentArgs = JSON.stringify(ea.args || []);
        const newArgs = JSON.stringify(match.args);
        const acpChanged = ea.acpCommand !== match.acpCommand
          || JSON.stringify(ea.acpArgs || []) !== JSON.stringify(match.acpArgs || []);
        const env = match.command === 'claude'
          ? { ...(ea.env ?? {}), CLAUDE_CODE_EXECUTABLE: match.path }
          : ea.env;
        const envChanged = match.command === 'claude'
          && ea.env?.CLAUDE_CODE_EXECUTABLE !== match.path;
        if (currentArgs !== newArgs || acpChanged || envChanged) {
          changed = true;
          return { ...ea, args: match.args, acpCommand: match.acpCommand, acpArgs: match.acpArgs, ...(env ? { env } : {}) };
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
      return {
        id: `discovered_${agent.command}`,
        name: agent.name,
        command: agent.path || agent.command,
        args: agent.args,
        icon: agent.icon,
        enabled: true,
        acpCommand: agent.acpCommand,
        acpArgs: agent.acpArgs,
        ...(agent.command === 'claude' ? { env: { CLAUDE_CODE_EXECUTABLE: agent.path } } : {}),
      };
    },
    [],
  );

  return {
    discoveredAgents,
    unconfiguredAgents,
    isDiscovering,
    rediscover: discover,
    enableAgent,
  };
}
