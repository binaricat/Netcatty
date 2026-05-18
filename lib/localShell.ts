import * as localShellCore from "./localShell.cjs";

export type LocalShellType = "posix" | "fish" | "powershell" | "cmd" | "unknown";
export type LocalOs = "linux" | "macos" | "windows";

type LocalShellCore = {
  detectLocalOs: (platformLike?: string) => LocalOs;
  classifyLocalShellType: (
    shellPath: string | undefined,
    platformLike?: string,
  ) => LocalShellType;
};

const core = localShellCore as unknown as LocalShellCore;

export const detectLocalOs = core.detectLocalOs;

export const classifyLocalShellType = core.classifyLocalShellType;
