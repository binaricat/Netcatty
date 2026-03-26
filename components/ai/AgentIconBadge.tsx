import React from 'react';
import { cn } from '../../lib/utils';

type AgentLike = {
  id?: string;
  name?: string;
  type?: 'builtin' | 'external';
  icon?: string;
  command?: string;
};

type AgentIconKey =
  | 'catty'
  | 'openai'
  | 'claude'
  | 'anthropic'
  | 'gemini'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'zed'
  | 'atom'
| 'terminal'
  | 'plus';

type AgentIconVisual = {
  src: string;
  badgeClassName: string;
  imageClassName: string;
};

const AGENT_ICON_VISUALS: Record<AgentIconKey, AgentIconVisual> = {
  catty: {
    src: '/ai/agents/catty.svg',
    badgeClassName: 'border-violet-500/20 bg-violet-500/10',
    imageClassName: 'object-contain dark:brightness-0 dark:invert opacity-90',
  },
  openai: {
    src: '/ai/providers/openai.svg',
    badgeClassName: 'border-emerald-500/22 bg-emerald-500/12',
    imageClassName: 'object-contain dark:brightness-0 dark:invert',
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

function normalizeToken(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getAgentIconKey(agent: AgentLike | 'add-more'): AgentIconKey {
  if (agent === 'add-more') {
    return 'plus';
  }

  if (agent.type === 'builtin') {
    return 'catty';
  }

  const tokens = [
    normalizeToken(agent.icon),
    normalizeToken(agent.command),
    normalizeToken(agent.name),
    normalizeToken(agent.id),
  ].filter(Boolean);

  if (tokens.some((token) => token.includes('claude'))) {
    return 'claude';
  }
  if (tokens.some((token) => token.includes('anthropic'))) {
    return 'anthropic';
  }
  if (
    tokens.some(
      (token) =>
        token.includes('codex') ||
        token.includes('openai') ||
        token.includes('chatgpt'),
    )
  ) {
    return 'openai';
  }
  if (
    tokens.some(
      (token) =>
        token.includes('gemini') ||
        token.includes('google') ||
        token.includes('googlegemini'),
    )
  ) {
    return 'gemini';
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

export const AgentIconBadge: React.FC<{
  agent: AgentLike | 'add-more';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'plain' | 'badge';
  className?: string;
}> = ({ agent, size = 'md', variant = 'badge', className }) => {
  const visual = AGENT_ICON_VISUALS[getAgentIconKey(agent)];
  const badgeSize =
    size === 'xs'
      ? 'h-4 w-4 rounded-sm'
      : size === 'sm'
        ? 'h-7 w-7 rounded-lg'
        : size === 'lg'
          ? 'h-10 w-10 rounded-xl'
          : 'h-8 w-8 rounded-lg';
  const imageSize =
    size === 'xs'
      ? 'h-3.5 w-3.5'
      : size === 'sm'
        ? 'h-3.5 w-3.5'
        : size === 'lg'
          ? 'h-5 w-5'
          : 'h-4 w-4';

  if (variant === 'plain') {
    return (
      <div
        aria-hidden="true"
        className={cn('shrink-0', imageSize, className)}
        style={{
          maskImage: `url(${visual.src})`,
          WebkitMaskImage: `url(${visual.src})`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          backgroundColor: 'currentColor',
        }}
      />
    );
  }

  return (
    <div
      data-agent-badge=""
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden border',
        badgeSize,
        visual.badgeClassName,
        className,
      )}
    >
      <img
        src={visual.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn(imageSize, visual.imageClassName)}
      />
    </div>
  );
};

export default AgentIconBadge;
