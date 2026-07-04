import {
  PROVIDER_PRESETS,
  resolveProviderStyle,
  type ProviderConfig,
  type ProviderStyle,
} from '../../infrastructure/ai/types';
import { resolveModelsDiscoveryEndpoint } from '../../infrastructure/ai/modelDiscoveryHeaders';

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
  for (const modelId of Object.keys(provider.modelContextWindows ?? {})) addModel(modelId);
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
