export interface SftpRememberedLocation {
  hostId: string;
  path: string;
}

/**
 * Decides which directory a terminal-opened SFTP panel should land on.
 *
 * The first time SFTP is opened for a terminal there is no remembered location,
 * so it lands on the terminal's current working directory. Re-opening the same
 * terminal restores the last directory the user browsed to in that terminal's
 * SFTP panel — otherwise it would snap back to the terminal CWD, which never
 * moves while the user only navigates inside SFTP.
 *
 * The remembered location only applies when it belongs to the host being opened;
 * switching to a different host falls back to the terminal CWD.
 */
export function resolveSftpOpenLocation(params: {
  hostId: string;
  terminalCwd?: string;
  remembered?: SftpRememberedLocation | null;
}): string | undefined {
  const { hostId, terminalCwd, remembered } = params;

  if (remembered && remembered.hostId === hostId && remembered.path) {
    return remembered.path;
  }

  return terminalCwd && terminalCwd.length > 0 ? terminalCwd : undefined;
}
