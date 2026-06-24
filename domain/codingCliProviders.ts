import type { AgentIconKey } from './agentIcon';

export type CodingCliProviderId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'kimi'
  | 'droid'
  | 'copilot'
  | 'cursor'
  | 'codebuddy';

export type CodingCliProvider = {
  id: CodingCliProviderId;
  label: string;
  /** Primary CLI executable basename, e.g. `claude` or `codex`. */
  command: string;
  /** Alternate executable names that should resolve to this provider. */
  aliases?: string[];
  /** Substrings commonly present in OSC window titles for this CLI. */
  titleHints?: string[];
  iconKey: AgentIconKey;
};

/**
 * Built-in coding CLI providers shown on terminal session tabs.
 * Command names align with common agent launch binaries.
 */
export const CODING_CLI_PROVIDERS: readonly CodingCliProvider[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    titleHints: ['claude code', 'claude'],
    iconKey: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    titleHints: ['codex', 'chatgpt'],
    iconKey: 'codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    titleHints: ['opencode'],
    iconKey: 'opencode',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    titleHints: ['gemini'],
    iconKey: 'gemini',
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    command: 'kimi',
    aliases: ['moonshot'],
    titleHints: ['kimi', 'moonshot'],
    iconKey: 'kimi',
  },
  {
    id: 'droid',
    label: 'Droid',
    command: 'droid',
    aliases: ['factory'],
    titleHints: ['droid', 'factory droid', 'factory ai'],
    iconKey: 'droid',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: 'copilot',
    titleHints: ['copilot', 'github copilot'],
    iconKey: 'copilot',
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor',
    titleHints: ['cursor'],
    iconKey: 'cursor',
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    command: 'codebuddy',
    titleHints: ['codebuddy'],
    iconKey: 'codebuddy',
  },
] as const;

const PROVIDER_BY_ID = new Map(
  CODING_CLI_PROVIDERS.map((provider) => [provider.id, provider] as const),
);

export function getCodingCliProvider(id: CodingCliProviderId): CodingCliProvider | undefined {
  return PROVIDER_BY_ID.get(id);
}
