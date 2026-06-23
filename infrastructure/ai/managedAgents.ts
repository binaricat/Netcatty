import type { DiscoveredAgent, ExternalAgentConfig } from './types';

export type ManagedAgentKey = 'codex' | 'claude' | 'copilot' | 'cursor' | 'codebuddy' | 'opencode';

const MANAGED_AGENT_META: Record<ManagedAgentKey, { commandNames: string[]; sdkBackend: string }> = {
  codex: { commandNames: ['codex'], sdkBackend: 'codex' },
  claude: { commandNames: ['claude'], sdkBackend: 'claude' },
  copilot: { commandNames: ['copilot'], sdkBackend: 'copilot' },
  cursor: { commandNames: ['cursor'], sdkBackend: 'cursor' },
  codebuddy: { commandNames: ['codebuddy'], sdkBackend: 'codebuddy' },
  opencode: { commandNames: ['opencode'], sdkBackend: 'opencode' },
};

function getCommandBasename(command: string | undefined): string {
  const normalized = String(command || '').trim();
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/);
  return (parts.pop() || '').toLowerCase();
}

function isPathLikeCommand(command: string | undefined): boolean {
  const normalized = String(command || '').trim();
  return normalized.includes('/') || normalized.includes('\\');
}

function matchesPrimaryCliBasename(command: string | undefined, agentKey: ManagedAgentKey): boolean {
  const basename = getCommandBasename(command);
  return basename === agentKey || basename.startsWith(`${agentKey}.`);
}

export function isSettingsManagedDiscoveredAgent(
  agent: Pick<DiscoveredAgent, 'command'>,
): agent is Pick<DiscoveredAgent, 'command'> & { command: ManagedAgentKey } {
  return agent.command === 'codex'
    || agent.command === 'claude'
    || agent.command === 'copilot'
    || agent.command === 'cursor'
    || agent.command === 'codebuddy'
    || agent.command === 'opencode';
}

export function matchesManagedAgentConfig(
  agent: Pick<ExternalAgentConfig, 'id' | 'command' | 'sdkBackend' | 'acpCommand'>,
  agentKey: ManagedAgentKey,
): boolean {
  const meta = MANAGED_AGENT_META[agentKey];
  const basename = getCommandBasename(agent.command);
  if (agentKey === 'claude') {
    return (
      agent.id === 'discovered_claude' ||
      basename === 'claude' ||
      basename.startsWith('claude.')
    );
  }
  return (
    agent.id === `discovered_${agentKey}` ||
    getExternalAgentSdkBackend(agent) === meta.sdkBackend ||
    meta.commandNames.some((commandName) => basename === commandName || basename.startsWith(`${commandName}.`))
  );
}

export function getExternalAgentSdkBackend(
  agent: Pick<ExternalAgentConfig, 'sdkBackend' | 'acpCommand'> | undefined,
): string | undefined {
  return agent?.sdkBackend || agent?.acpCommand || undefined;
}

export function getManagedAgentStoredPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string | null {
  const managedId = `discovered_${agentKey}`;
  const preferredAgent = agents.find(
    (agent) =>
      agent.id === managedId &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  if (preferredAgent) {
    return preferredAgent.command;
  }

  const fallbackAgent = agents.find(
    (agent) =>
      matchesManagedAgentConfig(agent, agentKey) &&
      isPathLikeCommand(agent.command) &&
      matchesPrimaryCliBasename(agent.command, agentKey),
  );
  return fallbackAgent?.command ?? null;
}
