/** Launch metadata shared by local hosts and terminal sessions. */
export type WslLocalShell = {
  id?: string;
  protocol?: string;
  localShell?: string;
  localShellArgs?: string[];
  localShellName?: string;
};

export function getWslDistributionName(shell: WslLocalShell): string | null {
  const args = shell.localShellArgs ?? [];
  const distroIndex = args.indexOf("-d");
  const fromArgs = distroIndex >= 0 ? args[distroIndex + 1]?.trim() : undefined;
  const fromName = shell.localShellName?.match(/^(.+) \(WSL\)$/i)?.[1].trim();
  const name = fromArgs || fromName;
  // A distro is a single UNC share name. Never derive one from a lossy slug.
  return name && !/[\\/]/.test(name) && name !== "." && name !== ".." ? name : null;
}

export function isWslLocalShell(shell?: WslLocalShell | null): boolean {
  if (!shell || shell.protocol !== "local") return false;
  const command = shell.localShell?.split(/[\\/]/).pop() ?? "";
  const args = shell.localShellArgs ?? [];
  const distroIndex = args.indexOf("-d");
  return Boolean(
    shell.id?.startsWith("wsl-")
    || shell.localShell?.startsWith("wsl-")
    || /^wsl(?:\.exe)?$/i.test(command)
    || (distroIndex >= 0 && args[distroIndex + 1]?.trim()),
  );
}

/** Translate only WSL's default drive mounts and Linux absolute paths. */
export function resolveWslLinuxCwdForLocalWindowsSftp(
  cwd: string,
  distroName?: string | null,
): string | null {
  if (!cwd.trim()) return null;
  if (/^[A-Za-z]:[\\/]/.test(cwd) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(cwd)) {
    return cwd.replace(/\//g, "\\");
  }
  const driveMount = cwd.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (driveMount) {
    return `${driveMount[1].toUpperCase()}:\\${(driveMount[2] ?? "").replace(/\//g, "\\")}`;
  }
  if (!distroName || !cwd.startsWith("/")) return null;
  const root = `\\\\wsl.localhost\\${distroName}`;
  return cwd === "/" ? root : `${root}${cwd.replace(/\//g, "\\")}`;
}

/** Undefined leaves ordinary local panes on their existing Windows home path. */
export function resolveWslLocalSftpInitialPath(
  shell: WslLocalShell,
  cwd: string | null | undefined,
  isWindows: boolean,
): string | undefined {
  if (!isWindows || !isWslLocalShell(shell)) return undefined;
  const distroName = getWslDistributionName(shell);
  return resolveWslLinuxCwdForLocalWindowsSftp(cwd ?? "", distroName)
    ?? resolveWslLinuxCwdForLocalWindowsSftp("/", distroName)
    ?? undefined;
}
