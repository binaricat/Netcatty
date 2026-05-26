import type { ProviderStyle } from "./types";

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
