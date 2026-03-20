"use strict";

const POWERSHELL_SHELLS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const CMD_SHELLS = new Set(["cmd", "cmd.exe"]);
const FISH_SHELLS = new Set(["fish"]);
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash"]);

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

function classifyLocalShellType(shellPath, platformLike) {
  const shellName = getExecutableBaseName(shellPath);
  if (POWERSHELL_SHELLS.has(shellName)) return "powershell";
  if (CMD_SHELLS.has(shellName)) return "cmd";
  if (FISH_SHELLS.has(shellName)) return "fish";
  if (POSIX_SHELLS.has(shellName)) return "posix";
  if (!shellName) {
    return detectLocalOs(platformLike) === "windows" ? "powershell" : "posix";
  }
  return "unknown";
}

module.exports = {
  classifyLocalShellType,
  detectLocalOs,
};
