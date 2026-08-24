import type { ProviderStyle } from './types';
import { resolveProviderStyle, type ProviderConfig } from './types';
import { CATTY_REASONING_LEVELS } from './composerPicker';

const ANTHROPIC_THINKING_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
};

const GEMINI_25_THINKING_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 1_024,
  medium: 8_192,
  high: 16_384,
};

const REASONING_RANK = ['off', 'minimal', 'low', 'medium', 'high'] as const;
const LEVELS_LOW_MEDIUM_HIGH = ['low', 'medium', 'high'] as const;
const LEVELS_LOW_HIGH = ['low', 'high'] as const;
const LEVELS_MINIMAL_LOW_MEDIUM_HIGH = ['minimal', 'low', 'medium', 'high'] as const;
const LEVELS_MINIMAL_HIGH = ['minimal', 'high'] as const;

export type CattyReasoningProviderOptions = Record<string, Record<string, unknown>>;

/** Extra completion tokens the SDK will add on top of maxTokens for thinking. */
export function estimateReasoningOutputReserve(
  options: CattyReasoningProviderOptions | undefined,
): number {
  if (!options) return 0;
  const anthropicThinking = options.anthropic?.thinking as { budgetTokens?: unknown } | undefined;
  if (typeof anthropicThinking?.budgetTokens === 'number' && anthropicThinking.budgetTokens > 0) {
    return Math.ceil(anthropicThinking.budgetTokens);
  }
  const googleConfig = options.google?.thinkingConfig as { thinkingBudget?: unknown } | undefined;
  if (typeof googleConfig?.thinkingBudget === 'number' && googleConfig.thinkingBudget > 0) {
    return Math.ceil(googleConfig.thinkingBudget);
  }
  return 0;
}

export function buildCattyReasoningProviderOptions(
  provider: Pick<ProviderConfig, 'providerId' | 'style'> | null | undefined,
  effort: string | null | undefined,
  modelId?: string,
): CattyReasoningProviderOptions | undefined {
  if (!provider) return undefined;
  const rawEffort = typeof effort === 'string' ? effort.trim() : '';
  if (!rawEffort) return undefined;
  const style: ProviderStyle = resolveProviderStyle(provider);
  const advertised = cattyReasoningLevelsForSelection(provider, modelId);
  const resolved = advertised.length
    ? resolveVisibleCattyThinkingLevel(advertised, rawEffort)
    : rawEffort;
  if (!resolved) return undefined;

  if (style === 'openai') {
    if (modelId && !openaiModelLikelySupportsReasoning(modelId)) return undefined;
    if (resolved === 'off') {
      if (modelId && openaiModelSupportsNoneReasoning(modelId)) {
        return { openai: { reasoningEffort: 'none' } };
      }
      return undefined;
    }
    return { openai: { reasoningEffort: resolved } };
  }

  if (style === 'anthropic') {
    if (modelId && !anthropicModelLikelySupportsThinking(modelId)) return undefined;
    if (resolved === 'off') {
      if (modelId && anthropicUsesAdaptiveThinking(modelId) && anthropicAllowsDisabledThinking(modelId)) {
        return { anthropic: { thinking: { type: 'disabled' } } };
      }
      return undefined;
    }
    if (resolved !== 'low' && resolved !== 'medium' && resolved !== 'high') return undefined;
    if (modelId && anthropicUsesAdaptiveThinking(modelId)) {
      return {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: resolved,
        },
      };
    }
    return {
      anthropic: {
        thinking: {
          type: 'enabled',
          budgetTokens: ANTHROPIC_THINKING_BUDGET[resolved],
        },
      },
    };
  }

  if (style === 'google') {
    if (!modelId || !googleModelLikelySupportsThinking(modelId)) return undefined;
    if (isGemini3Model(modelId)) {
      if (resolved !== 'minimal' && resolved !== 'low' && resolved !== 'medium' && resolved !== 'high') {
        return undefined;
      }
      return {
        google: {
          thinkingConfig: {
            thinkingLevel: resolved,
            includeThoughts: resolved !== 'minimal',
          },
        },
      };
    }
    if (resolved === 'off') {
      if (!googleModelAllowsDisabledThinking(modelId)) return undefined;
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: 0,
            includeThoughts: false,
          },
        },
      };
    }
    if (resolved !== 'low' && resolved !== 'medium' && resolved !== 'high') return undefined;
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: GEMINI_25_THINKING_BUDGET[resolved],
          includeThoughts: true,
        },
      },
    };
  }
  return undefined;
}

