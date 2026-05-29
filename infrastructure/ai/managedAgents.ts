import type { DiscoveredAgent, ExternalAgentConfig } from './types';

export type ManagedAgentKey = 'codex' | 'claude' | 'copilot' | 'codebuddy';

const MANAGED_AGENT_META: Record<ManagedAgentKey, { commandNames: string[]; acpCommand: string }> = {
  codex: { commandNames: ['codex', 'codex-acp'], acpCommand: 'codex-acp' },
  claude: { commandNames: ['claude'], acpCommand: 'claude-agent-acp' },
  copilot: { commandNames: ['copilot'], acpCommand: 'copilot' },
  codebuddy: { commandNames: ['codebuddy'], acpCommand: 'codebuddy' },
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
  return agent.command === 'codex' || agent.command === 'claude' || agent.command === 'copilot' || agent.command === 'codebuddy';
}

export function matchesManagedAgentConfig(
  agent: Pick<ExternalAgentConfig, 'id' | 'command' | 'acpCommand'>,
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
    getCommandBasename(agent.acpCommand) === meta.acpCommand ||
    meta.commandNames.some((commandName) => basename === commandName || basename.startsWith(`${commandName}.`))
  );
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
