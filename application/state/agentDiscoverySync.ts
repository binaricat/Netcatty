import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import {
  getExternalAgentSdkBackend,
  isSettingsManagedDiscoveredAgent,
  matchesManagedAgentConfig,
} from '../../infrastructure/ai/managedAgents';

function findMatchingDiscoveredAgent(
  agent: ExternalAgentConfig,
  discoveredAgents: DiscoveredAgent[],
): DiscoveredAgent | undefined {
  return discoveredAgents.find((discovered) => {
    if (
      isSettingsManagedDiscoveredAgent(discovered)
      && matchesManagedAgentConfig(agent, discovered.command)
    ) {
      return true;
    }
    return agent.command === discovered.path || agent.command === discovered.command;
  });
}

/** Apply rediscovery results onto already-configured discovered_* agents. */
export function applyDiscoveredUpdatesToExternalAgents(
  agents: ExternalAgentConfig[],
  discoveredAgents: DiscoveredAgent[],
): ExternalAgentConfig[] {
  let changed = false;
  const next = agents.map((ea) => {
    if (!ea.id.startsWith('discovered_')) return ea;

    const match = findMatchingDiscoveredAgent(ea, discoveredAgents);
    if (!match) return ea;

    const currentArgs = JSON.stringify(ea.args || []);
    const newArgs = JSON.stringify(match.args);
    const backend = match.sdkBackend ?? match.command;
    const backendChanged = getExternalAgentSdkBackend(ea) !== backend
      || Boolean(ea.acpCommand)
      || JSON.stringify(ea.acpArgs || []) !== JSON.stringify([]);
    const matchPath = match.binPath || match.path;
    const env = match.command === 'claude'
      ? { ...(ea.env ?? {}), CLAUDE_CODE_EXECUTABLE: matchPath }
      : match.command === 'opencode'
        ? { ...(ea.env ?? {}), OPENCODE_BIN: matchPath }
        : ea.env;
    const envChanged =
      (match.command === 'claude' && ea.env?.CLAUDE_CODE_EXECUTABLE !== matchPath)
      || (match.command === 'opencode' && ea.env?.OPENCODE_BIN !== matchPath);
    const versionChanged = Boolean(match.version) && ea.cliVersion !== match.version;
    // Discovery only returns agents that are currently available; recover sticky
    // available:false after a later SDK/auth probe succeeds (e.g. Antigravity key).
    const availableChanged = ea.available === false && match.available !== false;
    const commandChanged = match.command === 'antigravity'
      && Boolean(matchPath)
      && ea.commandSource !== 'manual'
      && ea.command !== matchPath;
    if (
      currentArgs !== newArgs
      || backendChanged
      || envChanged
      || versionChanged
      || availableChanged
      || commandChanged
    ) {
      changed = true;
      const { acpCommand: _legacyCommand, acpArgs: _legacyArgs, ...rest } = ea;
      return {
        ...rest,
        args: match.args,
        sdkBackend: backend,
        ...(commandChanged ? { command: matchPath } : {}),
        ...(availableChanged ? { available: true } : {}),
        ...(match.version ? { cliVersion: match.version } : {}),
        ...(env ? { env } : {}),
      };
    }
    return ea;
  });
  return changed ? next : agents;
}
