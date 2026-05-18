import localShellRules from "./localShellRules.json";

export type LocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
export type LocalOs = "linux" | "macos" | "windows";

const POWERSHELL_SHELLS = new Set(localShellRules.powershellShells);
const CMD_SHELLS = new Set(localShellRules.cmdShells);
const FISH_SHELLS = new Set(localShellRules.fishShells);
const POSIX_SHELLS = new Set(localShellRules.posixShells);
const WSL_SHELLS = new Set(localShellRules.wslShells);

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
  if (!shellName) {
    return detectLocalOs(platformLike) === "windows" ? "powershell" : "posix";
  }
  return "unknown";
}
