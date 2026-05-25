/**
 * Pure helpers for the Claude Code card's "config directory + environment
 * variables" editor. The managed Claude agent stores everything in its
 * ExternalAgentConfig.env; this splits that into the editable pieces and
 * recombines them. CLAUDE_CODE_EXECUTABLE is owned by path discovery, so it
 * is preserved across edits but never shown in the env editor.
 */

const CONFIG_DIR_KEY = "CLAUDE_CONFIG_DIR";
const MANAGED_KEYS = new Set(["CLAUDE_CODE_EXECUTABLE", CONFIG_DIR_KEY]);

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

export function splitClaudeEnv(
  env: Record<string, string> | undefined,
): { configDir: string; envText: string } {
  if (!env) return { configDir: "", envText: "" };
  const configDir = env[CONFIG_DIR_KEY] ?? "";
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (MANAGED_KEYS.has(k)) continue;
    rest[k] = v;
  }
  return { configDir, envText: serializeEnvLines(rest) };
}

export function buildClaudeEnv(
  prevEnv: Record<string, string> | undefined,
  configDir: string,
  envText: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  // Preserve discovery-owned key if present.
  const exe = prevEnv?.CLAUDE_CODE_EXECUTABLE;
  if (exe) next.CLAUDE_CODE_EXECUTABLE = exe;

  const trimmedDir = String(configDir || "").trim();
  if (trimmedDir) next[CONFIG_DIR_KEY] = trimmedDir;

  // Drop managed keys if a user typed them into the free-text editor — the
  // config-dir field and path discovery own CLAUDE_CONFIG_DIR / CLAUDE_CODE_EXECUTABLE.
  const parsed = parseEnvLines(envText);
  for (const key of MANAGED_KEYS) delete parsed[key];
  Object.assign(next, parsed);

  return Object.keys(next).length > 0 ? next : undefined;
}
