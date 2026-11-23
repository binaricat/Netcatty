/**
 * Pure helpers for the Claude Code card's "config directory + environment
 * variables" editor. The managed Claude agent stores everything in its
 * ExternalAgentConfig.env; this splits that into the editable pieces and
 * recombines them. CLAUDE_CODE_EXECUTABLE is owned by path discovery, so it
 * is preserved across edits but never shown in the env editor.
 */

import {
  extractUnmanagedEnvText,
  mergeManagedAndUserEnv,
  parseEnvLines,
  serializeEnvLines,
} from "./agentConfigEnv";

export { parseEnvLines, serializeEnvLines };

const CONFIG_DIR_KEY = "CLAUDE_CONFIG_DIR";
// netcatty marker carrying the claude SDK `settings` option (a settings.json
// path or inline JSON). Extracted in the main process and passed to the SDK as
// `options.settings`; never sent to the agent as a real env var. Additive to —
// and independent of — CLAUDE_CONFIG_DIR.
const SETTINGS_KEY = "NETCATTY_CLAUDE_SETTINGS";
const MANAGED_KEYS = new Set(["CLAUDE_CODE_EXECUTABLE", CONFIG_DIR_KEY, SETTINGS_KEY]);

export function splitClaudeEnv(
  env: Record<string, string> | undefined,
): { configDir: string; settingsPath: string; envText: string } {
  if (!env) return { configDir: "", settingsPath: "", envText: "" };
  return {
    configDir: env[CONFIG_DIR_KEY] ?? "",
    settingsPath: env[SETTINGS_KEY] ?? "",
    envText: extractUnmanagedEnvText(env, MANAGED_KEYS),
  };
}

export function buildClaudeEnv(
  prevEnv: Record<string, string> | undefined,
  configDir: string,
  settingsPath: string,
  envText: string,
): Record<string, string> | undefined {
  const managed: Record<string, string> = {};
  const exe = prevEnv?.CLAUDE_CODE_EXECUTABLE;
  if (exe) managed.CLAUDE_CODE_EXECUTABLE = exe;

  const trimmedDir = String(configDir || "").trim();
  if (trimmedDir) managed[CONFIG_DIR_KEY] = trimmedDir;

  const trimmedSettings = String(settingsPath || "").trim();
  if (trimmedSettings) managed[SETTINGS_KEY] = trimmedSettings;

  return mergeManagedAndUserEnv(managed, envText, MANAGED_KEYS);
}
