/**
 * Anthropic-compatible gateways disagree on Base URL shape:
 * - Claude Code / official host: bare origin (…/host), paths are /v1/messages, /v1/models
 * - @ai-sdk/anthropic: base already includes /v1, then appends /messages, /models
 * - Custom proxies: complete SDK prefix that is not /v1 (e.g. …/anthropic → /anthropic/messages)
 *
 * Netcatty accepts Claude Code bare hosts and AI SDK /v1 bases at chat / probe
 * boundaries. Custom non-/v1 path prefixes are left unchanged so previously
 * working proxy bases keep working.
 */

/** Official Agent Plan accepts Claude Code's /api/plan base and Bearer auth.
 * Keep this exact-origin/path exception separate from arbitrary custom proxies.
 */
export function isAnthropicAgentPlanEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL.trim());
    return url.protocol === "https:"
      && url.hostname === "ark.cn-beijing.volces.com"
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/api\/plan(?:\/v1)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Strip trailing slashes; empty input stays empty. */
export function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** True when the URL path already ends with /v1 (AI SDK style). */
export function anthropicBaseIncludesV1(baseURL: string): boolean {
  return /\/v1$/i.test(stripTrailingSlashes(baseURL));
}

/**
 * True when the Base URL is only a scheme + host (optional port), with no path.
 * Claude Code style ANTHROPIC_BASE_URL values are bare origins.
 */
export function isBareOriginBaseURL(baseURL: string): boolean {
  const trimmed = stripTrailingSlashes(baseURL);
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return !parsed.pathname || parsed.pathname === "/";
  } catch {
    // Non-absolute strings: treat as bare only when there is no path segment.
    return !trimmed.includes("/") || /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(trimmed);
  }
}

/**
 * Normalize a stored Anthropic-compat Base URL for @ai-sdk/anthropic.
 * - Bare hosts gain a /v1 suffix (Claude Code style → SDK style).
 * - Bases that already end in /v1 are left unchanged.
 * - Other path prefixes (custom proxies) are left unchanged so chat keeps
 *   requesting `{prefix}/messages` rather than `{prefix}/v1/messages`.
 */
export function normalizeAnthropicSdkBaseURL(baseURL: string): string {
  const trimmed = stripTrailingSlashes(baseURL);
  if (!trimmed) return trimmed;
  if (anthropicBaseIncludesV1(trimmed)) return trimmed;
  if (isAnthropicAgentPlanEndpoint(trimmed)) return `${trimmed}/v1`;
  if (!isBareOriginBaseURL(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
