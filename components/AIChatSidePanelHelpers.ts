import {
  getAgentModelPresets,
  resolveAgentModelSelection,
  type AgentModelPreset,
  type ExternalAgentConfig,
} from '../infrastructure/ai/types';
import { getExternalAgentSdkBackend } from '../infrastructure/ai/managedAgents';
import {
  canonicalizeEffortEncodedModelId,
  modelPresetMatchesId,
  modelPresetsContainId,
} from '../infrastructure/ai/composerPicker';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export {
  canonicalizeEffortEncodedModelId,
  modelPresetMatchesId,
  modelPresetsContainId,
};

export type SdkRuntimeModelCatalogSource = 'live' | 'last-known-good' | 'presets';

export type SdkRuntimeModelCatalog = {
  currentModelId: string | null;
  models: AgentModelPreset[];
  // Degraded loads (e.g. last-known-good serve) carry their warning so a
  // cached hit in another panel or after a remount still shows the retry
  // banner instead of presenting stale models as live.
  warning?: string | null;
  // Provenance of the models list: 'live' when the SDK fetch succeeded,
  // 'last-known-good' when main served the persisted previous success.
  // Absent (older main) behaves like a live fetch for display purposes.
  source?: Exclude<SdkRuntimeModelCatalogSource, 'presets'>;
  // ISO timestamp of the successful fetch backing this catalog (live fetch
  // time, or the persisted last-known-good fetchedAt).
  fetchedAt?: string;
};

export type SdkRuntimeModelCacheEntry = SdkRuntimeModelCatalog & {
  updatedAt: number;
};

type SdkRuntimeModelCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

type SdkRuntimeModelRefreshOptions = {
  force?: boolean;
};

const SDK_RUNTIME_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const SDK_RUNTIME_MODEL_CACHE_MAX_ENTRIES = 64;
// Keep in sync with main-process SDK_MODEL_CACHE_ENV_KEYS: profile-affecting
// env must bust the renderer cache so we re-query after OpenCode config switches.
export const MODEL_CACHE_ENV_HINTS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENCODE_BIN',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'MIMOCODE_HOME',
  'MIMOCODE_BIN',
  'MIMOCODE_BIN_PATH',
  'MIMOCODE_CONFIG',
  'MIMOCODE_CONFIG_DIR',
  'MIMOCODE_MIMO_ONLY',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CODE_EXECUTABLE',
  'CODEBUDDY_CODE_PATH',
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_AUTH_TOKEN',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
  'XAI_API_KEY',
  'GROK_CONFIG_DIR',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_CONFIG_DIR',
  'CURSOR_API_KEY',
  'NETCATTY_CURSOR_AUTH_MODE',
  'NETCATTY_CURSOR_CLI_BIN',
] as const;

const SDK_RUNTIME_MODEL_CATALOG_SOURCES = new Set(['live', 'last-known-good']);

function normalizeCatalogSource(
  source: unknown,
): SdkRuntimeModelCatalog['source'] {
  return typeof source === 'string' && SDK_RUNTIME_MODEL_CATALOG_SOURCES.has(source)
    ? source as SdkRuntimeModelCatalog['source']
    : undefined;
}

function normalizeCatalogFetchedAt(fetchedAt: unknown): string | undefined {
  return typeof fetchedAt === 'string' && fetchedAt ? fetchedAt : undefined;
}

function cloneCatalog(catalog: SdkRuntimeModelCatalog): SdkRuntimeModelCatalog {
  return {
    currentModelId: catalog.currentModelId ?? null,
    models: [...catalog.models],
    ...(catalog.warning ? { warning: catalog.warning } : {}),
    ...(catalog.source ? { source: catalog.source } : {}),
    ...(catalog.fetchedAt ? { fetchedAt: catalog.fetchedAt } : {}),
  };
}

