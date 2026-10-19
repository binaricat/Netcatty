import localShellRules from "./localShellRules.json";

export type LocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
export type LocalOs = "linux" | "macos" | "windows";

const POWERSHELL_SHELLS = new Set(localShellRules.powershellShells);
const CMD_SHELLS = new Set(localShellRules.cmdShells);
const FISH_SHELLS = new Set(localShellRules.fishShells);
const POSIX_SHELLS = new Set(localShellRules.posixShells);
const WSL_SHELLS = new Set(localShellRules.wslShells);
// Discovered-shell IDs the local-shell editor persists (they are not executable
// basenames): every WSL distro ID is "wsl-<distro>", and Git Bash / Cygwin
// launch a POSIX bash, so these values classify as "posix" by ID form.
const DISCOVERED_POSIX_SHELL_ID_PREFIXES: string[] = localShellRules.discoveredPosixShellIdPrefixes;
const DISCOVERED_POSIX_SHELL_IDS = new Set(localShellRules.discoveredPosixShellIds);

function getExecutableBaseName(filePath: string | undefined) {
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
function resolveDisambiguatedUnixShellIdBase(shellName: string): string {
  if (!shellName || /[\\/]/.test(shellName) || !shellName.includes("-")) {
    return shellName;
  }
  const segments = shellName.split("-");
  return segments[segments.length - 1] || shellName;
}

export function detectLocalOs(platformLike?: string): LocalOs {
  const platform = String(platformLike || "").toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("darwin")) return "macos";
  return "linux";
}

function classifyShellBaseName(shellName: string): LocalShellType | undefined {
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

export function classifyLocalShellType(
  shellPath: string | undefined,
  platformLike?: string,
): LocalShellType {
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
