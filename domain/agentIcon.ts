import {
  matchCodingCliProviderFromCommand,
  matchCodingCliProviderFromTitle,
} from './codingCliProviderMatch';

export type AgentIconKey =
  | 'catty'
  | 'copilot'
  | 'cursor'
  | 'openai'
  | 'codex'
  | 'claude'
  | 'anthropic'
  | 'gemini'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'zed'
  | 'atom'
  | 'droid'
  | 'opencode'
  | 'kimi'
  | 'codebuddy'
  | 'terminal'
  | 'plus';

export type AgentIconVisual = {
  src: string;
  badgeClassName: string;
  imageClassName: string;
};

export const AGENT_ICON_VISUALS: Record<AgentIconKey, AgentIconVisual> = {
  catty: {
    src: '/ai/agents/catty.svg',
    badgeClassName: 'border-violet-500/20 bg-violet-500/10',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  copilot: {
    src: '/ai/agents/copilot.svg',
    badgeClassName: 'border-zinc-300 bg-white',
    imageClassName: 'object-contain brightness-0',
  },
  cursor: {
    src: '/ai/agents/cursor.svg',
    badgeClassName: 'border-zinc-500/22 bg-zinc-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  openai: {
    src: '/ai/providers/openai.svg',
    badgeClassName: 'border-emerald-500/22 bg-emerald-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  codex: {
    src: '/ai/agents/codex.svg',
    badgeClassName: 'border-emerald-500/22 bg-emerald-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-95',
  },
  claude: {
    src: '/ai/agents/claude.svg',
    badgeClassName: 'border-orange-500/22 bg-orange-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  anthropic: {
    src: '/ai/providers/anthropic.svg',
    badgeClassName: 'border-orange-500/22 bg-orange-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  gemini: {
    src: '/ai/agents/gemini.svg',
    badgeClassName: 'border-sky-500/22 bg-sky-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  google: {
    src: '/ai/providers/google.svg',
    badgeClassName: 'border-sky-500/22 bg-sky-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  ollama: {
    src: '/ai/providers/ollama.svg',
    badgeClassName: 'border-violet-500/22 bg-violet-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  openrouter: {
    src: '/ai/providers/openrouter.svg',
    badgeClassName: 'border-fuchsia-500/22 bg-fuchsia-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  zed: {
    src: '/ai/agents/zed.svg',
    badgeClassName: 'border-cyan-500/22 bg-cyan-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
  },
  atom: {
    src: '/ai/agents/atom.svg',
    badgeClassName: 'border-amber-500/18 bg-amber-500/10',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  droid: {
    src: '/ai/agents/droid.svg',
    badgeClassName: 'border-orange-500/22 bg-orange-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-95',
  },
  opencode: {
    src: '/ai/agents/opencode.svg',
    badgeClassName: 'border-slate-500/22 bg-slate-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  kimi: {
    src: '/ai/providers/kimi.svg',
    badgeClassName: 'border-zinc-500/22 bg-zinc-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  codebuddy: {
    src: '/ai/agents/codebuddy.svg',
    badgeClassName: 'border-indigo-500/22 bg-indigo-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  terminal: {
    src: '/ai/agents/terminal.svg',
    badgeClassName: 'border-white/8 bg-white/[0.04]',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  plus: {
    src: '/ai/agents/plus.svg',
    badgeClassName: 'border-white/8 bg-white/[0.04]',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-85',
  },
};

export type AgentIconSource = {
  icon?: string;
  command?: string;
  name?: string;
  id?: string;
  type?: 'builtin' | 'external';
};

const GENERIC_AGENT_ICON_KEYS = new Set<AgentIconKey>(['terminal', 'plus', 'catty']);

export function normalizeAgentToken(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function resolveAgentIconKey(source: AgentIconSource | 'add-more'): AgentIconKey {
  if (source === 'add-more') {
    return 'plus';
  }

  if (source.type === 'builtin') {
    return 'catty';
  }

  const commandCandidates = [source.command, source.name, source.id].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  for (const commandLine of commandCandidates) {
    const provider = matchCodingCliProviderFromCommand(commandLine);
    if (provider) return provider.iconKey;
  }

  const titleCandidates = [source.name, source.id, source.icon].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  for (const title of titleCandidates) {
    const provider = matchCodingCliProviderFromTitle(title);
    if (provider) return provider.iconKey;
  }

  const tokens = [
    normalizeAgentToken(source.icon),
    normalizeAgentToken(source.command),
    normalizeAgentToken(source.name),
    normalizeAgentToken(source.id),
  ].filter(Boolean);

  if (tokens.some((token) => token.includes('anthropic'))) {
    return 'anthropic';
  }
  if (
    tokens.some(
      (token) =>
        token.includes('openai') ||
        token.includes('chatgpt'),
    )
  ) {
    return 'openai';
  }
  if (
    tokens.some(
      (token) =>
        token.includes('google') ||
        token.includes('googlegemini'),
    )
  ) {
    return 'google';
  }
  if (tokens.some((token) => token.includes('ollama'))) {
    return 'ollama';
  }
  if (tokens.some((token) => token.includes('openrouter'))) {
    return 'openrouter';
  }
  if (tokens.some((token) => token.includes('zed'))) {
    return 'zed';
  }
  if (tokens.some((token) => token.includes('factory'))) {
    return 'atom';
  }

  return 'terminal';
}

export function isRecognizedAgentIconKey(key: AgentIconKey): boolean {
  return !GENERIC_AGENT_ICON_KEYS.has(key);
}

export function getAgentIconVisual(key: AgentIconKey): AgentIconVisual {
  return AGENT_ICON_VISUALS[key];
}
