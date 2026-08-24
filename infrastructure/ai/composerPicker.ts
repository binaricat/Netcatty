import type { AgentModelPreset, ProviderConfig } from './types';
import { formatThinkingLabel, PROVIDER_PRESETS, resolveAgentModelSelection } from './types';

export const CATTY_REASONING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type CattyReasoningLevel = (typeof CATTY_REASONING_LEVELS)[number];

export const CLAUDE_REASONING_LEVELS = ['low', 'medium', 'high', 'max'] as const;

export const COMPOSER_RECENT_MODEL_LIMIT = 6;
export const COMPOSER_PINNED_MODEL_LIMIT = 8;

export interface ComposerPickerModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

export interface ComposerModelPrefEntry {
  providerId?: string;
  modelId: string;
}

export interface ComposerModelPrefs {
  recent: ComposerModelPrefEntry[];
  pinned: ComposerModelPrefEntry[];
}

export function isCattyReasoningLevel(value: string | null | undefined): value is CattyReasoningLevel {
  return CATTY_REASONING_LEVELS.some((level) => level === value);
}

export function normalizeCattyReasoningLevel(
  value: string | null | undefined,
): CattyReasoningLevel {
  return isCattyReasoningLevel(value) ? value : 'off';
}

export function composerModelPrefKey(entry: ComposerModelPrefEntry): string {
  return entry.providerId ? `${entry.providerId}::${entry.modelId}` : entry.modelId;
}

export function sameComposerModelPref(
  left: ComposerModelPrefEntry,
  right: ComposerModelPrefEntry,
): boolean {
  return left.modelId === right.modelId && (left.providerId ?? '') === (right.providerId ?? '');
}

export function upsertComposerPrefFront(
  entries: ComposerModelPrefEntry[],
  next: ComposerModelPrefEntry,
  limit: number,
): ComposerModelPrefEntry[] {
  const filtered = entries.filter((entry) => !sameComposerModelPref(entry, next));
  return [next, ...filtered].slice(0, limit);
}

export function toggleComposerPinnedPref(
  entries: ComposerModelPrefEntry[],
  target: ComposerModelPrefEntry,
  limit = COMPOSER_PINNED_MODEL_LIMIT,
): ComposerModelPrefEntry[] {
  if (entries.some((entry) => sameComposerModelPref(entry, target))) {
    return entries.filter((entry) => !sameComposerModelPref(entry, target));
  }
  return upsertComposerPrefFront(entries, target, limit);
}

export function parseComposerModelPrefs(value: unknown): ComposerModelPrefs {
  if (!value || typeof value !== 'object') {
    return { recent: [], pinned: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    recent: parsePrefEntries(record.recent).slice(0, COMPOSER_RECENT_MODEL_LIMIT),
    pinned: parsePrefEntries(record.pinned).slice(0, COMPOSER_PINNED_MODEL_LIMIT),
  };
}

function parsePrefEntries(value: unknown): ComposerModelPrefEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: ComposerModelPrefEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const modelId = typeof (item as { modelId?: unknown }).modelId === 'string'
      ? (item as { modelId: string }).modelId.trim()
      : '';
    if (!modelId) continue;
    const providerId = typeof (item as { providerId?: unknown }).providerId === 'string'
      ? (item as { providerId: string }).providerId.trim()
      : undefined;
    const entry: ComposerModelPrefEntry = providerId ? { providerId, modelId } : { modelId };
    const key = composerModelPrefKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

export function resolveComposerEnterModelId(input: {
  query: string;
  models: ComposerPickerModel[];
  grouped: {
    pinned: ComposerPickerModel[];
    recent: ComposerPickerModel[];
    rest: ComposerPickerModel[];
  };
  filtered: ComposerPickerModel[];
  showCustom: boolean;
}): string | undefined {
  const trimmed = input.query.trim();
  if (!trimmed) return undefined;
  const exact = input.models.find((model) => model.id.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.id;
  if (input.showCustom) return trimmed;
  return input.grouped.pinned[0]?.id
    ?? input.grouped.recent[0]?.id
    ?? input.grouped.rest[0]?.id
    ?? input.filtered[0]?.id;
}

export function filterComposerModels(
  models: ComposerPickerModel[],
  query: string,
): ComposerPickerModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((model) => (
    model.id.toLowerCase().includes(q)
    || model.name.toLowerCase().includes(q)
    || (model.description ?? '').toLowerCase().includes(q)
  ));
}

export function buildProviderSeedModels(provider: ProviderConfig): ComposerPickerModel[] {
  const byId = new Map<string, ComposerPickerModel>();
  const defaultModel = provider.defaultModel?.trim();
  if (defaultModel) {
    byId.set(defaultModel, { id: defaultModel, name: defaultModel });
  }
  const presetModels = PROVIDER_PRESETS[provider.providerId]?.defaultModels ?? [];
  for (const modelId of presetModels) {
    const id = modelId.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, name: id });
  }
  return Array.from(byId.values());
}

