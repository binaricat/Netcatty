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

/** Skip auto-connect only when the active tab is already bound to this endpoint and healthy. */
export function shouldSkipSftpSidePanelAutoConnect(
  connectionKey: string,
  connectedKey: string | null,
  activeTab: SftpSidePanelTabHealth | null | undefined,
  hasBackendSession: boolean,
): boolean {
  if (connectedKey !== connectionKey) return false;
  if (!activeTab) return false;
  return isRemoteSftpTabHealthy(activeTab, hasBackendSession);
}

export function findReusableSftpSidePanelTab(
  tabs: SftpPane[],
  hostId: string,
  connectionKey: string,
  tabConnectionKeyMap: ReadonlyMap<string, string>,
  hasBackendSession: (connectionId: string) => boolean,
): SftpPane | null {
  const candidate = tabs.find((tab) => {
    if (!tab.connection || tab.connection.hostId !== hostId) return false;
    if (tab.connection.status === "error" || tab.connection.status === "disconnected") return false;
    return tabConnectionKeyMap.get(tab.id) === connectionKey;
  });
  if (!candidate?.connection) return null;
  if (!isRemoteSftpTabHealthy(candidate, hasBackendSession(candidate.connection.id))) {
    return null;
  }
  return candidate;
}

/** True when the linked terminal SSH session changed and SFTP must rebind. */
export function shouldResetSftpSidePanelSourceSession(
  previousSessionId: string | null | undefined,
  nextSessionId: string | null | undefined,
): boolean {
  if (!nextSessionId) return false;
  if (!previousSessionId) return false;
  return nextSessionId !== previousSessionId;
}
