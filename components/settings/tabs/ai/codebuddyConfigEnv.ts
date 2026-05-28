/**
 * Pure helpers for the CodeBuddy card's environment variables editor.
 * The managed CodeBuddy agent stores everything in its
 * ExternalAgentConfig.env; this splits that into the editable pieces and
 * recombines them.
 */

const API_KEY_VAR = "CODEBUDDY_API_KEY";
const INTERNET_ENV_VAR = "CODEBUDDY_INTERNET_ENVIRONMENT";
const MANAGED_KEYS = new Set([API_KEY_VAR, INTERNET_ENV_VAR]);

export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function serializeEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function splitCodebuddyEnv(
  env: Record<string, string> | undefined,
): { apiKey: string; internetEnv: string; envText: string } {
  if (!env) return { apiKey: "", internetEnv: "", envText: "" };
  const apiKey = env[API_KEY_VAR] ?? "";
  const internetEnv = env[INTERNET_ENV_VAR] ?? "";
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (MANAGED_KEYS.has(k)) continue;
    rest[k] = v;
  }
  return { apiKey, internetEnv, envText: serializeEnvLines(rest) };
}

export function buildCodebuddyEnv(
  prevEnv: Record<string, string> | undefined,
  apiKey: string,
  internetEnv: string,
  envText: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};

  const trimmedApiKey = String(apiKey || "").trim();
  if (trimmedApiKey) next[API_KEY_VAR] = trimmedApiKey;

  const trimmedInternetEnv = String(internetEnv || "").trim();
  if (trimmedInternetEnv) next[INTERNET_ENV_VAR] = trimmedInternetEnv;

  // Drop managed keys if a user typed them into the free-text editor
  const parsed = parseEnvLines(envText);
  for (const key of MANAGED_KEYS) delete parsed[key];
  Object.assign(next, parsed);

  return Object.keys(next).length > 0 ? next : undefined;
}
