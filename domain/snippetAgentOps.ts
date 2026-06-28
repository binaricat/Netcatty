import type { Host, ScriptLanguage, ScriptTrigger, Snippet, SnippetKind } from './models';
import {
  getHostConnectScriptIds,
  removeHostConnectScript,
  resolveConnectScriptsForHost,
  syncHostsForSnippetTargetChange,
} from './hostConnectScripts.ts';
import { isScriptSnippet } from './snippetScript.ts';
import { getNextVaultOrder } from './vaultOrder.ts';

export type SnippetAgentListItem = ReturnType<typeof serializeSnippetForAgentList>;
export type SnippetAgentDetail = ReturnType<typeof serializeSnippetForAgentGet>;

export function filterScriptSnippets(snippets: Snippet[]): Snippet[] {
  return snippets.filter(isScriptSnippet);
}

export function serializeSnippetForAgentList(snippet: Snippet) {
  return {
    id: snippet.id,
    label: snippet.label,
    kind: snippet.kind ?? 'snippet',
    tags: snippet.tags ?? [],
    targets: snippet.targets ?? [],
    targetsAllHosts: snippet.targetsAllHosts ?? false,
    package: snippet.package,
    shortkey: snippet.shortkey,
    noAutoRun: snippet.noAutoRun,
    language: snippet.language,
    description: snippet.description,
    trigger: snippet.trigger,
    triggerPattern: snippet.triggerPattern,
  };
}

export function serializeSnippetForAgentGet(snippet: Snippet) {
  return {
    ...serializeSnippetForAgentList(snippet),
    command: snippet.command,
  };
}

export function serializeScriptForAgentList(snippet: Snippet) {
  return serializeSnippetForAgentList(snippet);
}

export function serializeScriptForAgentGet(snippet: Snippet) {
  return serializeSnippetForAgentGet(snippet);
}

export type SnippetAgentDraft = {
  label?: unknown;
  command?: unknown;
  kind?: unknown;
  tags?: unknown;
  targets?: unknown;
  targetsAllHosts?: unknown;
  package?: unknown;
  shortkey?: unknown;
  noAutoRun?: unknown;
  language?: unknown;
  description?: unknown;
  trigger?: unknown;
  triggerPattern?: unknown;
};

export type SnippetAgentPatch = SnippetAgentDraft;

const VALID_KINDS = new Set<SnippetKind>(['snippet', 'script']);
const VALID_TRIGGERS = new Set<ScriptTrigger>(['manual', 'onConnect', 'onOutput']);
const VALID_LANGUAGES = new Set<ScriptLanguage>(['javascript', 'python']);

function parseKind(raw: unknown, fallback: SnippetKind = 'snippet'): SnippetKind | { error: string } {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim();
  if (VALID_KINDS.has(value as SnippetKind)) return value as SnippetKind;
  return { error: `kind must be "snippet" or "script", got "${value}".` };
}

function parseTrigger(raw: unknown): ScriptTrigger | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (VALID_TRIGGERS.has(value as ScriptTrigger)) return value as ScriptTrigger;
  return { error: `trigger must be manual, onConnect, or onOutput, got "${value}".` };
}

function parseLanguage(raw: unknown): ScriptLanguage | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (VALID_LANGUAGES.has(value as ScriptLanguage)) return value as ScriptLanguage;
  return { error: `language must be javascript or python, got "${value}".` };
}

function parseOptionalBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
}

function parseStringArray(raw: unknown, fieldName: string): string[] | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') {
    return { error: `${fieldName} must be a string or array.` };
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return { error: `${fieldName} must be a JSON array.` };
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    } catch {
      return { error: `${fieldName} must be valid JSON array.` };
    }
  }
  return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseTags(raw: unknown): string[] | undefined | { error: string } {
  return parseStringArray(raw, 'tags');
}

function parseTargets(raw: unknown): string[] | undefined | { error: string } {
  return parseStringArray(raw, 'targets');
}

