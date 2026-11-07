import type { PluginAgentBackendKind, PluginAgentHostBackend } from '@netcatty/plugin-contract';
import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_EXTERNAL_AGENTS, STORAGE_KEY_AI_PROVIDERS, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP, STORAGE_KEY_AI_AGENT_MODEL_MAP } from '../../config/storageKeys';
import { getExternalAgentSdkBackend } from '../managedAgents';
import type { ExternalAgentConfig, ProviderConfig } from '../types';
import { netcattyBridge } from '../../services/netcattyBridge';

const externalKinds = ['claude', 'codex', 'copilot', 'cursor', 'codebuddy', 'opencode', 'grok', 'mimo'] as const;
type Model = ReturnType<typeof getConfiguredCattyAgentModel>;

// Match the existing Catty Agent's host-owned provider/model override settings.
// The plain model-invocation broker intentionally keeps its own existing choice.
export function getConfiguredCattyAgentModel() {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  const providerMap = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP) ?? {};
  const modelMap = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {};
  const override = providers.find((entry) => entry.id === providerMap.catty);
  const provider = override ?? providers.find((entry) => entry.id === localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER));
  if (!provider?.enabled) return null;
  const model = override ? modelMap.catty?.trim() || provider.defaultModel?.trim()
    : provider.defaultModel?.trim() || localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL)?.trim();
  if (!model) return null;
  const config = { ...provider, defaultModel: model };
  return { config, label: `${config.name} · ${model}`.slice(0, 160), revision: JSON.stringify(config) };
}

export async function prepareConfiguredCattyAgentModel(revision: string) {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  if (getConfiguredCattyAgentModel()?.revision !== revision) throw Error('Selected Agent configuration changed');
  const bridge = netcattyBridge.require();
  if (!bridge.aiSyncProviders || !(await bridge.aiSyncProviders(providers)).ok
    || getConfiguredCattyAgentModel()?.revision !== revision) throw Error('Host Agent provider configuration is unavailable');
}
export interface ConfiguredAgentBackend {
  descriptor: PluginAgentHostBackend;
  runtimeId: string;
  expiresAt: number;
  identity: string;
  provider?: ProviderConfig;
  external?: ExternalAgentConfig;
  selectedModel?: string;
  isCurrent: () => boolean;
  prepare: () => Promise<void>;
}

// Trusted renderer only. Opaque references select existing settings; neither
// saved keys, env, executable paths nor config fingerprints are returned in DTOs.
export class ConfiguredPluginAgentBackends {
  private readonly refs = new Map<string, ConfiguredAgentBackend>();
  constructor(private readonly options: {
    getModel?: () => Model;
    prepareModel?: (revision: string) => Promise<void>;
    getExternal?: () => ExternalAgentConfig[];
    getExternalModel?: (id: string) => string | undefined;
    clock?: () => number;
  } = {}) {}
  private now() { return (this.options.clock ?? Date.now)(); }
  private model() { return (this.options.getModel ?? getConfiguredCattyAgentModel)(); }
  private external() { return (this.options.getExternal ?? (() => localStorageAdapter.read<ExternalAgentConfig[]>(STORAGE_KEY_AI_EXTERNAL_AGENTS) ?? []))(); }
  private externalModel(id: string) { return (this.options.getExternalModel ?? ((key) =>
    localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP)?.[key]))(id)?.trim() || undefined; }

  list(runtimeId: string): PluginAgentHostBackend[] {
    for (const [id, entry] of this.refs) if (entry.expiresAt <= this.now()) this.refs.delete(id);
    const selected = this.model();
    const result: PluginAgentHostBackend[] = [];
    const add = (backend: PluginAgentBackendKind, label: string, status: PluginAgentHostBackend['status'],
      reason: PluginAgentHostBackend['reason'], extras: Omit<ConfiguredAgentBackend, 'descriptor' | 'runtimeId' | 'expiresAt' | 'identity'>,
      identity = 'unconfigured') => {
      const existing = [...this.refs.values()].find((entry) => entry.runtimeId === runtimeId
        && entry.identity === identity && entry.descriptor.backend === backend && entry.descriptor.label === label.slice(0, 160)
        && entry.descriptor.status === status && entry.descriptor.reason === reason);
      if (existing) { result.push(existing.descriptor); return; }
      if (this.refs.size >= 256) throw Error('Agent backend reference budget exceeded');
      const descriptor: PluginAgentHostBackend = { hostHandle: crypto.randomUUID(), backend, label: label.slice(0, 160), status, reason };
      this.refs.set(descriptor.hostHandle, { descriptor, runtimeId, expiresAt: this.now() + 300_000, identity, ...extras });
      result.push(descriptor);
    };
    if (selected) {
      add('catty', `Catty · ${selected.label}`, 'supported', 'ready', { provider: structuredClone(selected.config),
        isCurrent: () => this.model()?.revision === selected.revision,
        prepare: () => (this.options.prepareModel ?? prepareConfiguredCattyAgentModel)(selected.revision) }, selected.revision);
    } else add('catty', 'Catty', 'unavailable', 'not-configured', { isCurrent: () => false, prepare: async () => {} });
    const configured = this.external();
    for (const kind of externalKinds) {
      const entries = configured.filter((item) => getExternalAgentSdkBackend(item) === kind);
      if (!entries.length && result.length < 32) {
        add(kind, kind, 'unavailable', 'not-configured', { isCurrent: () => false, prepare: async () => {} });
      }
      for (const entry of entries) {
        if (result.length >= 32) break;
        const selectedModel = this.externalModel(entry.id);
        const snapshot = JSON.stringify([entry, selectedModel]);
        const available = entry.enabled && entry.available !== false;
        add(kind, entry.name, !available ? 'unavailable' : kind === 'claude' ? 'supported' : 'unsupported',
          !available ? 'configuration-unavailable' : kind === 'claude' ? 'ready' : 'native-boundary-unverified', {
            external: structuredClone(entry), selectedModel,
            isCurrent: () => JSON.stringify([this.external().find((item) => item.id === entry.id), this.externalModel(entry.id)]) === snapshot,
            prepare: async () => {},
          }, snapshot);
      }
    }
    return result;
  }

  resolve(hostHandle: string, runtimeId: string): ConfiguredAgentBackend {
    const entry = this.refs.get(hostHandle);
    if (!entry || entry.runtimeId !== runtimeId || entry.expiresAt <= this.now()
      || entry.descriptor.status !== 'supported' || !entry.isCurrent()) throw Error('Configured Agent reference expired or changed');
    return entry;
  }
  releaseRuntime(runtimeId: string) { for (const [id, entry] of this.refs) if (entry.runtimeId === runtimeId) this.refs.delete(id); }
  shutdown() { this.refs.clear(); }
}
