type SharedLocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
type SharedLocalOs = "linux" | "macos" | "windows";

declare module "./localShell.cjs" {
  export function detectLocalOs(platformLike?: string): SharedLocalOs;
  export function classifyLocalShellType(
    shellPath: string | undefined,
    platformLike?: string,
  ): SharedLocalShellType;
  export function isWindowsAppExecutionAliasPath(filePath: string): boolean;
  export function isDiscoveredGitBash(shell?: string, discoveredCommand?: string): boolean;
}

declare module "@/lib/localShell.cjs" {
  export function detectLocalOs(platformLike?: string): SharedLocalOs;
  export function classifyLocalShellType(
    shellPath: string | undefined,
    platformLike?: string,
  ): SharedLocalShellType;
  export function isWindowsAppExecutionAliasPath(filePath: string): boolean;
  export function isDiscoveredGitBash(shell?: string, discoveredCommand?: string): boolean;
}