/** Extended thinking is Claude 3.7+ / 4+ / 5+; original Claude 3 Haiku/Sonnet reject it. */
export function anthropicModelLikelySupportsThinking(modelId: string): boolean {
  const parsed = parseClaudeModel(modelId);
  if (!parsed) return false;
  if (parsed.major >= 4) return true;
  return parsed.major === 3 && parsed.minor >= 7;
}

export function googleModelLikelySupportsThinking(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return /gemini-3|gemini-2\.5|gemini-2\.0-flash-thinking|thinking/.test(id);
}

/**
 * `reasoning_effort: "none"` is only valid on GPT-5.1+ (and later minors).
 * Bare gpt-5 / o3 / o4-mini accept low|medium|high (and sometimes minimal),
 * but reject none. Chat snapshots are not reasoners.
 */
export function openaiModelSupportsNoneReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id || openaiModelIsChatSnapshot(id)) return false;
  return /gpt-5\.(?:[1-9]\d*)/.test(id);
}

/** Original GPT-5 (not 5.1+) accepts `minimal` as the floor instead of `none`. */
export function openaiModelSupportsMinimalReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id || openaiModelIsChatSnapshot(id)) return false;
  if (openaiModelSupportsNoneReasoning(id)) return false;
  return /gpt-5/.test(id);
}

/** OpenAI-compat models that accept `reasoning_effort` (o-series, GPT-5, reasoners). */
export function openaiModelLikelySupportsReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (openaiModelIsChatSnapshot(id)) return false;
  return (
    /(^|[^a-z0-9])o[1-4]([^a-z0-9]|$)/.test(id)
    || /gpt-5/.test(id)
    || /gpt-oss/.test(id)
    || /reasoner|reasoning/.test(id)
    || /deepseek-r1/.test(id)
    || /grok-4/.test(id)
  );
}

/** Levels shown on the Catty thinking chip, or empty when the model cannot take them. */
export function cattyReasoningLevelsForSelection(
  provider: Pick<ProviderConfig, 'providerId' | 'style'> | null | undefined,
  modelId?: string,
): readonly string[] {
  if (!provider) return [];
  const style = resolveProviderStyle(provider);
  if (style === 'anthropic') {
    if (!modelId || !anthropicModelLikelySupportsThinking(modelId)) return [];
    if (!anthropicAllowsDisabledThinking(modelId)) return LEVELS_LOW_MEDIUM_HIGH;
    return CATTY_REASONING_LEVELS;
  }
  if (style === 'google') {
    if (!modelId || !googleModelLikelySupportsThinking(modelId)) return [];
    if (isGemini3Model(modelId)) return gemini3AdvertisedLevels(modelId);
    if (!googleModelAllowsDisabledThinking(modelId)) return LEVELS_LOW_MEDIUM_HIGH;
    return CATTY_REASONING_LEVELS;
  }
  if (style === 'openai') {
    if (!modelId || !openaiModelLikelySupportsReasoning(modelId)) return [];
    if (openaiModelSupportsNoneReasoning(modelId)) return CATTY_REASONING_LEVELS;
    if (openaiModelSupportsMinimalReasoning(modelId)) return LEVELS_MINIMAL_LOW_MEDIUM_HIGH;
    return LEVELS_LOW_MEDIUM_HIGH;
  }
  return [];
}

/**
 * Pick a level the current model actually advertises; never keep a stale chip value.
 * Missing mid-levels prefer the next higher advertised value (Gemini 3 Pro medium → high)
 * so the chip, persisted pref, and request payload stay aligned.
 */
