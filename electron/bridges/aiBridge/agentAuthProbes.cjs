"use strict";

/**
 * Layer-3 (authentication) CLI probes for the three managed backends.
 * Each probe is dependency-injected (runners / fileExists) for unit testing;
 * the discovery handler wires the real implementations.
 *
 * Returns: { authenticated: boolean, authSource: string|null }
 */
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function defaultFileExists(p) {
  try { return existsSync(p); } catch { return false; }
}

// ── Claude ──
function defaultRunSecurity() {
  // macOS keychain lookup for the Claude Code OAuth credentials entry.
  try {
    const stdout = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 4000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err?.status ?? 1, stdout: "" };
  }
}

function probeClaudeAuth({ env, platform, runSecurity, fileExists, homeDir } = {}) {
  const e = env || process.env;
  const plat = platform || process.platform;
  const fx = fileExists || defaultFileExists;
  const home = homeDir || os.homedir();

  const apiKey = typeof e.ANTHROPIC_API_KEY === "string" ? e.ANTHROPIC_API_KEY.trim() : "";
  const oauthToken = typeof e.CLAUDE_CODE_OAUTH_TOKEN === "string" ? e.CLAUDE_CODE_OAUTH_TOKEN.trim() : "";
  const authToken = typeof e.ANTHROPIC_AUTH_TOKEN === "string" ? e.ANTHROPIC_AUTH_TOKEN.trim() : "";
  if (apiKey || oauthToken || authToken) return { authenticated: true, authSource: "env" };

  if (plat === "darwin") {
    const sec = (runSecurity || defaultRunSecurity)();
    if (sec && sec.exitCode === 0 && String(sec.stdout || "").trim()) {
      return { authenticated: true, authSource: "keychain" };
    }
  }

  const configDir = typeof e.CLAUDE_CONFIG_DIR === "string" && e.CLAUDE_CONFIG_DIR.trim()
    ? e.CLAUDE_CONFIG_DIR.trim()
    : path.join(home, ".claude");
  if (fx(path.join(configDir, ".credentials.json"))) {
    return { authenticated: true, authSource: "credentials-file" };
  }
  return { authenticated: false, authSource: null };
}

// ── Copilot ──
function defaultRunGhAuthStatus() {
  try {
    const out = execFileSync("gh", ["auth", "status"], {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: out, stderr: "" };
  } catch (err) {
    return { exitCode: err?.status ?? 1, stdout: "", stderr: String(err?.stderr || err?.message || "") };
  }
}

function probeCopilotAuth({ runGhAuthStatus } = {}) {
  const res = (runGhAuthStatus || defaultRunGhAuthStatus)();
  if (res && res.exitCode === 0) return { authenticated: true, authSource: "gh" };
  return { authenticated: false, authSource: null };
}

// ── Codex ──
function probeCodexAuth({ runLoginStatus, fileExists, homeDir } = {}) {
  const fx = fileExists || defaultFileExists;
  const home = homeDir || os.homedir();
  const res = runLoginStatus ? runLoginStatus() : { exitCode: 1, stdout: "" };
  const out = String((res && (res.stdout || res.stderr)) || "").toLowerCase();
  if (out.includes("logged in using chatgpt")) return { authenticated: true, authSource: "chatgpt" };
  if (out.includes("logged in using an api key") || out.includes("logged in using api key")) {
    return { authenticated: true, authSource: "api-key" };
  }
  if (fx(path.join(home, ".codex", "auth.json"))) {
    return { authenticated: true, authSource: "auth-file" };
  }
  return { authenticated: false, authSource: null };
}

module.exports = {
  probeClaudeAuth,
  probeCopilotAuth,
  probeCodexAuth,
  defaultRunSecurity,
  defaultRunGhAuthStatus,
};
