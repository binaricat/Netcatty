"use strict";

const localShellRules = require("./localShellRules.json");

const POWERSHELL_SHELLS = new Set(localShellRules.powershellShells);
const CMD_SHELLS = new Set(localShellRules.cmdShells);
const FISH_SHELLS = new Set(localShellRules.fishShells);
const POSIX_SHELLS = new Set(localShellRules.posixShells);
const WSL_SHELLS = new Set(localShellRules.wslShells);
// Discovered-shell IDs the local-shell editor persists (they are not executable
// basenames): every WSL distro ID is "wsl-<distro>", and Git Bash / Cygwin
// launch a POSIX bash, so these values classify as "posix" by ID form.
const DISCOVERED_POSIX_SHELL_ID_PREFIXES = localShellRules.discoveredPosixShellIdPrefixes;
const DISCOVERED_POSIX_SHELL_IDS = new Set(localShellRules.discoveredPosixShellIds);

function getExecutableBaseName(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/);
  return (parts[parts.length - 1] || "").toLowerCase();
}

/**
 * Recover the executable basename from a disambiguated Unix discovery ID.
 *
 * `discoverUnixShells()` (shellDiscovery.cjs) uses the bare basename as the
 * discovered-shell ID only while it is unique; when multiple installations
 * share a basename (e.g. /bin/bash vs /opt/homebrew/bin/bash) it falls back
 * to a path slug: the absolute shell path with separators replaced by "-"
 * ("bin-bash", "opt-homebrew-bin-bash"). Such IDs are stored as the host's
 * `localShell` value, so they must resolve like the backend does (which maps
 * the ID to the real command at spawn time) before classification.
 *
 * Only slug-shaped values (no separators, contains "-") are considered, and
 * only when the final slug segment names a recognizable shell, so custom
 * commands like "custom-shell" still classify as "unknown".
 */
function resolveDisambiguatedUnixShellIdBase(shellName) {
  if (!shellName || /[\\/]/.test(shellName) || !shellName.includes("-")) {
    return shellName;
  }
  const segments = shellName.split("-");
  return segments[segments.length - 1] || shellName;
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

function classifyShellBaseName(shellName) {
  if (POWERSHELL_SHELLS.has(shellName)) return "powershell";
  if (CMD_SHELLS.has(shellName)) return "cmd";
  if (FISH_SHELLS.has(shellName)) return "fish";
  if (POSIX_SHELLS.has(shellName)) return "posix";
  if (WSL_SHELLS.has(shellName)) return "posix";
  if (
    DISCOVERED_POSIX_SHELL_ID_PREFIXES.some((prefix) => shellName.startsWith(prefix)) ||
    DISCOVERED_POSIX_SHELL_IDS.has(shellName)
  ) {
    return "posix";
  }
  return undefined;
}

function classifyLocalShellType(shellPath, platformLike) {
  const shellName = getExecutableBaseName(shellPath);
  const byBaseName = classifyShellBaseName(shellName);
  if (byBaseName) return byBaseName;
  const slugBaseName = resolveDisambiguatedUnixShellIdBase(shellName);
  if (slugBaseName !== shellName) {
    const bySlugBaseName = classifyShellBaseName(slugBaseName);
    if (bySlugBaseName) return bySlugBaseName;
  }
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
