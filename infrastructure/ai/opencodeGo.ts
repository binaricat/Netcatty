import type { ProviderConfig } from './types';

/** Provider id for the first-class OpenCode Go preset. */
export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';

/**
 * Model picked when an OpenCode Go provider is saved with a key but no model.
 * Kimi K2.7 Code is code-tuned, has a generous Go allowance, and is not one of
 * the region-restricted models (DeepSeek/LongCat need Global enabled).
 */
export const OPENCODE_GO_DEFAULT_MODEL = 'kimi-k2.7-code';

export function isOpencodeGoProvider(
  provider: Pick<ProviderConfig, 'providerId'> | null | undefined,
): boolean {
  return provider?.providerId === OPENCODE_GO_PROVIDER_ID;
}

/**
 * OpenCode Go needs nothing beyond an API key: the base URL and model catalog
 * come from the preset. Fill in a sensible default model the first time a key
 * is saved so the provider is immediately usable instead of showing an empty
 * model picker.
 */
export function withOpencodeGoAutoConfiguredModel(
  provider: Pick<ProviderConfig, 'providerId' | 'defaultModel'>,
  updates: Partial<ProviderConfig>,
): Partial<ProviderConfig> {
  if (!isOpencodeGoProvider(provider)) return updates;
  if (provider.defaultModel || updates.defaultModel?.trim()) return updates;
  if (!updates.apiKey) return updates;
  return { ...updates, defaultModel: OPENCODE_GO_DEFAULT_MODEL };
}

/**
 * Activate a freshly configured OpenCode Go provider only on first-time
 * credential setup when nothing else is already active. Adding a provider
 * should not silently steal the switch from an existing OpenAI/Anthropic
 * setup, and editing an already-configured disabled provider must preserve
 * its disabled state, while a first-run user who just pasted a key should not
 * have to hunt for the toggle.
 */
export function shouldAutoActivateOpencodeGo(
  provider: Pick<ProviderConfig, 'providerId' | 'enabled' | 'apiKey'>,
  otherProvidersEnabled: boolean,
  apiKeyPresent: boolean,
): boolean {
  if (!isOpencodeGoProvider(provider)) return false;
  if (provider.enabled || otherProvidersEnabled) return false;
  if (provider.apiKey?.trim()) return false;
  return apiKeyPresent;
}