function normalizeSdkRuntimeModelCatalog(catalog: SdkRuntimeModelCatalog): SdkRuntimeModelCatalog {
  return {
    currentModelId: catalog.currentModelId ?? null,
    models: Array.isArray(catalog.models)
      ? catalog.models.filter((model): model is AgentModelPreset => Boolean(model?.id))
      : [],
    ...(catalog.warning ? { warning: catalog.warning } : {}),
    ...(normalizeCatalogSource(catalog.source) ? { source: normalizeCatalogSource(catalog.source) } : {}),
    ...(normalizeCatalogFetchedAt(catalog.fetchedAt) ? { fetchedAt: normalizeCatalogFetchedAt(catalog.fetchedAt) } : {}),
  };
}

/** The list-models IPC result as the renderer receives it. */
export type SdkListModelsResult = {
  ok: boolean;
  models?: AgentModelPreset[];
  currentModelId?: string | null;
  warning?: string;
  error?: string;
  // Provenance reported by main (absent on an older main).
  source?: Exclude<SdkRuntimeModelCatalogSource, 'presets'>;
  fetchedAt?: string;
};

/**
 * Adapt a successful list-models result to a catalog while keeping the
 * provenance main reported. Dropping source/fetchedAt would make the picker
 * label a persisted last-known-good list as a live catalog.
 */
export function toSdkRuntimeModelCatalog(result: SdkListModelsResult): SdkRuntimeModelCatalog {
  return {
    currentModelId: result.currentModelId ?? null,
    models: result.models ?? [],
    warning: result.warning ?? null,
    ...(normalizeCatalogSource(result.source) ? { source: normalizeCatalogSource(result.source) } : {}),
    ...(normalizeCatalogFetchedAt(result.fetchedAt) ? { fetchedAt: normalizeCatalogFetchedAt(result.fetchedAt) } : {}),
  };
}

/**
 * Inject Cursor auth-mode env for list-models IPC.
 * Mirrors run-turn `buildAgentEnvWithStoredApiKey` (without decrypting API keys):
 * persisted `agent.env` strips NETCATTY_CURSOR_* via sanitization, so list-models
 * must re-inject from `cursorAuthMode` / `command` or main defaults to api-key.
 */
