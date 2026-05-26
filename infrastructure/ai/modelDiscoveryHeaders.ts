import type { ProviderStyle } from "./types";

/**
 * Pick auth headers for a provider's `/models` discovery endpoint.
 *
 * The Anthropic-protocol family uses `x-api-key` + `anthropic-version`;
 * every other family (OpenAI-compat, Google) uses Bearer.
 *
 * Returning an empty object when the key is missing lets the caller still
 * issue an unauthenticated probe (e.g. against local Ollama).
 */
export function buildModelDiscoveryHeaders(
  style: ProviderStyle,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  if (style === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}
