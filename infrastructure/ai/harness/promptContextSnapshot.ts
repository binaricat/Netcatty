import type { AIPermissionMode } from '../types';

export interface PromptContextSnapshot {
  version: 2;
  audience: import('../agentKinds').AgentKind;
  providerId?: string;
  modelId?: string;
  permissionMode: AIPermissionMode;
  scopeType: 'terminal' | 'workspace' | 'global';
  scopeLabel?: string;
  toolNames: string[];
  selectedSkillSlugs: string[];
  systemPromptChars: number;
  systemPromptHash: string;
  injections: Array<{
    order: number;
    source: 'system-prompt' | 'capability-catalog' | 'user-skills' | 'terminal-scope' | 'web-search';
    itemCount: number;
    chars?: number;
    hash: string;
  }>;
  webSearchEnabled: boolean;
  hostSessionIds: string[];
  /** Dynamic request estimate used by the Catty context meter. */
  contextWindow?: number;
  estimatedInputTokens?: number;
  builtAt: number;
}

export function buildPromptContextSnapshot(input: {
  agentKind?: import('../agentKinds').AgentKind;
  providerId?: string;
  modelId?: string;
  permissionMode: AIPermissionMode;
  scopeType: 'terminal' | 'workspace' | 'global';
  scopeLabel?: string;
  toolNames: string[];
  selectedSkillSlugs?: string[];
  systemPrompt: string;
  webSearchEnabled: boolean;
  hostSessionIds: string[];
  builtAt?: number;
}): PromptContextSnapshot {
  const toolNames = [...input.toolNames].sort();
  const selectedSkillSlugs = [...(input.selectedSkillSlugs ?? [])].sort();
  const hostSessionIds = [...input.hostSessionIds];
  const injectionValues = [
    { source: 'system-prompt' as const, values: [input.systemPrompt], chars: input.systemPrompt.length },
    { source: 'capability-catalog' as const, values: toolNames },
    { source: 'user-skills' as const, values: selectedSkillSlugs },
    { source: 'terminal-scope' as const, values: hostSessionIds },
    { source: 'web-search' as const, values: [String(input.webSearchEnabled)] },
  ];
  return {
    version: 2,
    audience: input.agentKind ?? 'sidebar',
    providerId: input.providerId,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    scopeType: input.scopeType,
    scopeLabel: input.scopeLabel,
    toolNames,
    selectedSkillSlugs,
    systemPromptChars: input.systemPrompt.length,
    systemPromptHash: hashPromptPart(input.systemPrompt),
    injections: injectionValues.map((entry, order) => ({
      order,
      source: entry.source,
      itemCount: entry.values.length,
      ...(entry.chars != null ? { chars: entry.chars } : {}),
      hash: hashPromptPart(entry.values.join('\n')),
    })),
    webSearchEnabled: input.webSearchEnabled,
    hostSessionIds,
    builtAt: input.builtAt ?? Date.now(),
  };
}

function hashPromptPart(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