export function buildCursorListModelsAgentEnv(agent: {
  env?: Record<string, string>;
  cursorAuthMode?: 'cli-login' | 'api-key';
  command?: string;
}): Record<string, string> | undefined {
  const env = { ...(agent.env ?? {}) };
  const authMode = agent.cursorAuthMode === 'cli-login' ? 'cli-login' : 'api-key';
  env.NETCATTY_CURSOR_AUTH_MODE = authMode;
  const cliBin = String(agent.command || '').trim();
  if (authMode === 'cli-login' && cliBin && cliBin !== 'cursor') {
    env.NETCATTY_CURSOR_CLI_BIN = cliBin;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function buildSdkRuntimeModelCacheKey(agent: {
  id: string;
  command?: string;
  sdkBackend?: string;
  acpCommand?: string;
  env?: Record<string, string>;
  codexRuntime?: 'sdk' | 'app-server';
  grokRuntime?: 'acp' | 'streaming-json';
  cursorAuthMode?: 'cli-login' | 'api-key';
}): string {
  const sdkBackend = agent.sdkBackend || agent.acpCommand || '';
  const envHints = MODEL_CACHE_ENV_HINTS.map((key) => `${key}=${agent.env?.[key] ?? ''}`);
  // cursorAuthMode is the source of truth when NETCATTY_CURSOR_AUTH_MODE was
  // stripped from persisted env; include it so toggling auth mode busts cache.
  const cursorAuth = sdkBackend === 'cursor'
    ? (agent.cursorAuthMode === 'cli-login' ? 'cli-login' : 'api-key')
    : '';
  const grokRuntime = sdkBackend === 'grok'
    ? (agent.grokRuntime === 'streaming-json' ? 'streaming-json' : 'acp')
    : '';
  // Keep authentication values out of the in-memory cache key itself.
  const envHash = bytesToHex(sha256(new TextEncoder().encode(envHints.join('\u0000'))));
  return [agent.id, sdkBackend, agent.command ?? '', agent.codexRuntime ?? 'sdk', grokRuntime, cursorAuth, envHash].join('\u0000');
}

export function createSdkRuntimeModelCache(options: SdkRuntimeModelCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? SDK_RUNTIME_MODEL_CACHE_TTL_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? SDK_RUNTIME_MODEL_CACHE_MAX_ENTRIES);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, SdkRuntimeModelCacheEntry>();
  const inFlight = new Map<string, Promise<SdkRuntimeModelCatalog>>();

  const pruneEntries = () => {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (currentTime - entry.updatedAt >= ttlMs) {
        entries.delete(key);
      }
    }
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };

  const touchEntry = (key: string, entry: SdkRuntimeModelCacheEntry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    read(key: string): SdkRuntimeModelCacheEntry | null {
      pruneEntries();
      const entry = entries.get(key);
      if (entry) touchEntry(key, entry);
      return entry ? { ...cloneCatalog(entry), updatedAt: entry.updatedAt } : null;
    },
    size(): number {
      pruneEntries();
      return entries.size;
    },
    refresh(
      key: string,
      load: () => Promise<SdkRuntimeModelCatalog>,
      refreshOptions: SdkRuntimeModelRefreshOptions = {},
    ): Promise<SdkRuntimeModelCatalog> {
      pruneEntries();
      const cached = entries.get(key);
      if (!refreshOptions.force && cached && now() - cached.updatedAt < ttlMs) {
        touchEntry(key, cached);
        return Promise.resolve(cloneCatalog(cached));
      }

      const existing = inFlight.get(key);
      if (existing) return existing;

      const promise = Promise.resolve(load())
        .then((catalog) => {
          const normalized = normalizeSdkRuntimeModelCatalog(catalog);
          if (normalized.models.length === 0 && !normalized.currentModelId) {
            // A degraded retry keeps the older catalog usable but must still
            // report its own warning, or the banner and Retry would vanish.
            if (!cached) return cloneCatalog(normalized);
            const retained = cloneCatalog(cached);
            if (normalized.warning) {
              retained.warning = normalized.warning;
              retained.source = 'last-known-good';
              touchEntry(key, { ...retained, updatedAt: cached.updatedAt });
            }
            return retained;
          }
          touchEntry(key, { ...cloneCatalog(normalized), updatedAt: now() });
          pruneEntries();
          return cloneCatalog(normalized);
        })
        .finally(() => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
          }
        });

      inFlight.set(key, promise);
      return promise;
    },
  };
}

export const sdkRuntimeModelCache = createSdkRuntimeModelCache();

export type RuntimeModelWarnings = Record<string, { cacheKey: string; message: string }>;

/**
 * Make the per-agent catalog warning banner match a catalog result. Used both
 * for cache reads and after a refresh settles: a refresh that coalesced onto
 * another panel's in-flight load never runs its own loader callback, so
 * the caller must reconcile the banner from the shared result itself.
 * Returns the same object when nothing changes (no extra render). A banner
 * that belongs to a different cache key is never cleared.
 */
export function reconcileRuntimeModelWarning(
  current: RuntimeModelWarnings,
  agentId: string,
  cacheKey: string,
  hasWarning: boolean,
  message: string,
): RuntimeModelWarnings {
  const existing = current[agentId];
  if (hasWarning) {
    return existing?.cacheKey === cacheKey ? current : { ...current, [agentId]: { cacheKey, message } };
  }
  if (existing?.cacheKey !== cacheKey) return current;
  const { [agentId]: _removed, ...rest } = current;
  return rest;
}

export function mergeFallbackThinkingLevels(
  runtime: AgentModelPreset[],
  fallbacks: AgentModelPreset[],
): AgentModelPreset[] {
  if (runtime.length === 0 || fallbacks.length === 0) return runtime;
  const byId = new Map(fallbacks.map((preset) => [preset.id, preset]));
  let changed = false;
  const next = runtime.map((preset) => {
    if (preset.thinkingLevels !== undefined) return preset;
    const fallback = byId.get(preset.id);
    if (!fallback?.thinkingLevels?.length) return preset;
    changed = true;
    return {
      ...preset,
      thinkingLevels: [...fallback.thinkingLevels],
      ...(fallback.defaultThinkingLevel
        ? { defaultThinkingLevel: fallback.defaultThinkingLevel }
        : {}),
      ...(fallback.encodeDefaultThinking === false
        ? { encodeDefaultThinking: false }
        : {}),
    };
  });
  return changed ? next : runtime;
}