function generateSnippetId(): string {
  return `snippet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validateTriggerPattern(trigger: ScriptTrigger | undefined, pattern: string | undefined): string | undefined | { error: string } {
  if (trigger === 'onOutput') {
    if (!pattern?.trim()) {
      return { error: 'triggerPattern is required when trigger is onOutput.' };
    }
    try {
      RegExp(pattern);
    } catch {
      return { error: `triggerPattern is not a valid regex: "${pattern}".` };
    }
  }
  return pattern?.trim() || undefined;
}

export function buildSnippetFromAgentDraft(
  draft: SnippetAgentDraft,
  existingSnippets: Snippet[],
  options: { forceKind?: SnippetKind } = {},
): { ok: true; snippet: Snippet } | { ok: false; error: string } {
  const label = typeof draft.label === 'string' ? draft.label.trim() : '';
  if (!label) return { ok: false, error: 'label is required.' };

  const command = typeof draft.command === 'string' ? draft.command : '';
  if (!command.trim()) return { ok: false, error: 'command is required.' };

  const kindResult = parseKind(draft.kind, options.forceKind ?? 'snippet');
  if (typeof kindResult === 'object' && 'error' in kindResult) {
    return { ok: false, error: kindResult.error };
  }
  const kind = options.forceKind ?? kindResult;

  const triggerResult = parseTrigger(draft.trigger);
  if (triggerResult && typeof triggerResult === 'object' && 'error' in triggerResult) {
    return { ok: false, error: triggerResult.error };
  }
  const trigger = triggerResult ?? (kind === 'script' ? 'manual' : undefined);

  const languageResult = parseLanguage(draft.language);
  if (languageResult && typeof languageResult === 'object' && 'error' in languageResult) {
    return { ok: false, error: languageResult.error };
  }

  const tags = parseTags(draft.tags);
  if (tags && 'error' in tags) return { ok: false, error: tags.error };

  const targetsAllHosts = parseOptionalBoolean(draft.targetsAllHosts);
  let targets: string[] | undefined;
  if (!targetsAllHosts) {
    const targetsResult = parseTargets(draft.targets);
    if (targetsResult && 'error' in targetsResult) return { ok: false, error: targetsResult.error };
    targets = targetsResult && targetsResult.length > 0 ? targetsResult : undefined;
  }

  const triggerPatternRaw = typeof draft.triggerPattern === 'string' ? draft.triggerPattern : undefined;
  const triggerPattern = validateTriggerPattern(trigger, triggerPatternRaw);
  if (triggerPattern && typeof triggerPattern === 'object' && 'error' in triggerPattern) {
    return { ok: false, error: triggerPattern.error };
  }

  const snippet: Snippet = {
    id: generateSnippetId(),
    label,
    command,
    kind,
    tags: tags && tags.length > 0 ? tags : undefined,
    targets: targetsAllHosts ? undefined : targets,
    targetsAllHosts: targetsAllHosts || undefined,
    package: typeof draft.package === 'string' && draft.package.trim() ? draft.package.trim() : undefined,
    shortkey: typeof draft.shortkey === 'string' && draft.shortkey.trim() ? draft.shortkey.trim() : undefined,
    noAutoRun: parseOptionalBoolean(draft.noAutoRun),
    language: languageResult ?? (kind === 'script' ? 'javascript' : undefined),
    description: typeof draft.description === 'string' && draft.description.trim()
      ? draft.description.trim()
      : undefined,
    trigger,
    triggerPattern: typeof triggerPattern === 'string' ? triggerPattern : undefined,
    order: getNextVaultOrder(existingSnippets),
  };

  return { ok: true, snippet };
}

export function applySnippetAgentPatch(
  existing: Snippet,
  patch: SnippetAgentPatch,
  options: { forceKind?: SnippetKind } = {},
): { ok: true; snippet: Snippet; prevTargetIds?: string[] } | { ok: false; error: string } {
  const label = patch.label !== undefined
    ? (typeof patch.label === 'string' ? patch.label.trim() : '')
    : existing.label;
  if (!label) return { ok: false, error: 'label cannot be empty.' };

  const command = patch.command !== undefined
    ? (typeof patch.command === 'string' ? patch.command : '')
    : existing.command;
  if (!command.trim()) return { ok: false, error: 'command cannot be empty.' };

  let kind = existing.kind ?? 'snippet';
  if (options.forceKind) {
    kind = options.forceKind;
  } else if (patch.kind !== undefined) {
    const kindResult = parseKind(patch.kind, kind);
    if (typeof kindResult === 'object' && 'error' in kindResult) {
      return { ok: false, error: kindResult.error };
    }
    kind = kindResult;
  }

  let trigger = existing.trigger;
  if (patch.trigger !== undefined) {
    const triggerResult = parseTrigger(patch.trigger);
    if (triggerResult && typeof triggerResult === 'object' && 'error' in triggerResult) {
      return { ok: false, error: triggerResult.error };
    }
    trigger = triggerResult;
  }

  let language = existing.language;
  if (patch.language !== undefined) {
    const languageResult = parseLanguage(patch.language);
    if (languageResult && typeof languageResult === 'object' && 'error' in languageResult) {
      return { ok: false, error: languageResult.error };
    }
    language = languageResult;
  }

  const tags = patch.tags !== undefined ? parseTags(patch.tags) : existing.tags;
  if (tags && 'error' in tags) return { ok: false, error: tags.error };

  const prevTargetIds = existing.targets ? [...existing.targets] : undefined;

  let targetsAllHosts = existing.targetsAllHosts;
  if (patch.targets !== undefined && patch.targetsAllHosts === undefined) {
    targetsAllHosts = false;
  } else if (patch.targetsAllHosts !== undefined) {
    targetsAllHosts = parseOptionalBoolean(patch.targetsAllHosts) ?? false;
  }

  let targets = existing.targets;
  if (patch.targets !== undefined || patch.targetsAllHosts !== undefined) {
    if (targetsAllHosts) {
      targets = undefined;
    } else {
      const targetsResult = parseTargets(patch.targets ?? existing.targets ?? []);
      if (targetsResult && 'error' in targetsResult) return { ok: false, error: targetsResult.error };
      targets = targetsResult && targetsResult.length > 0 ? targetsResult : undefined;
    }
  }

  const triggerPatternRaw = patch.triggerPattern !== undefined
    ? (typeof patch.triggerPattern === 'string' ? patch.triggerPattern : '')
    : existing.triggerPattern;
  const triggerPattern = validateTriggerPattern(trigger, triggerPatternRaw);
  if (triggerPattern && typeof triggerPattern === 'object' && 'error' in triggerPattern) {
    return { ok: false, error: triggerPattern.error };
  }

  const snippet: Snippet = {
    ...existing,
    label,
    command,
    kind,
    tags: tags && tags.length > 0 ? tags : undefined,
    targets,
    targetsAllHosts: targetsAllHosts || undefined,
    package: patch.package !== undefined
      ? (typeof patch.package === 'string' && patch.package.trim() ? patch.package.trim() : undefined)
      : existing.package,
    shortkey: patch.shortkey !== undefined
      ? (typeof patch.shortkey === 'string' && patch.shortkey.trim() ? patch.shortkey.trim() : undefined)
      : existing.shortkey,
    noAutoRun: patch.noAutoRun !== undefined
      ? parseOptionalBoolean(patch.noAutoRun)
      : existing.noAutoRun,
    language: language ?? (kind === 'script' ? 'javascript' : undefined),
    description: patch.description !== undefined
      ? (typeof patch.description === 'string' && patch.description.trim() ? patch.description.trim() : undefined)
      : existing.description,
    trigger,
    triggerPattern: typeof triggerPattern === 'string' ? triggerPattern : undefined,
  };

  return { ok: true, snippet, prevTargetIds };
}

export function deleteSnippetFromVault(
  snippets: Snippet[],
  hosts: Host[],
  snippetId: string,
): { snippets: Snippet[]; hosts: Host[] } | { error: string } {
  const target = snippets.find((entry) => entry.id === snippetId);
  if (!target) return { error: `Snippet "${snippetId}" was not found.` };

  const nextSnippets = snippets.filter((entry) => entry.id !== snippetId);
  let nextHosts = hosts.map((host) => {
    let updated = host;
    if (host.loginScriptId === snippetId) {
      updated = { ...updated, loginScriptId: undefined };
    }
    if (host.connectScriptIds?.includes(snippetId)) {
      updated = removeHostConnectScript(updated, snippetId, snippets);
    }
    return updated;
  });

  if (isScriptSnippet(target) && target.trigger === 'onConnect') {
    nextHosts = syncHostsForSnippetTargetChange(
      nextHosts,
      { ...target, targets: [] },
      target.targets,
      nextSnippets,
    );
  }

  return { snippets: nextSnippets, hosts: nextHosts };
}

export function applySnippetCreateToVault(
  snippets: Snippet[],
  hosts: Host[],
  snippet: Snippet,
): { snippets: Snippet[]; hosts: Host[] } {
  const nextSnippets = [...snippets, snippet];
  if (!isScriptSnippet(snippet) || snippet.trigger !== 'onConnect') {
    return { snippets: nextSnippets, hosts };
  }
  const nextHosts = syncHostsForSnippetTargetChange(
    hosts,
    snippet,
    [],
    nextSnippets,
  );
  return { snippets: nextSnippets, hosts: nextHosts };
}

export function applySnippetUpdateToVault(
  snippets: Snippet[],
  hosts: Host[],
  snippet: Snippet,
  previous: Snippet,
  prevTargetIds?: string[],
): { snippets: Snippet[]; hosts: Host[] } {
  const nextSnippets = snippets.map((entry) => (entry.id === snippet.id ? snippet : entry));
  const wasOnConnectScript = isScriptSnippet(previous) && previous.trigger === 'onConnect' && Boolean(previous.id);
  const isOnConnectScript = isScriptSnippet(snippet) && snippet.trigger === 'onConnect' && Boolean(snippet.id);

  let nextHosts = hosts;
  if (wasOnConnectScript && !isOnConnectScript && snippet.id) {
    nextHosts = nextHosts.map((host) => removeHostConnectScript(host, snippet.id, nextSnippets));
  } else if (isOnConnectScript) {
    nextHosts = syncHostsForSnippetTargetChange(
      nextHosts,
      snippet,
      prevTargetIds,
      nextSnippets,
    );
  }
  return { snippets: nextSnippets, hosts: nextHosts };
}

export function setHostConnectScriptIds(
  host: Host,
  scriptIds: string[],
  snippets: Snippet[],
): { ok: true; host: Host } | { ok: false; error: string } {
  const pruned: string[] = [];
  const seen = new Set<string>();
  for (const id of scriptIds) {
    const trimmed = String(id || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    const snippet = snippets.find((entry) => entry.id === trimmed && isScriptSnippet(entry));
    if (!snippet || snippet.trigger !== 'onConnect') {
      return { ok: false, error: `Script "${trimmed}" is not an onConnect automation script.` };
    }
    seen.add(trimmed);
    pruned.push(trimmed);
  }
  return { ok: true, host: { ...host, connectScriptIds: pruned } };
}

export function summarizeConnectScriptsForHost(host: Host, snippets: Snippet[]) {
  const resolved = resolveConnectScriptsForHost(host, snippets);
  return {
    hostId: host.id,
    connectScriptIds: getHostConnectScriptIds(host, snippets),
    resolvedScripts: resolved.map(serializeSnippetForAgentList),
  };
}

export function applyScriptTargetsPatch(
  snippet: Snippet,
  params: { targets?: unknown; targetsAllHosts?: unknown },
): { ok: true; snippet: Snippet; prevTargetIds?: string[] } | { ok: false; error: string } {
  return applySnippetAgentPatch(snippet, params, { forceKind: 'script' });
}
