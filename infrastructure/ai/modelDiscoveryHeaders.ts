import type { ProviderStyle } from "./types";

/**
 * Conventional `/models`-listing path for each wire-protocol family. These
 * are the same paths the official Anthropic/OpenAI/Google clients use,
 * so they line up with what compliant Anthropic-compat or OpenAI-compat
 * third parties (DeepSeek, Moonshot, Qwen, Ollama, OpenRouter, ...)
 * expose. Google is `undefined` because Generative AI's discovery isn't
 * a standard REST listing.
 */
export const STYLE_DEFAULT_MODELS_ENDPOINT: Record<ProviderStyle, string | undefined> = {
  openai: "/models",
  anthropic: "/v1/models",
  google: undefined,
};

/**
 * Pick the `/models` discovery path for a provider config. The resolved
 * `style` wins — keeping it aligned with {@link buildModelDiscoveryHeaders}
 * — falling back to the providerId-derived `presetEndpoint` only when the
 * style has no convention of its own.
 */
export function resolveModelsDiscoveryEndpoint(
  style: ProviderStyle,
  presetEndpoint?: string,
): string | undefined {
  return STYLE_DEFAULT_MODELS_ENDPOINT[style] ?? presetEndpoint;
}

/**
 * Pick auth headers for a provider's `/models` discovery endpoint.
 *
 * Each wire-protocol family uses its own auth dialect:
 * - `anthropic`: `x-api-key` + `anthropic-version`
 * - `google`:    `x-goog-api-key` (Google Generative AI rejects Bearer)
 * - `openai`:    `Authorization: Bearer …` (also the OpenAI-compat default)
 *
 * Returning an empty object when the key is missing lets the caller still
 * issue an unauthenticated probe (e.g. against local Ollama).
 */
export function buildModelDiscoveryHeaders(
  style: ProviderStyle,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  switch (style) {
    case "anthropic":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "google":
      return { "x-goog-api-key": apiKey };
    case "openai":
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}
