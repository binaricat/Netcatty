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

function discoveredPathMatchesConfigured(
  agent: ExternalAgentConfig,
  match: DiscoveredAgent,
  matchPath: string | undefined,
): boolean {
  return agent.command === matchPath
    || agent.command === match.path
    || agent.command === match.command;
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
    // Manual executables must not inherit available/version/env from an unrelated
    // PATH discovery result (e.g. /custom/python vs /usr/bin/python3).
    const canApplyExecutableStatus = ea.commandSource !== 'manual'
      || discoveredPathMatchesConfigured(ea, match, matchPath);
    const env = canApplyExecutableStatus && match.command === 'claude'
      ? { ...(ea.env ?? {}), CLAUDE_CODE_EXECUTABLE: matchPath }
      : canApplyExecutableStatus && match.command === 'opencode'
        ? { ...(ea.env ?? {}), OPENCODE_BIN: matchPath }
        : ea.env;
    const envChanged = canApplyExecutableStatus && (
      (match.command === 'claude' && ea.env?.CLAUDE_CODE_EXECUTABLE !== matchPath)
      || (match.command === 'opencode' && ea.env?.OPENCODE_BIN !== matchPath)
    );
    const versionChanged = canApplyExecutableStatus
      && Boolean(match.version)
      && ea.cliVersion !== match.version;
    // Recover sticky available:false only for Antigravity after a later SDK/auth
    // probe succeeds. Cursor discovery available is a union of API-key and
    // CLI-login modes; applying it here would enable send while cursorAuthMode
    // remains the unusable mode. Cursor availability is mode-gated in Settings.
    const availableChanged = canApplyExecutableStatus
      && match.command === 'antigravity'
      && ea.available === false
      && match.available !== false;
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
        ...(canApplyExecutableStatus && match.version ? { cliVersion: match.version } : {}),
        ...(env ? { env } : {}),
      };
    }
    return ea;
  });
  return changed ? next : agents;
}
