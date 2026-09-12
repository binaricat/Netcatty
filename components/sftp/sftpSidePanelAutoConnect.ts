import type { SftpPane } from "../../application/state/sftp/types";

export type SftpSidePanelTabHealth = Pick<SftpPane, "connection" | "loading" | "reconnecting">;

/** Whether a remote SFTP tab is safe to reuse without reconnecting. */
export function isRemoteSftpTabHealthy(
  tab: SftpSidePanelTabHealth,
  hasBackendSession: boolean,
): boolean {
  const conn = tab.connection;
  if (!conn || conn.isLocal) return true;
  if (conn.status !== "connected") return false;
  if (tab.loading || tab.reconnecting) return false;
  if (!hasBackendSession) return false;
  return true;
}

/**
 * Skip auto-connect only when the active tab is already bound to this endpoint
 * and healthy. `activeTabConnectionKey` must match so a manually selected tab
 * for a different host cannot be kept just because `connectedKey` is stale.
 */
export function shouldSkipSftpSidePanelAutoConnect(
  connectionKey: string,
  connectedKey: string | null,
  activeTab: SftpSidePanelTabHealth | null | undefined,
  hasBackendSession: boolean,
  activeTabConnectionKey?: string | null,
): boolean {
  if (connectedKey !== connectionKey) return false;
  if (!activeTab) return false;
  if (activeTabConnectionKey !== connectionKey) return false;
  return isRemoteSftpTabHealthy(activeTab, hasBackendSession);
}

