/**
 * Codex-related helper functions and state.
 *
 * Manages Codex login sessions, auth validation cache, binary resolution,
 * integration state normalization, and error / fingerprint utilities.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { stripAnsi, extractFirstNonLocalhostUrl, toUnpackedAsarPath } = require("./shellUtils.cjs");

// ── Module-level state ──

const codexLoginSessions = new Map();
let codexValidationCache = null;

const CODEX_AUTH_HINTS = [
  "not logged in",
  "authentication required",
  "auth required",
  "login required",
  "missing credentials",
  "no credentials",
  "unauthorized",
  "forbidden",
  "codex login",
  "401",
  "403",
  "invalid_grant",
  "invalid_token",
  "credentials",
];

// ── Package / binary resolution ──

function getCodexPackageName() {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return "@zed-industries/codex-acp-darwin-arm64";
    case "darwin-x64":
      return "@zed-industries/codex-acp-darwin-x64";
    case "linux-arm64":
      return "@zed-industries/codex-acp-linux-arm64";
    case "linux-x64":
      return "@zed-industries/codex-acp-linux-x64";
    case "win32-arm64":
      return "@zed-industries/codex-acp-win32-arm64";
    case "win32-x64":
      return "@zed-industries/codex-acp-win32-x64";
    default:
      return null;
  }
}

function resolveCodexAcpBinaryPath(shellEnv, electronModule) {
  const binaryName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
  const isPackaged = electronModule?.app?.isPackaged;

  // Dev mode: prefer system PATH
  if (!isPackaged && shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const systemPath = execFileSync(whichCmd, [binaryName], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellEnv,
      }).trim().split("\n")[0].trim();
      if (systemPath && existsSync(systemPath)) {
        return systemPath;
      }
    } catch {
      // Not on PATH
    }
  }

  // Packaged build (or dev fallback): use npm-bundled binary
  try {
    const pkgName = getCodexPackageName();
    if (!pkgName) return null;

    const pkgRoot = path.dirname(require.resolve("@zed-industries/codex-acp/package.json"));
    const resolved = require.resolve(`${pkgName}/bin/${binaryName}`, { paths: [pkgRoot] });
    return toUnpackedAsarPath(resolved);
  } catch {
    return null;
  }
}

// ── Login session helpers ──

function appendCodexLoginOutput(session, chunk) {
  const cleanChunk = stripAnsi(chunk);
  if (!cleanChunk) return;

  session.output += cleanChunk;
  if (!session.url) {
    session.url = extractFirstNonLocalhostUrl(session.output);
  }
}

function toCodexLoginSessionResponse(session) {
  return {
    sessionId: session.id,
    state: session.state,
    url: session.url,
    output: session.output,
    error: session.error,
    exitCode: session.exitCode,
  };
}

function getActiveCodexLoginSession() {
  for (const session of codexLoginSessions.values()) {
    if (session.state === "running" && session.process && !session.process.killed) {
      return session;
    }
  }
  return null;
}

// ── Codex config.toml probing ──
//
// Users who hand-configure `~/.codex/config.toml` with a custom
// `model_provider` + matching `[model_providers.<name>]` entry are fully
// functional from the Codex CLI, but `codex login status` doesn't see them
// because it only reports on `~/.codex/auth.json` (populated by `codex login`).
// We read and minimally parse the config file so we can surface this as a
// valid "ready" state and skip the ChatGPT login prompt in the UI.

/** Find `#` outside quoted regions. Tracks escape state via a flag rather
 *  than peeking at the previous character, so even runs of backslashes like
 *  `"C:\\path\\"` close the string correctly. Literal (single-quoted) TOML
 *  strings don't recognize `\` as an escape, so only honor escapes inside
 *  basic (double-quoted) strings. */
function findUnquotedHash(value) {
  let inStr = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inStr = false;
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === "#") return i;
  }
  return -1;
}

/**
 * Parse the narrow subset of TOML we need from Codex's config.toml:
 *   - top-level string keys (e.g. `model_provider = "my_provider"`)
 *   - `[model_providers.<name>]` tables with string-valued keys
 * Unsupported TOML features (arrays, inline tables, multi-line strings, etc.)
 * are ignored — Codex's config.toml doesn't use them for provider definitions.
 */
