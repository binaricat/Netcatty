export type SftpFollowTerminalCwdContext = {
  followEnabled: boolean;
  isVisible: boolean;
  terminalCwd?: string | null;
  currentPath?: string | null;
  hasActiveWork: boolean;
  isConnected: boolean;
};

export const resolveHostFollowTerminalCwd = (
  hostFollowTerminalCwd: boolean | undefined,
  globalFollowTerminalCwd: boolean,
): boolean => hostFollowTerminalCwd ?? globalFollowTerminalCwd;

export const resolveSftpFollowTerminalCwdTargetHost = <T>(
  visibleHost: T | null | undefined,
  fallbackHost: T | null | undefined,
): T | null => visibleHost ?? fallbackHost ?? null;

export const mergeLatestFollowTerminalCwdHostSetting = <
  T extends { id?: string; sftpFollowTerminalCwd?: boolean },
>(
  displayHost: T | null | undefined,
  latestHost: T | null | undefined,
): T | null => {
  if (!displayHost) return latestHost ?? null;
  if (!latestHost || latestHost.id !== displayHost.id) return displayHost;

  return {
    ...latestHost,
    ...displayHost,
    sftpFollowTerminalCwd: latestHost.sftpFollowTerminalCwd,
  };
};

/** Whether SFTP should auto-navigate to match the linked terminal cwd. */
export const shouldFollowTerminalCwdNavigate = ({
  followEnabled,
  isVisible,
  terminalCwd,
  currentPath,
  hasActiveWork,
  isConnected,
}: SftpFollowTerminalCwdContext): boolean => {
  if (!followEnabled || !isVisible || !isConnected) return false;
  if (hasActiveWork) return false;
  if (!terminalCwd || terminalCwd.trim().length === 0) return false;
  if (!currentPath || currentPath === terminalCwd) return false;
  return true;
};