export function isPendingSameEndpointSshSession(
  session: {
    hostId?: string | null;
    status?: string;
    hostname?: string | null;
    port?: number | null;
    username?: string | null;
    protocol?: string | null;
    moshEnabled?: boolean;
    etEnabled?: boolean;
  },
  host: {
    id: string;
    hostname: string;
    port?: number | null;
    username: string;
  },
): boolean {
  return Boolean(
    session.hostId === host.id
    && session.status === "connecting"
    && session.hostname === host.hostname
    && (session.port ?? 22) === (host.port ?? 22)
    && session.username === host.username
    && (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled,
  );
}

/** Whether a stored endpoint key still belongs to the live connection's host. */
export function connectionKeyMatchesHost(
  connectionKey: string | null | undefined,
  hostId: string,
): boolean {
  if (!connectionKey) return false;
  return connectionKey === hostId || connectionKey.startsWith(`${hostId}:`);
}

/**
 * Accept a terminal-drop pending upload only when the active pane is already
 * connected to the exact endpoint the drop requested. Matching hostId alone is
 * unsafe: session overrides can share hostId while hostname/port/user differ,
 * and auto-connect may still be deferred via rAF while the previous endpoint
 * looks connected.
 */
export function shouldAcceptPendingSftpUpload(params: {
  ownerPanelOpen: boolean;
  pendingHostId: string;
  pendingConnectionKey: string;
  pendingSourceSessionId?: string;
  activeHostId: string | null | undefined;
  connection: {
    hostId?: string | null;
    isLocal?: boolean;
    status?: string;
    sourceSessionId?: string;
  } | null | undefined;
  paneConnectionKey: string | null | undefined;
}): boolean {
  const {
    ownerPanelOpen,
    pendingHostId,
    pendingConnectionKey,
    pendingSourceSessionId,
    activeHostId,
    connection,
    paneConnectionKey,
  } = params;
  if (!ownerPanelOpen) return false;
  if (!activeHostId || pendingHostId !== activeHostId) return false;
  if (!connection || connection.isLocal || connection.hostId !== activeHostId) return false;
  if (connection.status !== "connected") return false;
  if (!paneConnectionKey || paneConnectionKey !== pendingConnectionKey) return false;
  if (pendingSourceSessionId && connection.sourceSessionId !== pendingSourceSessionId) return false;
  return true;
}

/** Wait until the drop's origin pane is focused before binding SFTP. */
export function shouldDeferPendingSftpUploadForOriginFocus(params: {
  originSessionId?: string;
  focusedSessionId?: string | null;
}): boolean {
  if (!params.originSessionId || !params.focusedSessionId) return false;
  return params.focusedSessionId !== params.originSessionId;
}

export type PendingSftpUploadCancellationReason = "source-changed" | "connection-failed";

/** Old-pane failures are ignored until a strict replacement has finished binding. */
export function shouldCancelPendingSftpUpload(
  reason: PendingSftpUploadCancellationReason | null,
  waitingForStrictRebind: boolean,
): boolean {
  if (reason === "source-changed") return true;
  return reason === "connection-failed" && !waitingForStrictRebind;
}

/** Return a terminal-drop cancellation only for terminal or connection changes that cannot recover. */
export function resolvePendingSftpUploadCancellation(params: {
  pendingHostId: string;
  pendingOriginSessionId?: string;
  pendingSourceSessionId?: string;
  /**
   * Status of the origin terminal session while the drop is pending: the
   * session's live status, `null` once it no longer exists, or `undefined`
   * when the caller does not track it.
   */
  originSessionStatus?: string | null;
  activeHostId: string | null | undefined;
  activeSessionId: string | null | undefined;
  focusedSessionId?: string | null;
  panelVisible?: boolean;
  /**
   * True while this drop's own focus switch has not landed yet. A live focus
   * still sitting on another same-host session is then lag, not a user leave.
   */
  waitingForOriginFocus?: boolean;
  /**
   * True while the drop's originating SSH session has not yet become the
   * panel's active session. Distinguishes scheduled rebind from a real switch.
   */
  waitingForSourceSession?: boolean;
  connection: {
    hostId?: string | null;
    sourceSessionId?: string;
    status?: string;
  } | null | undefined;
}): PendingSftpUploadCancellationReason | null {
  if (params.activeHostId !== params.pendingHostId) return "source-changed";
  if (
    params.panelVisible
    && params.pendingOriginSessionId
    && params.focusedSessionId
    && params.focusedSessionId !== params.pendingOriginSessionId
    && !params.waitingForOriginFocus
  ) return "source-changed";
  if (
    params.pendingSourceSessionId
    && params.activeSessionId
    && params.activeSessionId !== params.pendingSourceSessionId
    && !params.waitingForSourceSession
  ) return "source-changed";
  // A Mosh/ET (or local) origin has no reusable SSH source session, so the
  // origin terminal itself is the only evidence of the drop's destination
  // route. If it disconnects or disappears while the standalone SFTP rebind
  // is pending, cancel instead of uploading into a route that is gone. SSH
  // origins are excluded: their same-tab reconnect rebind is expected to
  // pass through non-connected statuses.
  if (params.pendingOriginSessionId && !params.pendingSourceSessionId) {
    if (
      params.originSessionStatus === null
      || params.originSessionStatus === "disconnected"
    ) return "source-changed";
  }
  if (
    params.connection?.hostId === params.pendingHostId
    && (!params.pendingSourceSessionId
      || params.connection.sourceSessionId === params.pendingSourceSessionId)
    && (params.connection.status === "error" || params.connection.status === "disconnected")
  ) return "connection-failed";
  return null;
}

/** Block an old SFTP connection while the same terminal tab is replacing its SSH route. */
export function shouldBlockPendingSftpUploadForSourceRebind(params: {
  pendingSourceSessionId?: string;
  previousSessionId?: string | null;
  activeSessionId?: string | null;
  previousStatus?: string | null;
  activeStatus?: string | null;
}): boolean {
  if (!params.pendingSourceSessionId) return false;
  if (params.activeSessionId !== params.pendingSourceSessionId) return false;
  return shouldRebindSftpSidePanelSourceSession({
    previousSessionId: params.previousSessionId,
    nextSessionId: params.activeSessionId,
    previousStatus: params.previousStatus,
    nextStatus: params.activeStatus,
  });
}

export function shouldStartPendingSftpUploadRebind(params: {
  pendingMatchesTarget: boolean;
  requestId: string;
  startedRequestId?: string | null;
  originSessionId?: string;
  sourceSessionId?: string;
}): boolean {
  return Boolean(
    params.pendingMatchesTarget
    && (params.originSessionId || params.sourceSessionId)
    && params.startedRequestId !== params.requestId
  );
}

/** A terminal drop must wait until its forced route rebind has finished. */
export function shouldWaitForPendingSftpRebind(params: {
  pendingRequiresRebind?: boolean;
  pendingSourceSessionId?: string;
  requestId: string;
  startedRequestId?: string | null;
  settledRequestId?: string | null;
  connectionId?: string | null;
  tabId?: string | null;
  barrierRequestId?: string | null;
  previousConnectionId?: string | null;
  targetTabId?: string | null;
  targetConnectionId?: string | null;
}): boolean {
  const pendingRequiresRebind = params.pendingRequiresRebind
    ?? Boolean(params.pendingSourceSessionId);
  if (!pendingRequiresRebind) return false;
  if (params.startedRequestId !== params.requestId) return true;
  if (params.barrierRequestId !== params.requestId) return true;
  if (params.settledRequestId !== params.requestId) return true;
  if (!params.targetTabId || !params.targetConnectionId) return true;
  return params.tabId !== params.targetTabId
    || params.connectionId !== params.targetConnectionId;
}

/** A completed forced connect cannot recover after its exact target was closed. */
export function shouldCancelSettledPendingSftpRebindWithoutTarget(params: {
  pendingRequiresRebind: boolean;
  requestId: string;
  startedRequestId?: string | null;
  settledRequestId?: string | null;
  barrierRequestId?: string | null;
  targetTabId?: string | null;
  targetConnectionId?: string | null;
  targetExists: boolean;
}): boolean {
  return Boolean(
    params.pendingRequiresRebind
    && params.startedRequestId === params.requestId
    && params.settledRequestId === params.requestId
    && params.barrierRequestId === params.requestId
    && (
      !params.targetTabId
      || !params.targetConnectionId
      || !params.targetExists
    )
  );
}

/** Locate an exact forced-connect target even if its tab moved between panes. */
export function findPendingSftpRebindTargetPane(
  leftTabs: ReadonlyArray<SftpPane>,
  rightTabs: ReadonlyArray<SftpPane>,
  targetTabId?: string | null,
  targetConnectionId?: string | null,
): SftpPane | null {
  if (!targetTabId || !targetConnectionId) return null;
  return [...leftTabs, ...rightTabs].find((pane) => (
    pane.id === targetTabId
    && pane.connection?.id === targetConnectionId
  )) ?? null;
}

export function findReusableSftpSidePanelTab(
  tabs: SftpPane[],
  hostId: string,
  connectionKey: string,
  tabConnectionKeyMap: ReadonlyMap<string, string>,
  hasBackendSession: (connectionId: string) => boolean,
  getConnectionKey?: (connectionId: string) => string | null,
): SftpPane | null {
  const candidate = tabs.find((tab) => {
    if (!tab.connection || tab.connection.hostId !== hostId) return false;
    if (tab.connection.status === "error" || tab.connection.status === "disconnected") return false;
    const liveKey = getConnectionKey?.(tab.connection.id) ?? null;
    const tabKey = liveKey ?? tabConnectionKeyMap.get(tab.id) ?? null;
    return tabKey === connectionKey;
  });
  if (!candidate?.connection) return null;
  if (!isRemoteSftpTabHealthy(candidate, hasBackendSession(candidate.connection.id))) {
    return null;
  }
  return candidate;
}

/** True when the linked terminal SSH session id changed. */
export function shouldResetSftpSidePanelSourceSession(
  previousSessionId: string | null | undefined,
  nextSessionId: string | null | undefined,
): boolean {
  if (!nextSessionId) return false;
  if (!previousSessionId) return false;
  return nextSessionId !== previousSessionId;
}

/**
 * True when the SFTP side panel must rebind onto a fresh SSH transport.
 * Covers focus switches (session id change) and same-tab reconnect /
 * Start over, where the id is stable but the underlying channel was replaced.
 */
export function shouldRebindSftpSidePanelSourceSession(params: {
  previousSessionId: string | null | undefined;
  nextSessionId: string | null | undefined;
  previousStatus?: string | null;
  nextStatus?: string | null;
}): boolean {
  if (shouldResetSftpSidePanelSourceSession(params.previousSessionId, params.nextSessionId)) {
    return true;
  }
  if (!params.nextSessionId) return false;
  if (params.previousSessionId !== params.nextSessionId) return false;
  if (params.nextStatus !== "connected") return false;
  if (params.previousStatus == null) return false;
  return params.previousStatus !== "connected";
}

/**
 * While the linked terminal is actively connecting, wait for its transport so
 * SFTP can reuse it. A terminal left disconnected must not block standalone
 * SFTP fallback.
 */
export function shouldDeferSftpSidePanelAutoConnectForSession(params: {
  activeSessionId?: string | null;
  sessionStatus?: string | null;
}): boolean {
  if (!params.activeSessionId) return false;
  return params.sessionStatus === "connecting";
}

/**
 * While the last linked SSH session is not the active reusable source,
 * remember its non-connected status so a background reconnect still rebinds
 * when that session becomes active again.
 */
export function resolveSftpSidePanelTrackedSourceStatusUpdate(params: {
  trackedSessionId?: string | null;
  sessionStatus?: string | null;
}): { sessionId: string; status: string } | null {
  if (!params.trackedSessionId) return null;
  if (!params.sessionStatus || params.sessionStatus === "connected") return null;
  return {
    sessionId: params.trackedSessionId,
    status: params.sessionStatus,
  };
}

/** Keep the tracked source status when focus temporarily has no reusable SSH. */
export function rememberSftpSidePanelSourceStatus(params: {
  previousStatus?: string | null;
  activeSessionId?: string | null;
  activeSessionStatus?: string | null;
}): string | null {
  if (params.activeSessionId && params.activeSessionStatus) {
    return params.activeSessionStatus;
  }
  return params.previousStatus ?? null;
}