function parseCodexConfigToml(text) {
  const result = { model_providers: {} };
  let currentProvider = null;
  let atTopLevel = true;

  // Strip UTF-8 BOM so the first key still matches the regex on Windows-edited files.
  const normalized = String(text || "").replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine;
    const hashIdx = findUnquotedHash(line);
    if (hashIdx >= 0) line = line.slice(0, hashIdx);
    line = line.trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      if (section.startsWith("model_providers.")) {
        currentProvider = section.slice("model_providers.".length);
        if (!result.model_providers[currentProvider]) {
          result.model_providers[currentProvider] = {};
        }
        atTopLevel = false;
      } else {
        currentProvider = null;
        atTopLevel = false;
      }
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    let raw = kvMatch[2].trim();
    let value;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      value = raw.slice(1, -1);
    } else {
      value = raw;
    }

    if (atTopLevel) {
      result[key] = value;
    } else if (currentProvider) {
      result.model_providers[currentProvider][key] = value;
    }
  }

  return result;
}

/**
 * Inspect `~/.codex/config.toml` to determine whether the user has
 * configured a custom `model_provider` that isn't the built-in OpenAI/ChatGPT
 * path.
 *
 * Returns null when:
 *   - the config file doesn't exist or can't be read
 *   - no `model_provider` is set, or it points to the default `openai` preset
 *   - the referenced provider entry is missing (config is malformed)
 *
 * Returns a summary object otherwise — even if the env_key isn't currently
 * exported in the shell environment. That case is surfaced via
 * `envKeyPresent: false` so the UI can warn the user; we don't want the
 * absence of an env var to silently fall back to the ChatGPT login flow,
 * because the config.toml is a strong signal the user doesn't want that.
 */
function readCodexCustomProviderConfig(shellEnv) {
  const home = shellEnv?.HOME || shellEnv?.USERPROFILE || os.homedir();
  if (!home) return null;
  const configPath = path.join(home, ".codex", "config.toml");
  if (!existsSync(configPath)) return null;

  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = parseCodexConfigToml(text);
  } catch {
    return null;
  }

  const activeName = typeof parsed.model_provider === "string"
    ? parsed.model_provider.trim()
    : "";
  if (!activeName) return null;
  // The built-in "openai" provider still goes through ChatGPT/API-key auth
  // managed by `codex login`, so treating it as "custom" would be wrong.
  if (activeName === "openai") return null;

  const providerEntry = parsed.model_providers?.[activeName];
  if (!providerEntry) return null;

  const envKeyName = typeof providerEntry.env_key === "string" ? providerEntry.env_key.trim() : "";
  const envKeyValue = envKeyName && shellEnv ? String(shellEnv[envKeyName] || "").trim() : "";
  const hardcodedApiKey = typeof providerEntry.api_key === "string" ? providerEntry.api_key.trim() : "";
  const activeModel = typeof parsed.model === "string" ? parsed.model.trim() : "";

  // Hash the actual auth material (either the hardcoded api_key or the
  // resolved env_key value) so the ACP provider fingerprint changes when
  // the user rotates their key — without ever returning the raw value
  // across the IPC boundary.
  const authMaterial = hardcodedApiKey || envKeyValue;
  const authHash = authMaterial
    ? createHash("sha256").update(authMaterial).digest("hex")
    : null;

  return {
    providerName: activeName,
    displayName: providerEntry.name || activeName,
    baseUrl: providerEntry.base_url || null,
    envKey: envKeyName || null,
    envKeyPresent: Boolean(envKeyValue),
    hasHardcodedApiKey: Boolean(hardcodedApiKey),
    model: activeModel || null,
    authHash,
  };
}

/**
 * Returns a user-facing error message when a Codex config.toml custom
 * provider references an env_key that isn't exported in the shell env and
 * doesn't have a hardcoded api_key either — otherwise returns null. Shared
 * by every spawn path (stream handler, list-models handler) so users get
 * the same actionable message regardless of which one hits first.
 */
