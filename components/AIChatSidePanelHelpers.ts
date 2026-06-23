import type { AgentModelPreset, ExternalAgentConfig } from '../infrastructure/ai/types';
import { getExternalAgentSdkBackend } from '../infrastructure/ai/managedAgents';

export function modelPresetMatchesId(preset: AgentModelPreset, modelId: string): boolean {
  if (preset.thinkingLevels?.length) {
    return preset.thinkingLevels.some((level) => `${preset.id}/${level}` === modelId);
  }
  return preset.id === modelId;
}

export function modelPresetsContainId(presets: AgentModelPreset[], modelId: string): boolean {
  return presets.some((preset) => modelPresetMatchesId(preset, modelId));
}

export function isCopilotAgentConfig(agent?: ExternalAgentConfig): boolean {
  if (!agent) return false;
  const tokens = [
    agent.id,
    agent.name,
    agent.icon,
    agent.command,
    getExternalAgentSdkBackend(agent),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    // Split on both separators so Windows command paths (e.g. "...\\copilot.exe")
    // reduce to their basename rather than staying as the full path.
    .map((value) => value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase());
  return tokens.some((token) => token.includes('copilot'));
}

export function shouldLoadSdkRuntimeModels(agent?: ExternalAgentConfig): boolean {
  const sdkBackend = getExternalAgentSdkBackend(agent);
  return sdkBackend === 'claude'
    || sdkBackend === 'copilot'
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
