/**
 * Codex-related helper functions and state.
 *
 * Manages Codex login sessions, auth validation cache, binary resolution,
 * integration state normalization, and error / fingerprint utilities.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
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

function extractCodexError(error) {
  const message =
    error?.data?.message ||
    error?.errorText ||
    error?.message ||
    error?.error ||
    String(error);
  const code = error?.data?.code || error?.code;
  return {
    message: typeof message === "string" ? message : String(message),
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
  extractCodexError,
  isCodexAuthError,
  getCodexAuthFingerprint,
  getCodexMcpFingerprint,
  invalidateCodexValidationCache,
  getCodexValidationCache,
  setCodexValidationCache,
};
