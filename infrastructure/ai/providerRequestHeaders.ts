import type { ProviderConfig } from "./types";

/**
 * OpenCode (Zen / Go, https://opencode.ai) requires a stable
 * per-conversation session id on every request for routing and prompt-cache
 * affinity. Without it the server rejects the call with HTTP 400:
 * "Request is missing x-opencode-session and cannot be routed efficiently."
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * OpenCode asks clients to identify themselves instead of sending a generic
 * SDK/HTTP-library user agent. Keep it aligned with the UA used by other
 * Netcatty AI tool calls.
 */
export const OPENCODE_CLIENT_USER_AGENT = "Netcatty-AI/1.0";

/** Match the opencode.ai API hosts (Console `.../inference/go/...`, legacy `.../zen/go/...`). */
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
 * - User-configured `customHeaders` take precedence. Stored encrypted values are
 *   resolved by the main process before sending.
 * - OpenCode endpoints get an automatic `x-opencode-session` header carrying
 *   the chat session id, so OpenCode Go can route the conversation and reuse
 *   its prompt cache. A user-supplied session header takes precedence.
 * - OpenCode also gets a Netcatty user agent so traffic is not attributed to a
 *   generic SDK. A user-supplied User-Agent takes precedence.
 */
export function buildSdkRequestHeaders(
  config: Pick<ProviderConfig, "baseURL" | "customHeaders">,
  chatSessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...(config.customHeaders ?? {}) };
  if (isOpencodeEndpoint(config.baseURL)) {
    const hasSessionHeader = Object.keys(headers).some(
      (key) => key.toLowerCase() === OPENCODE_SESSION_HEADER,
    );
    if (!hasSessionHeader && chatSessionId) {
      headers[OPENCODE_SESSION_HEADER] = chatSessionId;
    }
    const hasUserAgent = Object.keys(headers).some(
      (key) => key.toLowerCase() === "user-agent",
    );
    if (!hasUserAgent) {
      headers["User-Agent"] = OPENCODE_CLIENT_USER_AGENT;
    }
  }
  return headers;
}
