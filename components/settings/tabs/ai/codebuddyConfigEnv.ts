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
 */

import {
  extractUnmanagedEnvText,
  mergeManagedAndUserEnv,
  parseEnvLines,
  serializeEnvLines,
} from "./agentConfigEnv";

export { parseEnvLines, serializeEnvLines };

const INTERNET_ENV_VAR = "CODEBUDDY_INTERNET_ENVIRONMENT";
const CODE_PATH_KEY = "CODEBUDDY_CODE_PATH";
const MANAGED_KEYS = new Set([INTERNET_ENV_VAR, CODE_PATH_KEY]);

export function splitCodebuddyEnv(
  env: Record<string, string> | undefined,
): { internetEnv: string; envText: string } {
  if (!env) return { internetEnv: "", envText: "" };
  return {
    internetEnv: env[INTERNET_ENV_VAR] ?? "",
    envText: extractUnmanagedEnvText(env, MANAGED_KEYS),
  };
}

export function buildCodebuddyEnv(
  prevEnv: Record<string, string> | undefined,
  internetEnv: string,
  envText: string,
): Record<string, string> | undefined {
  const managed: Record<string, string> = {};

  const trimmedInternetEnv = String(internetEnv || "").trim();
  if (trimmedInternetEnv) managed[INTERNET_ENV_VAR] = trimmedInternetEnv;

  const codePath = prevEnv?.[CODE_PATH_KEY];
  if (codePath) managed[CODE_PATH_KEY] = codePath;

  return mergeManagedAndUserEnv(managed, envText, MANAGED_KEYS);
}