export function agentModelPresetsShallowEqual(
  left: AgentModelPreset[] | undefined,
  right: AgentModelPreset[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((preset, index) => {
    const other = right[index];
    return (
      preset.id === other.id
      && preset.name === other.name
      && preset.defaultThinkingLevel === other.defaultThinkingLevel
      && (preset.thinkingLevels ?? []).join('\0') === (other.thinkingLevels ?? []).join('\0')
    );
  });
}

export function normalizeStoredAgentModelSelection(
  storedModelId: string | null | undefined,
  presets: AgentModelPreset[],
): string | undefined {
  if (!storedModelId) return undefined;
  const canonical = canonicalizeEffortEncodedModelId(storedModelId);
  const preset = presets.find((candidate) => modelPresetMatchesId(candidate, canonical));
  if (!preset) return undefined;
  return canonical === preset.id
    ? resolveAgentModelSelection(preset)
    : canonical;
}

export function shouldLoadSdkRuntimeModels(agent?: ExternalAgentConfig): boolean {
  const sdkBackend = getExternalAgentSdkBackend(agent);
  // Codex on the default `sdk` runtime also serves a live catalog: its driver
  // falls back to the App Server runtime's model/list in main (#3496), so
  // quick sends must await it instead of running with build-time presets.
  return sdkBackend === 'codex'
    || sdkBackend === 'claude'
    || sdkBackend === 'copilot'
    || sdkBackend === 'cursor'
    || sdkBackend === 'codebuddy'
    || sdkBackend === 'opencode'
    || sdkBackend === 'grok'
    || sdkBackend === 'mimo';
}

// Alias ids the claude CLI itself still resolves: its alias table maps
// opus/sonnet/haiku -> claude-*-5-5 and fable -> claude-fable-5-1. Preset
// lists before the 2026-10 catalog refresh persisted `sonnet`/`haiku` as
// preset ids, so a stored alias must keep resolving instead of being
// silently replaced by the live catalog's full id.
const CLAUDE_CLI_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

function isStillValidClaudeAlias(
  storedModelId: string | null | undefined,
  agent?: ExternalAgentConfig,
): boolean {
  if (!storedModelId) return false;
  if (getExternalAgentSdkBackend(agent) !== 'claude') return false;
  const baseId = canonicalizeEffortEncodedModelId(storedModelId).split('/')[0];
  return CLAUDE_CLI_MODEL_ALIASES.has(baseId);
}

// Retain unlisted Copilot choices while discovery is pending or failed.
// A successful auto-only catalog is authoritative, regardless of row names.
function shouldRetainUnlistedCopilotModel(
  agent: ExternalAgentConfig | undefined,
  retainUnlistedModel: boolean,
): boolean {
  return retainUnlistedModel && getExternalAgentSdkBackend(agent) === 'copilot';
}

/**
 * True when a stored selection still resolves even though it is absent from
 * the given presets: either the presets list it under an effort-suffixed
 * spelling, or it is a claude CLI alias the backend accepts verbatim.
 */
export function storedModelStillResolvesForAgent(
  storedModelId: string | null | undefined,
  presets: AgentModelPreset[],
  agent?: ExternalAgentConfig,
): boolean {
  if (!storedModelId) return false;
  return modelPresetsContainId(presets, storedModelId)
    || isStillValidClaudeAlias(storedModelId, agent);
}

export function resolveSdkRuntimeCatalogDefaultModelId(
  catalog: SdkRuntimeModelCatalog,
  agent?: ExternalAgentConfig,
): string | null {
  if (catalog.currentModelId) return catalog.currentModelId;
  // Copilot lists models without a current id. Commit the same visible
  // default on live success, so a later failed refresh cannot revive an
  // unlisted saved choice that the live catalog has already replaced.
  if (!catalog.warning && getExternalAgentSdkBackend(agent) === 'copilot' && catalog.models[0]) {
    return resolveAgentModelSelection(catalog.models[0]);
  }
  return null;
}

export function shouldAdoptSdkCurrentModel(
  currentModelId: string | null | undefined,
  storedModelId: string | null | undefined,
  runtimePresets: AgentModelPreset[],
  agent?: ExternalAgentConfig,
): boolean {
  if (!currentModelId) return false;
  // A stored claude alias the CLI still resolves is a user choice: never
  // overwrite it with the catalog's current model.
  if (isStillValidClaudeAlias(storedModelId, agent)) return false;
  return !storedModelId
    || runtimePresets.length === 0
    || !modelPresetsContainId(runtimePresets, storedModelId);
}

export function normalizeSdkRuntimeModelPresets(
  models: AgentModelPreset[],
  currentModelId: string | null | undefined,
): AgentModelPreset[] {
  if (models.length > 0) return models;
  if (!currentModelId) return [];
  return [{ id: currentModelId, name: currentModelId }];
}

export function shouldUseStoredAgentModel(
  storedModelId: string | null | undefined,
  presets: AgentModelPreset[],
  agent?: ExternalAgentConfig,
  retainUnlistedModel = false,
): boolean {
  if (!storedModelId) return false;
  return storedModelStillResolvesForAgent(storedModelId, presets, agent)
    || (presets.length === 0 && shouldLoadSdkRuntimeModels(agent))
    || shouldRetainUnlistedCopilotModel(agent, retainUnlistedModel);
}

/**
 * A stored selection preserved through the claude-alias or copilot
 * degraded fallback has no preset row of its own; append one (reusing the
 * build-time preset when it defines the id) so the picker can render and
 * check the selection while the send preflight passes the same value.
 */
export function appendRetainedStoredModelPreset(
  presets: AgentModelPreset[],
  storedModelId: string | null | undefined,
  agent?: ExternalAgentConfig,
  retainUnlistedModel = false,
): AgentModelPreset[] {
  if (!storedModelId || modelPresetsContainId(presets, storedModelId)) return presets;
  if (!isStillValidClaudeAlias(storedModelId, agent)
    && !shouldRetainUnlistedCopilotModel(agent, retainUnlistedModel)) {
    return presets;
  }
  const canonical = canonicalizeEffortEncodedModelId(storedModelId);
  const baseId = canonical.split('/')[0];
  if (presets.some((preset) => preset.id === baseId)) {
    // The base row did not cover the stored id (checked above), so a suffixed
    // selection needs its own exact row; a bare id is already present.
    return canonical === baseId ? presets : [...presets, { id: canonical, name: canonical }];
  }
  const fallback = getAgentModelPresets(agent?.command, getExternalAgentSdkBackend(agent))
    .find((preset) => preset.id === baseId);
  // Keep the exact stored id (including any effort suffix) so the appended
  // row still matches the selection the send preflight passes.
  return [...presets, fallback ?? { id: canonical, name: canonical }];
}

/**
 * Retain the saved selection on top of the presets built for a catalog, but
 * only when a catalog actually arrived. When none did (the request failed
 * before any last-known-good entry existed) the result is empty so the agent
 * keeps its whole built-in fallback list: a lone retained row, or only the
 * user's custom composer models, would be stored as the authoritative runtime
 * list and hide every built-in preset. The panel appends custom models on top
 * of the fallback list itself.
 */
export function retainStoredModelPresetForCatalog(
  catalogPresets: AgentModelPreset[],
  presets: AgentModelPreset[],
  storedModelId: string | null | undefined,
  agent?: ExternalAgentConfig,
  retainUnlistedModel = false,
): AgentModelPreset[] {
  if (catalogPresets.length === 0) return [];
  return appendRetainedStoredModelPreset(presets, storedModelId, agent, retainUnlistedModel);
}

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
