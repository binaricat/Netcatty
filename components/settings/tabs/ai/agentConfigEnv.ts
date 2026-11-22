/**
 * Shared env-line parser/serializer for external AI agent config editors
 * (Claude Code, CodeBuddy, etc.).
 */

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

export function extractUnmanagedEnvText(
  env: Record<string, string> | undefined,
  managedKeys: ReadonlySet<string>,
): string {
  if (!env) return "";
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (managedKeys.has(k)) continue;
    rest[k] = v;
  }
  return serializeEnvLines(rest);
}

export function mergeManagedAndUserEnv(
  managedEntries: Record<string, string>,
  envText: string,
  managedKeys: ReadonlySet<string>,
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...managedEntries };
  const parsed = parseEnvLines(envText);
  for (const key of managedKeys) delete parsed[key];
  Object.assign(next, parsed);
  return Object.keys(next).length > 0 ? next : undefined;
}
