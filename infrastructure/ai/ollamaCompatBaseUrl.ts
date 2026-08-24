/**
 * Ollama Cloud uses the OpenAI-compat host https://ollama.com/v1.
 * A bare https://ollama.com origin hits the marketing homepage (HTML) instead
 * of /v1/chat/completions. Local Ollama stays on localhost and is unchanged.
 */

/** Append /v1 when the user entered the Cloud origin without an API prefix. */
export function normalizeOllamaSdkBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  if (/^https?:\/\/ollama\.com$/i.test(trimmed)) {
    return `${trimmed}/v1`;
  }
  // Native Cloud docs use /api; the OpenAI SDK talks to /v1/chat/completions.
  const nativeCloud = trimmed.match(/^(https?:\/\/ollama\.com)\/api$/i);
  if (nativeCloud) {
    return `${nativeCloud[1]}/v1`;
  }
  return trimmed || baseURL;
}