export function mergeComposerModels(
  ...lists: Array<Iterable<ComposerPickerModel> | undefined>
): ComposerPickerModel[] {
  const byId = new Map<string, ComposerPickerModel>();
  for (const list of lists) {
    if (!list) continue;
    for (const model of list) {
      const id = model.id.trim();
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          id,
          name: model.name || id,
          ...(model.description ? { description: model.description } : {}),
          ...(model.contextWindow != null ? { contextWindow: model.contextWindow } : {}),
        });
        continue;
      }
      const contextWindow = existing.contextWindow ?? model.contextWindow;
      byId.set(id, {
        id,
        name: existing.name === existing.id && model.name ? model.name : existing.name,
        ...(existing.description || model.description
          ? { description: existing.description || model.description }
          : {}),
        ...(contextWindow != null ? { contextWindow } : {}),
      });
    }
  }
  return Array.from(byId.values());
}

export function canonicalizeEffortEncodedModelId(modelId: string): string {
  const queryIndex = modelId.indexOf('?');
  if (queryIndex < 0) return modelId;
  const id = modelId.slice(0, queryIndex);
  const params = new URLSearchParams(modelId.slice(queryIndex + 1));
  const keys = [...params.keys()];
  const effort = params.get('effort');
  if (keys.length === 1 && keys[0] === 'effort' && effort) {
    return `${id}/${effort}`;
  }
  return modelId;
}

export function resolveThinkingSelection(
  selectedModelId: string | undefined,
  presets: AgentModelPreset[],
): { preset?: AgentModelPreset; thinking?: string } {
  if (!selectedModelId) return {};
  const canonical = canonicalizeEffortEncodedModelId(selectedModelId);
  const direct = presets.find((preset) => preset.id === canonical);
  if (direct) return { preset: direct };
  const viaThinking = presets.find(
    (preset) => preset.thinkingLevels?.some((level) => `${preset.id}/${level}` === canonical),
  );
  if (!viaThinking) return {};
  return {
    preset: viaThinking,
    thinking: canonical.slice(viaThinking.id.length + 1),
  };
}

export function resolveModelSelectionWithThinking(
  preset: AgentModelPreset,
  preferredThinking?: string,
): string {
  const levels = preset.thinkingLevels;
  if (!levels?.length) return preset.id;
  if (preferredThinking && levels.includes(preferredThinking)) {
    return `${preset.id}/${preferredThinking}`;
  }
  return resolveAgentModelSelection(preset);
}

export function formatComposerThinkingLabel(level: string): string {
  if (level === 'off') return 'Off';
  return formatThinkingLabel(level);
}

export function resolvePinnedAndRecentModels(input: {
  models: ComposerPickerModel[];
  prefs: ComposerModelPrefs;
  providerId?: string;
  /** Catty custom IDs only. External catalogs must not resurrect stale prefs. */
  allowMissing?: boolean;
}): {
  pinned: ComposerPickerModel[];
  recent: ComposerPickerModel[];
  rest: ComposerPickerModel[];
} {
  const byId = new Map(input.models.map((model) => [model.id, model]));
  const matchesScope = (entry: ComposerModelPrefEntry) => (
    !input.providerId || !entry.providerId || entry.providerId === input.providerId
  );
  const allowMissing = input.allowMissing ?? false;
  const resolve = (entries: ComposerModelPrefEntry[]) => (
    entries
      .filter(matchesScope)
      .map((entry) => byId.get(entry.modelId) ?? (allowMissing ? { id: entry.modelId, name: entry.modelId } : undefined))
      .filter((model): model is ComposerPickerModel => model != null)
  );
  const pinned = resolve(input.prefs.pinned);
  const pinnedIds = new Set(pinned.map((model) => model.id));
  const recent = resolve(input.prefs.recent).filter((model) => !pinnedIds.has(model.id));
  const reservedIds = new Set([...pinnedIds, ...recent.map((model) => model.id)]);
  return {
    pinned,
    recent,
    rest: input.models.filter((model) => !reservedIds.has(model.id)),
  };
}
