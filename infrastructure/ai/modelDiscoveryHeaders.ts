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
 * True when `baseURL` is a valid URL whose host is not the official
 * `api.anthropic.com` endpoint. Omitted or blank values default to the
 * official host and return `false`.
 */
export function isCustomAnthropicBaseURL(baseURL?: string): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) return false;
  try {
    return new URL(trimmed).hostname.toLowerCase() !== "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Pick auth headers for a provider's `/models` discovery endpoint.
 *
 * Each wire-protocol family uses its own auth dialect:
 * - `anthropic`: `x-api-key` + `anthropic-version` on official `api.anthropic.com`;
 *   custom Anthropic-compatible gateways also receive `Authorization: Bearer ...`
 * - `google`:    `x-goog-api-key` (Google Generative AI rejects Bearer)
 * - `openai`:    `Authorization: Bearer …` (also the OpenAI-compat default)
 *
 * Returning an empty object when the key is missing lets the caller still
 * issue an unauthenticated probe (e.g. against local Ollama).
 */
function buildDefaultModelDiscoveryHeaders(
  style: ProviderStyle,
  apiKey: string | undefined,
  baseURL?: string,
): Record<string, string> {
  if (!apiKey) return {};
  switch (style) {
    case "anthropic":
      return {
        "x-api-key": apiKey,
        ...(isCustomAnthropicBaseURL(baseURL)
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
        "anthropic-version": "2023-06-01",
      };
    case "google":
      return { "x-goog-api-key": apiKey };
    case "openai":
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}

export function buildModelDiscoveryHeaders(
  style: ProviderStyle,
  apiKey: string | undefined,
  customHeaders: Record<string, string> = {},
  baseURL?: string,
): Record<string, string> {
  const headers = buildDefaultModelDiscoveryHeaders(style, apiKey, baseURL);
  const overridden = new Set(Object.keys(customHeaders).map((name) => name.toLowerCase()));
  return Object.fromEntries([
    ...Object.entries(headers).filter(([name]) => !overridden.has(name.toLowerCase())),
    ...Object.entries(customHeaders),
  ]);
}