export function resolveVisibleCattyThinkingLevel(
  levels: readonly string[],
  selected: string | undefined,
): string | undefined {
  if (!levels.length) return undefined;
  const raw = selected?.trim().toLowerCase();
  if (raw && levels.includes(raw)) return raw;
  if (raw === 'off') {
    if (levels.includes('minimal')) return 'minimal';
    return levels[0];
  }
  const selectedRank = raw ? REASONING_RANK.indexOf(raw as typeof REASONING_RANK[number]) : -1;
  if (selectedRank < 0) return levels[0];
  for (let i = selectedRank + 1; i < REASONING_RANK.length; i += 1) {
    if (levels.includes(REASONING_RANK[i])) return REASONING_RANK[i];
  }
  for (let i = selectedRank - 1; i >= 0; i -= 1) {
    if (levels.includes(REASONING_RANK[i])) return REASONING_RANK[i];
  }
  return levels[0];
}

function openaiModelIsChatSnapshot(modelId: string): boolean {
  return /gpt-5(?:\.\d+)?-chat/.test(modelId);
}

function isGemini3Model(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes('gemini-3');
}

function gemini3AdvertisedLevels(modelId: string): readonly string[] {
  const id = modelId.trim().toLowerCase();
  if (/flash-lite-image/.test(id)) return LEVELS_MINIMAL_HIGH;
  if (/gemini-3\.7/.test(id) && /flash/.test(id)) return LEVELS_LOW_MEDIUM_HIGH;
  if (/pro/.test(id) && !/flash/.test(id)) {
    return /gemini-3\.1/.test(id) ? LEVELS_LOW_MEDIUM_HIGH : LEVELS_LOW_HIGH;
  }
  if (/flash/.test(id)) return LEVELS_MINIMAL_LOW_MEDIUM_HIGH;
  return LEVELS_LOW_MEDIUM_HIGH;
}

function googleModelAllowsDisabledThinking(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return /flash-lite|flash/.test(id) && !/pro/.test(id);
}

type ClaudeModel = {
  family: string;
  major: number;
  minor: number;
};

function parseClaudeMinor(raw: string | undefined): number {
  if (!raw) return 0;
  const minor = Number.parseInt(raw, 10);
  // Date suffixes like 20250514 are not minor versions.
  return Number.isFinite(minor) && minor < 100 ? minor : 0;
}

function parseClaudeModel(modelId: string): ClaudeModel | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  const familyMatch = id.match(
    /claude-(opus|sonnet|haiku|fable|mythos)(?:-preview)?(?:[-.](\d+)(?:[-.](\d+))?)?/,
  );
  if (familyMatch) {
    return {
      family: familyMatch[1],
      major: familyMatch[2] ? Number.parseInt(familyMatch[2], 10) : 5,
      minor: parseClaudeMinor(familyMatch[3]),
    };
  }
  const threeSeven = id.match(/claude-3[-.]7/);
  if (threeSeven) return { family: 'sonnet', major: 3, minor: 7 };
  const bare = id.match(/claude-(\d+)(?:[-.](\d+))?/);
  if (bare) {
    return {
      family: 'claude',
      major: Number.parseInt(bare[1], 10),
      minor: parseClaudeMinor(bare[2]),
    };
  }
  return null;
}

/** 4.6+ and Claude 5 reject or deprecate manual `type: "enabled"`. */
function anthropicUsesAdaptiveThinking(modelId: string): boolean {
  const parsed = parseClaudeModel(modelId);
  if (!parsed) return false;
  if (parsed.major >= 5) return true;
  return parsed.major === 4 && parsed.minor >= 6;
}

/** Fable 5 / Mythos 5 are always-on and reject `thinking.type: "disabled"`. */
function anthropicAllowsDisabledThinking(modelId: string): boolean {
  const parsed = parseClaudeModel(modelId);
  if (!parsed) return true;
  return parsed.family !== 'fable' && parsed.family !== 'mythos';
}
