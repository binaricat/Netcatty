import { decryptField } from '../persistence/secureFieldAdapter';
import { buildModelDiscoveryHeaders, resolveModelsDiscoveryEndpoint } from './modelDiscoveryHeaders';
import { normalizeOllamaSdkBaseURL } from './ollamaCompatBaseUrl';
import { buildProviderProbeUrl } from './providerConnectionProbe';
import { sanitizeContextWindow } from './contextCompaction';
import { PROVIDER_PRESETS, resolveProviderStyle, type ProviderConfig } from './types';
import {
  buildProviderSeedModels,
  mergeComposerModels,
  type ComposerPickerModel,
} from './composerPicker';

export interface ProviderModelCatalog {
  models: ComposerPickerModel[];
  fetched: boolean;
  error?: string;
}

type FetchBridge = {
  aiFetch?: (
    url: string,
    method?: string,
    headers?: Record<string, string>,
    body?: string,
    providerId?: string,
    skipHostCheck?: boolean,
    followRedirects?: boolean,
    skipTLSVerify?: boolean,
  ) => Promise<{ ok: boolean; status?: number; data: string; error?: string }>;
  aiAllowlistAddHost?: (baseURL: string) => Promise<{ ok: boolean }>;
};

const catalogCache = new Map<string, { models: ComposerPickerModel[]; expiresAt: number }>();
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** Length + FNV-1a of the stored secret so a key rotation busts the catalog cache. */
function credentialFingerprint(value: string | undefined): string {
  const raw = String(value || '');
  if (!raw) return '0';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}:${(hash >>> 0).toString(16)}`;
}

export function readCachedProviderModelCatalog(
  provider: ProviderConfig,
): ComposerPickerModel[] | null {
  const cached = catalogCache.get(providerModelCacheKey(provider));
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.models;
}

export function providerModelCacheKey(provider: ProviderConfig): string {
  return [
    provider.id,
    provider.providerId,
    provider.style ?? '',
    provider.baseURL ?? '',
    provider.skipTLSVerify ? '1' : '0',
    credentialFingerprint(provider.apiKey),
  ].join('|');
}

export function resolveProviderDiscoveryBaseURL(provider: ProviderConfig): string {
  const raw = provider.baseURL || PROVIDER_PRESETS[provider.providerId]?.defaultBaseURL || '';
  if (!raw) return '';
  return provider.providerId === 'ollama' ? normalizeOllamaSdkBaseURL(raw) : raw;
}

export function seedProviderModelCatalog(provider: ProviderConfig): ProviderModelCatalog {
  return {
    models: buildProviderSeedModels(provider),
    fetched: false,
  };
}

export function clearProviderModelCatalogCache(): void {
  catalogCache.clear();
}

function parseDiscoveredModels(parsed: unknown): ComposerPickerModel[] {
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return rawModels
    .map((raw): ComposerPickerModel | null => {
      if (!raw || typeof raw !== 'object') return null;
      const model = raw as Record<string, unknown>;
      if (typeof model.id !== 'string' || !model.id) return null;
      const contextWindow = sanitizeContextWindow(
        model.context_length
          ?? model.context_window
          ?? model.contextWindow
          ?? model.context
          ?? model.max_context_tokens,
      );
      return {
        id: model.id,
        name: typeof model.name === 'string' && model.name ? model.name : model.id,
        ...(contextWindow != null ? { contextWindow } : {}),
      };
    })
    .filter((model): model is ComposerPickerModel => model != null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchProviderModelCatalog(
  provider: ProviderConfig,
  bridge: FetchBridge | undefined,
): Promise<ProviderModelCatalog> {
  const seed = seedProviderModelCatalog(provider);
  const cacheKey = providerModelCacheKey(provider);
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      models: mergeComposerModels(seed.models, cached.models),
      fetched: true,
    };
  }

  const style = resolveProviderStyle(provider);
  const endpoint = resolveModelsDiscoveryEndpoint(style, undefined);
  const baseURL = resolveProviderDiscoveryBaseURL(provider);
  if (!endpoint || !baseURL || !bridge?.aiFetch) {
    return seed;
  }

  try {
    const apiKey = await decryptField(provider.apiKey);
    if (provider.providerId !== 'ollama' && !apiKey) {
      return seed;
    }
    if (bridge.aiAllowlistAddHost) {
      await bridge.aiAllowlistAddHost(baseURL);
    }
    const url = buildProviderProbeUrl(baseURL, endpoint);
    const headers = buildModelDiscoveryHeaders(style, apiKey);
    const result = await bridge.aiFetch(
      url,
      'GET',
      headers,
      undefined,
      undefined,
      undefined,
      undefined,
      provider.skipTLSVerify,
    );
    if (!result.ok) {
      return { ...seed, error: result.error || 'Failed to fetch models' };
    }
    const fetched = parseDiscoveredModels(JSON.parse(result.data) as unknown);
    catalogCache.set(cacheKey, { models: fetched, expiresAt: Date.now() + CATALOG_TTL_MS });
    return {
      models: mergeComposerModels(seed.models, fetched),
      fetched: true,
    };
  } catch (error) {
    return {
      ...seed,
      error: error instanceof Error ? error.message : 'Failed to fetch models',
    };
  }
}
