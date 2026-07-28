import type { AgentModelPreset, ExternalAgentConfig } from '../infrastructure/ai/types';
import { getExternalAgentSdkBackend } from '../infrastructure/ai/managedAgents';

export type SdkRuntimeModelCatalog = {
  currentModelId: string | null;
  models: AgentModelPreset[];
};

export type SdkRuntimeModelCacheEntry = SdkRuntimeModelCatalog & {
  updatedAt: number;
};

type SdkRuntimeModelCacheOptions = {
  ttlMs?: number;
  now?: () => number;
};

type SdkRuntimeModelRefreshOptions = {
  force?: boolean;
};

const SDK_RUNTIME_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
// Keep in sync with main-process SDK_MODEL_CACHE_ENV_KEYS: profile-affecting
// env must bust the renderer cache so we re-query after OpenCode config switches.
const MODEL_CACHE_ENV_HINTS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'OPENCODE_BIN',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'CLAUDE_CODE_EXECUTABLE',
  'CODEBUDDY_CODE_PATH',
  'CURSOR_API_KEY',
  'NETCATTY_CURSOR_AUTH_MODE',
  'NETCATTY_CURSOR_CLI_BIN',
] as const;

function cloneCatalog(catalog: SdkRuntimeModelCatalog): SdkRuntimeModelCatalog {
  return {
    currentModelId: catalog.currentModelId ?? null,
    models: [...catalog.models],
  };
}

function normalizeSdkRuntimeModelCatalog(catalog: SdkRuntimeModelCatalog): SdkRuntimeModelCatalog {
  return {
    currentModelId: catalog.currentModelId ?? null,
    models: Array.isArray(catalog.models)
      ? catalog.models.filter((model): model is AgentModelPreset => Boolean(model?.id))
      : [],
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
  cursorAuthMode?: 'cli-login' | 'api-key';
}): string {
  const sdkBackend = agent.sdkBackend || agent.acpCommand || '';
  const envHints = MODEL_CACHE_ENV_HINTS.map((key) => `${key}=${agent.env?.[key] ?? ''}`);
  // cursorAuthMode is the source of truth when NETCATTY_CURSOR_AUTH_MODE was
  // stripped from persisted env; include it so toggling auth mode busts cache.
  const cursorAuth = sdkBackend === 'cursor'
    ? (agent.cursorAuthMode === 'cli-login' ? 'cli-login' : 'api-key')
    : '';
  return [agent.id, sdkBackend, agent.command ?? '', agent.codexRuntime ?? 'sdk', cursorAuth, ...envHints].join('\u0000');
}

export function createSdkRuntimeModelCache(options: SdkRuntimeModelCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? SDK_RUNTIME_MODEL_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, SdkRuntimeModelCacheEntry>();
  const inFlight = new Map<string, Promise<SdkRuntimeModelCatalog>>();

  return {
    read(key: string): SdkRuntimeModelCacheEntry | null {
      const entry = entries.get(key);
      return entry ? { ...cloneCatalog(entry), updatedAt: entry.updatedAt } : null;
    },
    refresh(
      key: string,
      load: () => Promise<SdkRuntimeModelCatalog>,
      refreshOptions: SdkRuntimeModelRefreshOptions = {},
    ): Promise<SdkRuntimeModelCatalog> {
      const cached = entries.get(key);
      if (!refreshOptions.force && cached && now() - cached.updatedAt < ttlMs) {
        return Promise.resolve(cloneCatalog(cached));
      }

      const existing = inFlight.get(key);
      if (existing) return existing;

      const promise = Promise.resolve(load())
        .then((catalog) => {
          const normalized = normalizeSdkRuntimeModelCatalog(catalog);
          if (normalized.models.length === 0 && !normalized.currentModelId) {
            return cached ? cloneCatalog(cached) : cloneCatalog(normalized);
          }
          entries.set(key, { ...cloneCatalog(normalized), updatedAt: now() });
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

export function modelPresetMatchesId(preset: AgentModelPreset, modelId: string): boolean {
  if (preset.thinkingLevels?.length) {
    return preset.thinkingLevels.some((level) => `${preset.id}/${level}` === modelId);
  }
  return preset.id === modelId;
}

export function modelPresetsContainId(presets: AgentModelPreset[], modelId: string): boolean {
  return presets.some((preset) => modelPresetMatchesId(preset, modelId));
}

export function shouldLoadSdkRuntimeModels(agent?: ExternalAgentConfig): boolean {
  const sdkBackend = getExternalAgentSdkBackend(agent);
  return (sdkBackend === 'codex' && agent?.codexRuntime === 'app-server')
    || sdkBackend === 'claude'
    || sdkBackend === 'copilot'
    || sdkBackend === 'cursor'
    || sdkBackend === 'codebuddy'
    || sdkBackend === 'opencode';
}

export function shouldAdoptSdkCurrentModel(
  currentModelId: string | null | undefined,
  storedModelId: string | null | undefined,
  runtimePresets: AgentModelPreset[],
): boolean {
  if (!currentModelId) return false;
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
): boolean {
  if (!storedModelId) return false;
  return modelPresetsContainId(presets, storedModelId)
    || (presets.length === 0 && shouldLoadSdkRuntimeModels(agent));
}

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
