"use strict";

/**
 * Shell-aware command blocklist helpers shared by the main-process AI exec
 * paths (in-app bridge handlers, MCP TCP bridge handlers, terminal worker).
 *
 * The default table in lib/commandBlocklist.json is grouped into
 * common / posix / powershell patterns. Callers pass the best shell kind they
 * can resolve for the target session:
 *   - live session objects: resolveSessionBlocklistShellKind(session) mirrors
 *     the inputs the AI PTY wrapper uses (confirmed kind, live idle prompt,
 *     remote login-shell hint)
 *   - metadata-only paths: meta.shellType (often empty; callers that know a
 *     downstream authoritative check re-runs the defaults should fall back to
 *     checkBlocklistCommonOnly instead of the strict full table, so
 *     POSIX-only patterns never block PowerShell-native commands)
 *
 * User-added patterns (settings list entries that are not part of the default
 * table) always apply, on every shell.
 */

const {
  DEFAULT_COMMAND_BLOCKLIST,
  COMMON_PATTERNS,
  isDefaultBlocklistPattern,
  selectDefaultBlocklistPatterns,
} = require("../../../lib/commandBlocklist.cjs");
const { resolveEffectiveShellKind } = require("./ptyExecHelpers.cjs");
const {
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
  isDefaultCmdPromptLine,
  isDefaultPosixPromptLine,
  stripAnsi,
} = require("./shellUtils.cjs");

function compilePatterns(patterns) {
  return patterns
    .map((pattern) => {
      try {
        return { pattern, regex: new RegExp(pattern, "i") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const compiledDefaultCache = new Map();

function compiledDefaultPatternsFor(shellKind) {
  const key = String(shellKind || "").toLowerCase();
  let compiled = compiledDefaultCache.get(key);
  if (!compiled) {
    compiled = compilePatterns(selectDefaultBlocklistPatterns(key));
    compiledDefaultCache.set(key, compiled);
  }
  return compiled;
}

const compiledCommonPatterns = compilePatterns(COMMON_PATTERNS);
// User blocklists are stable between settings updates; compile each list once.
const compiledUserCache = new WeakMap();

function compiledUserPatterns(blocklist) {
  let compiled = compiledUserCache.get(blocklist);
  if (!compiled) {
    const userPatterns = blocklist.filter(
      (pattern) => !isDefaultBlocklistPattern(pattern),
    );
    compiled = compilePatterns(userPatterns);
    compiledUserCache.set(blocklist, compiled);
  }
  return compiled;
}

function firstMatch(command, compiled) {
  for (const { pattern, regex } of compiled) {
    if (regex.test(command)) {
      return { blocked: true, matchedPattern: pattern };
    }
  }
  return null;
}

function firstEnabledDefaultMatch(command, compiled, enabledPatterns) {
  for (const { pattern, regex } of compiled) {
    if (enabledPatterns.has(pattern) && regex.test(command)) {
      return { blocked: true, matchedPattern: pattern };
    }
  }
  return null;
}

function normalizeConfiguredBlocklist(blocklist) {
  return Array.isArray(blocklist) ? blocklist : DEFAULT_COMMAND_BLOCKLIST;
}

/**
 * User additions + default patterns selected for shellKind.
 * Unknown / empty shell kinds keep the strict full default table.
 */
function checkBlocklistForShell(command, shellKind, configuredBlocklist = DEFAULT_COMMAND_BLOCKLIST) {
  const blocklist = normalizeConfiguredBlocklist(configuredBlocklist);
  const userMatch = firstMatch(command, compiledUserPatterns(blocklist));
  if (userMatch) return userMatch;
  return firstEnabledDefaultMatch(
    command,
    compiledDefaultPatternsFor(shellKind),
    new Set(blocklist),
  ) || { blocked: false };
}

/**
 * User additions + shell-independent (common) default patterns only.
 * For metadata-only call sites that know a downstream authoritative check
 * re-runs the full shell-selected defaults on the live session.
 */
function checkBlocklistCommonOnly(command, configuredBlocklist = DEFAULT_COMMAND_BLOCKLIST) {
  const blocklist = normalizeConfiguredBlocklist(configuredBlocklist);
  const userMatch = firstMatch(command, compiledUserPatterns(blocklist));
  if (userMatch) return userMatch;
  return firstEnabledDefaultMatch(command, compiledCommonPatterns, new Set(blocklist)) || { blocked: false };
}

/**
 * Best-effort shell kind for a live session, mirroring the inputs the AI PTY
 * wrapper uses (ptyExecHelpers.resolveEffectiveShellKind): confirmed shell
 * kind, live idle prompt, and the remote login-shell probe hint.
 */
function resolveSessionBlocklistShellKind(session) {
  if (!session || typeof session !== "object") return "";
  let prompt = null;
  try {
    prompt = getFreshIdlePrompt(session);
  } catch {
    prompt = null;
  }
  try {
    const baseKind = session.shellKind === "unknown" ? "" : (session.shellKind || "");
    const loginShellHint = session._loginShellKind || "";
    const resolved = resolveEffectiveShellKind(baseKind, prompt, { loginShellHint }) || "";
    if (baseKind || loginShellHint) return resolved;

    const lastPromptLine = stripAnsi(String(prompt || ""))
      .replace(/\r/g, "\n")
      .split("\n")
      .pop()
      .replace(/\s+$/, "");
    if (
      isDefaultPowerShellPromptLine(lastPromptLine)
      || isDefaultCmdPromptLine(lastPromptLine)
      || isDefaultPosixPromptLine(lastPromptLine)
    ) {
      return resolved;
    }

    // Wrapper selection defaults an unclassified remote session to POSIX.
    // Safety keeps it unknown so failed probes retain the strict all-groups
    // fallback instead of silently omitting PowerShell rules.
    return "";
  } catch {
    return session.shellKind || session._loginShellKind || "";
  }
}

module.exports = {
  checkBlocklistForShell,
  checkBlocklistCommonOnly,
  resolveSessionBlocklistShellKind,
};
