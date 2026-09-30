import localShellRules from "./localShellRules.json";

export type LocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
export type LocalOs = "linux" | "macos" | "windows";

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

function getExecutableBaseName(filePath: string | undefined) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/);
  return (parts[parts.length - 1] || "").toLowerCase();
}

export function detectLocalOs(platformLike?: string): LocalOs {
  const platform = String(platformLike || "").toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("darwin")) return "macos";
  return "linux";
}

export function classifyLocalShellType(
  shellPath: string | undefined,
  platformLike?: string,
): LocalShellType {
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
