export type SftpFollowTerminalCwdBlock = {
  connectionId: string;
  terminalCwd: string;
};

export type SftpFollowTerminalCwdContext = {
  followEnabled: boolean;
  isVisible: boolean;
  terminalCwd?: string | null;
  currentPath?: string | null;
  connectionId?: string | null;
  hasActiveWork: boolean;
  isConnected: boolean;
  /** Skip auto-follow while this terminal cwd cannot be reached on SFTP. */
  blockedFollow?: SftpFollowTerminalCwdBlock | null;
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
  pendingFollowOverride?: boolean,
): T | null => {
  if (!displayHost) return latestHost ?? null;
  if (!latestHost || latestHost.id !== displayHost.id) return displayHost;

  return {
    ...latestHost,
    ...displayHost,
    sftpFollowTerminalCwd:
      latestHost.sftpFollowTerminalCwd !== undefined
        ? latestHost.sftpFollowTerminalCwd
        : pendingFollowOverride,
  };
};

/** Clear a follow block once the user reaches the blocked cwd through any navigation. */
export const shouldClearBlockedFollowOnReach = (
  blockedFollow: SftpFollowTerminalCwdBlock | null | undefined,
  connectionId: string | null | undefined,
  currentPath: string | null | undefined,
  loading: boolean,
): boolean => {
  if (loading || !blockedFollow || !connectionId || !currentPath) return false;
  return (
    blockedFollow.connectionId === connectionId
    && blockedFollow.terminalCwd === currentPath
  );
};

/** Whether SFTP should auto-navigate to match the linked terminal cwd. */
export const shouldFollowTerminalCwdNavigate = ({
  followEnabled,
  isVisible,
  terminalCwd,
  currentPath,
  connectionId,
  hasActiveWork,
  isConnected,
  blockedFollow,
}: SftpFollowTerminalCwdContext): boolean => {
  if (!followEnabled || !isVisible || !isConnected) return false;
  if (hasActiveWork) return false;
  if (!terminalCwd || terminalCwd.trim().length === 0) return false;
  if (
    blockedFollow
    && connectionId
    && blockedFollow.connectionId === connectionId
    && blockedFollow.terminalCwd === terminalCwd
  ) {
    return false;
  }
  if (!currentPath || currentPath === terminalCwd) return false;
  return true;
};
