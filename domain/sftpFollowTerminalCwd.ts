/** Pure state and decision helpers for keeping an SFTP pane aligned with a terminal. */
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
  expectedSessionId?: string | null;
  liveSessionId?: string | null;
  expectedConnectionId?: string | null;
  liveConnectionId?: string | null;
  paneConnectionId?: string | null;
  expectedTerminalCwd?: string | null;
  liveTerminalCwd?: string | null;
  requireLiveTerminalCwd?: boolean;
};

/**
 * Whether a change of the live `activeTerminalCwd` input must invalidate the
 * handled/blocked follow bookkeeping.
 *
 * Hidden surfaces receive `activeTerminalCwd={null}`
 * (terminalLayerSidePanelSlots) and get the live value back when the tab
 * becomes visible again. That visibility-induced `null` is synthetic and must
 * not invalidate: invalidating on it would drop `handledFollowRef` and make
 * the regular follow sync navigate the user's browsed pane back to the
 * terminal cwd (clearing the filename filter) on every terminal-tab switch.
 *
 * While the surface is visible, though, a `null` is a real transition: the
 * linked terminal session moved to (or closed on) a session whose cwd cache is
 * empty. Passing it through would leave the generation valid, and the
 * first-open eligibility checks do not bind to the terminal session identity,
 * so an in-flight probe of the previous session could navigate the visible
 * pane. Any live value change while visible invalidates — including to `null`.
 */
export const shouldInvalidateFollowBookkeepingOnCwdChange = ({
  nextCwd,
  lastCwd,
  isVisible,
}: {
  nextCwd: string | null;
  lastCwd: string | null;
  isVisible: boolean;
}): boolean => {
  if (nextCwd === lastCwd) return false;
  // Only the hidden synthetic `null` pass-through is ignored; a caller that
  // still forwards live values while hidden keeps the concrete-change rule.
  if (!isVisible) return nextCwd !== null;
  return true;
};

/**
 * Whether the one-shot "first open" terminal cwd sync must re-arm.
 *
 * Hiding the surface while the owner side panel stays open (switching terminal
 * tabs, or focusing another side-panel tool in the same tab) must NOT re-arm
 * the sync: re-running it would navigate the pane away from the user's browsed
 * directory back to the terminal cwd and clear the filename filter on every
 * switch. A changed terminal cwd is still followed by the regular follow sync
 * through its handled/blocked bookkeeping. The sync re-arms only when the
 * owning panel actually closed (fresh open resyncs, #2335) or the linked
 * connection replaced itself (Start over).
 */
export const shouldResetInitialFollowTerminalCwdSync = ({
  isVisible,
  ownerPanelOpen,
  connectionId,
  trackedConnectionId,
}: {
  isVisible: boolean;
  /** Side panel still open for this terminal tab (another tool/tab may have focus). */
  ownerPanelOpen: boolean;
  connectionId: string | null;
  trackedConnectionId: string | null;
}): boolean => {
  if (connectionId !== trackedConnectionId) return true;
  return !isVisible && !ownerPanelOpen;
};

/**
 * Whether a hide transition with the owning panel still open (terminal-tab
 * switch, or focusing another side-panel tool in the same tab) must latch the
 * pending first-open fresh-CWD probe as interrupted.
 *
 * When the surface is hidden while a probe is still in flight, the probe's
 * eligibility is only re-checked live when it resolves. If the tab becomes
 * visible again before then, the live checks pass again (generation unchanged,
 * visible, no active work) and the stale probe would navigate the pane back to
 * the terminal cwd, clearing the user's browsed directory and filename filter.
 * The hide transition must latch the attempt as interrupted while keeping its
 * one-shot slot consumed (no re-arm on return — see
 * {@link shouldReleaseInitialFollowSyncAttempt}).
 */
export const shouldLatchInitialFollowInterruption = ({
  isVisible,
  ownerPanelOpen,
}: {
  isVisible: boolean;
  ownerPanelOpen: boolean;
}): boolean => !isVisible && ownerPanelOpen;

/**
 * Whether an unfinished one-shot "first open" sync attempt may release its
 * consumed slot so a retry can re-arm.
 *
 * If the fresh-CWD probe resolves while the surface is hidden but the owning
 * panel is still open (terminal-tab switch), the attempt must stay consumed:
 * releasing it would re-run the first-open sync when the tab becomes visible
 * again and navigate the pane away from the directory the user browsed to
 * while the original probe was pending (clearing its filename filter). The
 * attempt is released once the surface is visible again or the owning panel
 * closed (fresh open resyncs, #2335).
 */
export const shouldReleaseInitialFollowSyncAttempt = ({
  isVisible,
  ownerPanelOpen,
}: {
  isVisible: boolean;
  ownerPanelOpen: boolean;
}): boolean => isVisible || !ownerPanelOpen;

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

/**
 * Whether a first-open or in-flight follow still belongs to the terminal that
 * started it. A missing origin id is not a skipped guard: the live focused
 * terminal must stay absent too, otherwise the probe belongs to a later pane.
 */
export const isFollowOriginStillCurrent = ({
  expectedOriginId,
  liveOriginId,
}: {
  expectedOriginId: string | null | undefined;
  liveOriginId?: string | null;
}): boolean => {
  if (liveOriginId === undefined) return true;
  if (expectedOriginId == null) return liveOriginId == null;
  return liveOriginId === expectedOriginId;
};

/** Whether an async follow result still belongs to the current terminal/connection state. */
export const shouldApplyFollowTerminalCwdSyncResult = ({
  syncGeneration,
  currentGeneration,
  followEnabled,
  canFollow,
  expectedSessionId,
  liveSessionId,
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
  if (expectedSessionId !== undefined) {
    if (!isFollowOriginStillCurrent({
      expectedOriginId: expectedSessionId,
      liveOriginId: liveSessionId,
    })) return false;
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
