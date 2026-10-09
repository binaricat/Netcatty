"use strict";

const localShellRules = require("./localShellRules.json");

const POWERSHELL_SHELLS = new Set(localShellRules.powershellShells);
const CMD_SHELLS = new Set(localShellRules.cmdShells);
const FISH_SHELLS = new Set(localShellRules.fishShells);
const POSIX_SHELLS = new Set(localShellRules.posixShells);
const WSL_SHELLS = new Set(localShellRules.wslShells);

// Versioned zsh installs (Homebrew `zsh-5.9`, packaging `zsh.5.9`, …) are
// posix shells even though the rule lists only know the plain name. The
// pattern matches the zsh flavor detection in the AI pty exec helpers so a
// local session classified here also gets the zsh single-line wrapper
// (#3575 / #3576) instead of being rejected as "unknown" first.
const VERSIONED_ZSH_PATTERN = /^zsh([-.][0-9][^\\/]*)?$/i;

function getExecutableBaseName(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/);
  return (parts[parts.length - 1] || "").toLowerCase();
}

function detectLocalOs(platformLike) {
  const platform = String(platformLike || "").toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("darwin")) return "macos";
  return "linux";
}

/**
 * True when `filePath` points inside `%LOCALAPPDATA%\Microsoft\WindowsApps`,
 * i.e. it is a Windows App Execution Alias (MSIX/Store install stub).
 *
 * Aliases are zero-byte reparse points: `fs.statSync()` fails with EACCES and
 * `fs.existsSync()` returns false, yet spawning the alias path still launches
 * the packaged application. Consumers must not use existence checks to reject
 * these paths. Deliberately free of `node:path` — this module is also bundled
 * for the renderer.
 */
function isWindowsAppExecutionAliasPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  // Read via globalThis so renderer bundles (where `process` is not a global)
  // stay valid; alias detection is a main-process concern and safely
  // returns false when the env is unavailable.
  const localAppData = globalThis.process?.env?.LOCALAPPDATA;
  if (!localAppData) return false;
  const normalize = (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const aliasDir = `${normalize(localAppData)}/microsoft/windowsapps/`;
  return normalize(filePath).startsWith(aliasDir);
}

function classifyLocalShellType(shellPath, platformLike) {
  const shellName = getExecutableBaseName(shellPath);
  if (POWERSHELL_SHELLS.has(shellName)) return "powershell";
  if (CMD_SHELLS.has(shellName)) return "cmd";
  if (FISH_SHELLS.has(shellName)) return "fish";
  if (POSIX_SHELLS.has(shellName)) return "posix";
  if (WSL_SHELLS.has(shellName)) return "posix";
  if (VERSIONED_ZSH_PATTERN.test(shellName)) return "posix";
  if (!shellName) {
    return detectLocalOs(platformLike) === "windows" ? "powershell" : "posix";
  }
  return "unknown";
}

module.exports = {
  classifyLocalShellType,
  detectLocalOs,
  isWindowsAppExecutionAliasPath,
};