function getCodexCustomConfigPreflightError(customConfig) {
  if (!customConfig) return null;
  if (!customConfig.envKey) return null;
  if (customConfig.envKeyPresent || customConfig.hasHardcodedApiKey) return null;
  return `Codex is configured to use the "${customConfig.displayName}" provider from ~/.codex/config.toml, but the environment variable ${customConfig.envKey} is not set. Export it in your shell (e.g. add to ~/.zshrc) and click "Refresh Status" in Settings.`;
}

/**
 * Compute the ACP auth override object for Codex spawn sites.
 *   - netcatty-managed API key present → "codex-api-key"
 *   - user's own ~/.codex/config.toml custom provider detected → no override
 *     (so codex-acp resolves auth from the shell env / config itself)
 *   - otherwise → "chatgpt" (triggers the browser OAuth login flow)
 *
 * Returned as an object designed to be spread into createACPProvider options.
 */
function getCodexAuthOverride(apiKey, shellEnv) {
  if (apiKey) return { authMethodId: "codex-api-key" };
  if (readCodexCustomProviderConfig(shellEnv)) return {};
  return { authMethodId: "chatgpt" };
}

// ── Integration state ──

function normalizeCodexIntegrationState(rawOutput) {
  const normalizedOutput = String(rawOutput || "").toLowerCase();

  if (normalizedOutput.includes("logged in using chatgpt")) {
    return "connected_chatgpt";
  }
  if (
    normalizedOutput.includes("logged in using an api key") ||
    normalizedOutput.includes("logged in using api key")
  ) {
    return "connected_api_key";
  }
  if (normalizedOutput.includes("not logged in")) {
    return "not_logged_in";
  }
  return "unknown";
}

// ── Error helpers ──

function safeJsonStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue !== "object" || nestedValue === null) {
        return nestedValue;
      }
      if (seen.has(nestedValue)) {
        return "[Circular]";
      }
      seen.add(nestedValue);
      return nestedValue;
    });
  } catch {
    return null;
  }
}

function stringifyErrorValue(value, seen = new WeakSet()) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message || value.name || String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular error]";
  seen.add(value);

  const candidates = [
    value?.data?.message,
    value?.data?.error,
    value?.errorText,
    value?.message,
    value?.error,
    value?.cause,
    value?.data,
  ];
  for (const candidate of candidates) {
    const message = stringifyErrorValue(candidate, seen).trim();
    if (message && message !== "{}") {
      return message;
    }
  }

  return safeJsonStringify(value) || String(value);
}

function extractCodexError(error) {
  const message = stringifyErrorValue(error) || "Unknown Codex error";
  const code = error?.data?.code || error?.code || error?.error?.code || error?.data?.error?.code;
  return {
    message,
    code: typeof code === "string" ? code : undefined,
  };
}

function isCodexAuthError(params) {
  const searchableText = `${params?.code || ""} ${params?.message || ""}`.toLowerCase();
  return CODEX_AUTH_HINTS.some((hint) => searchableText.includes(hint));
}

// ── Fingerprints ──

function getCodexAuthFingerprint(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

function getCodexMcpFingerprint(mcpServers) {
  return createHash("sha256").update(JSON.stringify(mcpServers || [])).digest("hex");
}

// ── Validation cache ──

function invalidateCodexValidationCache() {
  codexValidationCache = null;
}

function getCodexValidationCache() {
  return codexValidationCache;
}

function setCodexValidationCache(value) {
  codexValidationCache = value;
}

module.exports = {
  codexLoginSessions,
  getCodexPackageName,
  resolveCodexAcpBinaryPath,
  appendCodexLoginOutput,
  toCodexLoginSessionResponse,
  getActiveCodexLoginSession,
  normalizeCodexIntegrationState,
  readCodexCustomProviderConfig,
  getCodexAuthOverride,
  getCodexCustomConfigPreflightError,
  extractCodexError,
  isCodexAuthError,
  getCodexAuthFingerprint,
  getCodexMcpFingerprint,
  invalidateCodexValidationCache,
  getCodexValidationCache,
  setCodexValidationCache,
};
