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
  /** Skip auto-follow after this terminal cwd was already handled for the connection. */
  handledFollow?: SftpFollowTerminalCwdBlock | null;
};

export type SftpFollowTerminalCwdSyncResultContext = {
  syncGeneration: number;
  currentGeneration: number;
  followEnabled: boolean;
  canFollow: boolean;
  expectedConnectionId?: string | null;
  liveConnectionId?: string | null;
  paneConnectionId?: string | null;
  expectedTerminalCwd?: string | null;
  liveTerminalCwd?: string | null;
  requireLiveTerminalCwd?: boolean;
};

type InitialFollowConnection = {
  id: string;
  currentPath?: string | null;
  status: string;
  isLocal?: boolean;
};

type InitialFollowSyncOptions = {
  expectedConnectionId: string;
  staleTerminalCwd?: string | null;
  getFreshTerminalCwd: () => Promise<string | null | undefined>;
  isEligible: () => boolean;
  getConnection: () => InitialFollowConnection | null | undefined;
  navigate: (
    cwd: string,
    shouldApply: () => boolean,
  ) => Promise<"reached" | "failed" | "aborted" | "superseded">;
  setHandled: (value: SftpFollowTerminalCwdBlock) => void;
  setBlocked: (value: SftpFollowTerminalCwdBlock | null) => void;
};

/** Run one guarded first-open sync. False means the caller may retry. */
export const runInitialFollowTerminalCwdSync = async ({
  expectedConnectionId,
  staleTerminalCwd,
  getFreshTerminalCwd,
  isEligible,
  getConnection,
  navigate,
  setHandled,
  setBlocked,
}: InitialFollowSyncOptions): Promise<boolean> => {
  const cwd = await getFreshTerminalCwd();
  if (!cwd || !isEligible()) return false;

  const live = getConnection();
  if (!live || live.id !== expectedConnectionId || live.status !== "connected" || live.isLocal) {
    return false;
  }

  setHandled({
    connectionId: expectedConnectionId,
    terminalCwd: staleTerminalCwd && staleTerminalCwd !== cwd ? staleTerminalCwd : cwd,
  });
  if (live.currentPath === cwd) return true;

  const navigateResult = await navigate(cwd, isEligible);
  if (!isEligible()) return false;
  const current = getConnection();
  if (!current || current.id !== expectedConnectionId || current.status !== "connected") {
    return false;
  }
  if (navigateResult === "failed") {
    setBlocked({ connectionId: expectedConnectionId, terminalCwd: cwd });
    return true;
  }
  if (navigateResult === "reached") {
    setBlocked(null);
    return true;
  }
  return navigateResult === "superseded";
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

/** Whether an async follow result still belongs to the current terminal/connection state. */
export const shouldApplyFollowTerminalCwdSyncResult = ({
  syncGeneration,
  currentGeneration,
  followEnabled,
  canFollow,
  expectedConnectionId,
  liveConnectionId,
  paneConnectionId,
  expectedTerminalCwd,
  liveTerminalCwd,
  requireLiveTerminalCwd = false,
}: SftpFollowTerminalCwdSyncResultContext): boolean => {
  if (syncGeneration !== currentGeneration || !followEnabled || !canFollow) {
    return false;
  }
  if (expectedConnectionId !== undefined) {
    if (!expectedConnectionId) return false;
    if (liveConnectionId !== undefined && liveConnectionId !== expectedConnectionId) return false;
    if (paneConnectionId !== undefined && paneConnectionId !== expectedConnectionId) return false;
  }
  if (expectedTerminalCwd !== undefined) {
    if (requireLiveTerminalCwd && !liveTerminalCwd) return false;
    if (liveTerminalCwd && liveTerminalCwd !== expectedTerminalCwd) return false;
  }
  return true;
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
  handledFollow,
}: SftpFollowTerminalCwdContext): boolean => {
  if (!followEnabled || !isVisible || !isConnected) return false;
  if (hasActiveWork) return false;
  if (!terminalCwd || terminalCwd.trim().length === 0) return false;
  if (
    handledFollow
    && connectionId
    && handledFollow.connectionId === connectionId
    && handledFollow.terminalCwd === terminalCwd
  ) {
    return false;
  }
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
