import {
  classifyLocalShellType as classifySharedLocalShellType,
  detectLocalOs as detectSharedLocalOs,
  isDiscoveredGitBash as isSharedDiscoveredGitBash,
} from "@/lib/localShell.cjs";

export type LocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
export type LocalOs = "linux" | "macos" | "windows";

export function detectLocalOs(platformLike?: string): LocalOs {
  return detectSharedLocalOs(platformLike);
}

export function classifyLocalShellType(
  shellPath: string | undefined,
  platformLike?: string,
): LocalShellType {
  return classifySharedLocalShellType(shellPath, platformLike);
}

export function isDiscoveredGitBash(
  shell?: string,
  discoveredCommand?: string,
): boolean {
  return isSharedDiscoveredGitBash(shell, discoveredCommand);
}
