"use strict";

/**
 * Claude Code auth/config detection helpers (main process).
 *
 * Claude SDK launches can authenticate from env (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)
 * or from credentials stored under CLAUDE_CONFIG_DIR (default ~/.claude). We use
 * this to turn opaque "-32603 Internal error" failures into an actionable message
 * when no auth is configured. NOTE: macOS may store credentials in the Keychain
 * rather than a file, so 'none' is a heuristic — callers must NOT hard-block on it;
 * only use it to improve the error message after an actual failure.
 */

const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Expand a leading "~" to the user's home directory. Env vars handed to a
 * child process are NOT shell-expanded, so "~/.claude" would otherwise be
 * treated as a literal directory named "~". Only a leading "~", "~/" or "~\"
 * is expanded (not "~user"); other values pass through unchanged.
 */
function expandHomePath(p) {
  if (typeof p !== "string") return p;
  const trimmed = p.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return p;
}

function getClaudeConfigDir(env) {
  const custom = typeof env?.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return custom ? expandHomePath(custom) : path.join(os.homedir(), ".claude");
}

/**
 * @returns {'env'|'credentials-file'|'none'}
 */
function detectClaudeAuthPresence(env, fileExists = existsSync) {
  const apiKey = typeof env?.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "";
  const authToken = typeof env?.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
  if (apiKey || authToken) return "env";
  if (fileExists(path.join(getClaudeConfigDir(env), ".credentials.json"))) return "credentials-file";
  return "none";
}

module.exports = { detectClaudeAuthPresence, getClaudeConfigDir, expandHomePath };
