import type { ProviderConfig } from "./types";

/**
 * OpenCode (Zen / Go, https://opencode.ai) requires a stable
 * per-conversation session id on every request for routing and prompt-cache
 * affinity. Without it the server rejects the call with HTTP 400:
 * "Request is missing x-opencode-session and cannot be routed efficiently."
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Match the opencode.ai API hosts (Zen `.../zen/v1`, Go `.../zen/go/v1`). */
export function isOpencodeEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const hostname = new URL(baseURL).hostname;
    return hostname === "opencode.ai" || hostname.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/**
 * Build the extra SDK request headers for a provider config.
 *
 * - User-configured `customHeaders` always win verbatim (they were previously
 *   collected in settings but never applied).
 * - OpenCode endpoints get an automatic `x-opencode-session` header carrying
 *   the chat session id, so OpenCode Go can route the conversation. A
 *   user-supplied session header takes precedence over the automatic one.
 */
export function buildSdkRequestHeaders(
  config: Pick<ProviderConfig, "baseURL" | "customHeaders">,
  chatSessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...(config.customHeaders ?? {}) };
  const hasSessionHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === OPENCODE_SESSION_HEADER,
  );
  if (!hasSessionHeader && chatSessionId && isOpencodeEndpoint(config.baseURL)) {
    headers[OPENCODE_SESSION_HEADER] = chatSessionId;
  }
  return headers;
}
