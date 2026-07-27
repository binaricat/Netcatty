import type { DiscoveredAgent, ExternalAgentConfig } from '../../infrastructure/ai/types';
import {
  getExternalAgentSdkBackend,
  isLegacyAntigravityRuntimeCommand,
  isPathLikeCommand,
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

    const isManagedAntigravity = (
      ea.id === 'discovered_antigravity'
      || getExternalAgentSdkBackend(ea) === 'antigravity'
    );
    const obsoleteApiKey = isManagedAntigravity && Boolean(ea.apiKey);
    const legacyAntigravityRuntime = isManagedAntigravity
      && isLegacyAntigravityRuntimeCommand(ea.command);
    const manualExecutable = ea.commandSource === 'manual'
      || (
        ea.commandSource == null
        && isPathLikeCommand(ea.command)
        && !legacyAntigravityRuntime
      );
    const match = findMatchingDiscoveredAgent(ea, discoveredAgents);
    if (!match) {
      const legacyAvailableChanged = legacyAntigravityRuntime && ea.available !== false;
      if (!obsoleteApiKey && !legacyAvailableChanged) return ea;
      changed = true;
      const cleaned = { ...ea };
      delete cleaned.apiKey;
      if (legacyAvailableChanged) cleaned.available = false;
      return cleaned;
    }

    const currentArgs = JSON.stringify(ea.args || []);
    const newArgs = JSON.stringify(match.args);
    const backend = match.sdkBackend ?? match.command;
    const backendChanged = getExternalAgentSdkBackend(ea) !== backend
      || Boolean(ea.acpCommand)
      || JSON.stringify(ea.acpArgs || []) !== JSON.stringify([]);
    const matchPath = match.binPath || match.path;
    // Manual executables must not inherit available/version/env from an unrelated
    // PATH discovery result (e.g. /custom/agy vs /usr/local/bin/agy).
    const canApplyExecutableStatus = !manualExecutable
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
    // Recover sticky available:false only for Antigravity after a later CLI/auth
    // probe succeeds. Cursor discovery available is a union of API-key and
    // CLI-login modes; applying it here would enable send while cursorAuthMode
    // remains the unusable mode. Cursor availability is mode-gated in Settings.
    const availableChanged = canApplyExecutableStatus
      && match.command === 'antigravity'
      && ea.available === false
      && match.available !== false;
    const commandChanged = match.command === 'antigravity'
      && Boolean(matchPath)
      && !manualExecutable
      && ea.command !== matchPath;
    const legacyAvailableChanged = legacyAntigravityRuntime
      && !canApplyExecutableStatus
      && ea.available !== false;
    if (
      currentArgs !== newArgs
      || backendChanged
      || envChanged
      || versionChanged
      || availableChanged
      || commandChanged
      || legacyAvailableChanged
      || obsoleteApiKey
    ) {
      changed = true;
      const rest = { ...ea };
      delete rest.acpCommand;
      delete rest.acpArgs;
      if (obsoleteApiKey) delete rest.apiKey;
      return {
        ...rest,
        args: match.args,
        sdkBackend: backend,
        ...(commandChanged ? { command: matchPath } : {}),
        ...(availableChanged ? { available: true } : {}),
        ...(legacyAvailableChanged ? { available: false } : {}),
        ...(canApplyExecutableStatus && match.version ? { cliVersion: match.version } : {}),
        ...(env ? { env } : {}),
      };
    }
    return ea;
  });
  return changed ? next : agents;
}
