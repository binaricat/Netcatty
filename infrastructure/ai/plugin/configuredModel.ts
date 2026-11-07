import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_ACTIVE_MODEL, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_PROVIDERS } from '../../config/storageKeys';
import type { ProviderConfig } from '../types';
import { netcattyBridge } from '../../services/netcattyBridge';

// Host renderer only. Read the existing configured provider/model without
// loading AgentRuntime or syncing/inheriting the Agent's permission policy.
export function getConfiguredPluginModel() {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  return selectedModel(providers);
}

function selectedModel(providers: ProviderConfig[]) {
  const activeProviderId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER);
  const activeModelId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL);
  const provider = providers.find((item) => item.id === activeProviderId && item.enabled);
  if (!provider) return null;
  const config = { ...provider, defaultModel: activeModelId || provider.defaultModel };
  if (!config.defaultModel) return null;
  return { config, label: `${config.name} · ${config.defaultModel}`.slice(0, 160), revision: JSON.stringify(config) };
}

// The existing main provider transport needs its host-owned registry for both
// credentials and endpoint admission. Do not depend on mounting the AI sidebar,
// or replace the registry with a plugin-supplied URL / just one selected entry.
export async function prepareConfiguredPluginModel(revision: string) {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  if (selectedModel(providers)?.revision !== revision) throw Error('Selected model changed');
  const bridge = netcattyBridge.require();
  if (!bridge.aiSyncProviders || !(await bridge.aiSyncProviders(providers)).ok) {
    throw Error('Host provider configuration is unavailable');
  }
}
