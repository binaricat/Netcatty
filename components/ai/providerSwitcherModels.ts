import {
  PROVIDER_PRESETS,
  resolveProviderStyle,
  type ProviderConfig,
  type ProviderStyle,
} from '../../infrastructure/ai/types';
import { resolveModelsDiscoveryEndpoint } from '../../infrastructure/ai/modelDiscoveryHeaders';
import { sanitizeContextWindow } from '../../infrastructure/ai/contextCompaction';

export interface ProviderModelOption {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface ProviderModelDiscoveryConfig {
  baseURL: string;
  endpoint?: string;
  style: ProviderStyle;
  canFetch: boolean;
}

export type ProviderModelCatalogStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface ProviderModelCatalogState {
  status: ProviderModelCatalogStatus;
  models: ProviderModelOption[];
  error?: string;
  requestKey?: string;
}

export function buildProviderModelOptions(
  provider: Pick<ProviderConfig, 'providerId' | 'defaultModel' | 'modelContextWindows'>,
  fetchedModels: ProviderModelOption[] = [],
): ProviderModelOption[] {
  const byId = new Map<string, ProviderModelOption>();

  const addModel = (model: ProviderModelOption | string | undefined) => {
    const rawId = typeof model === 'string' ? model : model?.id;
    const id = rawId?.trim();
    if (!id) return;
    const nextModel = typeof model === 'string' ? { id } : { ...model, id };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, nextModel);
      return;
    }
    if ((!existing.name && nextModel.name) || (!existing.contextWindow && nextModel.contextWindow)) {
      byId.set(id, { ...existing, ...nextModel });
    }
  };

  addModel(provider.defaultModel);
  for (const model of fetchedModels) addModel(model);
  for (const [modelId, contextWindow] of Object.entries(provider.modelContextWindows ?? {})) {
    addModel({ id: modelId, contextWindow });
  }
  for (const modelId of PROVIDER_PRESETS[provider.providerId]?.defaultModels ?? []) addModel(modelId);

  return Array.from(byId.values());
}

export function getProviderModelDiscoveryConfig(
  provider: Pick<ProviderConfig, 'providerId' | 'style' | 'baseURL' | 'apiKey'>,
): ProviderModelDiscoveryConfig {
  const style = resolveProviderStyle(provider);
  const preset = PROVIDER_PRESETS[provider.providerId];
  const endpoint = resolveModelsDiscoveryEndpoint(style, preset?.modelsEndpoint);
  const baseURL = (provider.baseURL || preset?.defaultBaseURL || '').trim().replace(/\/+$/, '');
  const needsApiKey = provider.providerId !== 'ollama';

  return {
    baseURL,
    endpoint,
    style,
    canFetch: Boolean(baseURL && endpoint && (!needsApiKey || provider.apiKey)),
  };
}

export function buildProviderModelCatalogRequestKey(
  provider: Pick<ProviderConfig, 'id' | 'apiKey' | 'skipTLSVerify'>,
  discovery: Pick<ProviderModelDiscoveryConfig, 'baseURL' | 'endpoint' | 'style'>,
): string {
  return JSON.stringify({
    providerId: provider.id,
    baseURL: discovery.baseURL,
    endpoint: discovery.endpoint,
    apiKeyFingerprint: provider.apiKey ?? '',
    style: discovery.style,
    skipTLSVerify: provider.skipTLSVerify,
  });
}

export function shouldLoadProviderModelCatalog(
  current: Pick<ProviderModelCatalogState, 'requestKey' | 'status'> | undefined,
  requestKey: string,
  force = false,
): boolean {
  if (force) return true;
  if (current?.requestKey !== requestKey) return true;
  return current.status === 'idle';
}

export function mergeProviderModelContextWindow(
  current: Record<string, number> | undefined,
  model: ProviderModelOption,
): Record<string, number> | undefined {
  const sanitized = sanitizeContextWindow(model.contextWindow);
  if (!model.id || sanitized == null) return current;
  return { ...(current ?? {}), [model.id]: sanitized };
}
