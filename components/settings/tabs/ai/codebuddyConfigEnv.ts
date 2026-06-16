/**
 * Pure helpers for the CodeBuddy card's environment variables editor.
 * The managed CodeBuddy agent stores everything in its
 * ExternalAgentConfig.env; this splits that into the editable pieces and
 * recombines them.
 *
 * CODEBUDDY_CODE_PATH is owned by path discovery, so it is preserved across
 * edits but never shown in the env editor.
 *
 * The SDK supports CODEBUDDY_API_KEY (via options.env), but the CLI itself
 * does not. CODEBUDDY_INTERNET_ENVIRONMENT is managed as a first-class field.
 * Users who need CODEBUDDY_API_KEY or CODEBUDDY_AUTH_TOKEN should set them
 * in the free-text environment editor or in their shell profile.
 */

const INTERNET_ENV_VAR = "CODEBUDDY_INTERNET_ENVIRONMENT";
const CODE_PATH_KEY = "CODEBUDDY_CODE_PATH";
const MANAGED_KEYS = new Set([INTERNET_ENV_VAR, CODE_PATH_KEY]);

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
): { internetEnv: string; envText: string } {
  if (!env) return { internetEnv: "", envText: "" };
  const internetEnv = env[INTERNET_ENV_VAR] ?? "";
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (MANAGED_KEYS.has(k)) continue;
    rest[k] = v;
  }
  return { internetEnv, envText: serializeEnvLines(rest) };
}

export function buildCodebuddyEnv(
  prevEnv: Record<string, string> | undefined,
  internetEnv: string,
  envText: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};

  const trimmedInternetEnv = String(internetEnv || "").trim();
  if (trimmedInternetEnv) next[INTERNET_ENV_VAR] = trimmedInternetEnv;

  // Preserve auto-injected CODEBUDDY_CODE_PATH across edits.
  const codePath = prevEnv?.[CODE_PATH_KEY];
  if (codePath) next[CODE_PATH_KEY] = codePath;

  // Drop managed keys if a user typed them into the free-text editor
  const parsed = parseEnvLines(envText);
  for (const key of MANAGED_KEYS) delete parsed[key];
  Object.assign(next, parsed);

  return Object.keys(next).length > 0 ? next : undefined;
}
