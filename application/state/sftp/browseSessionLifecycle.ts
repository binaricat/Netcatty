/**
 * Browse vs transfer session lifecycle helpers.
 *
 * FileZilla model: the interactive browser can soft-close its SFTP channels
 * while bulk transfers keep dedicated pool connections (and any leased browse
 * sessions held by in-flight streams).
 */

export function isBrowseSessionInteractive(params: {
  surfaceVisible: boolean;
  hasOwnedEditorTab: boolean;
  /** External editor temp files (Notepad++ etc.) still need the browse session. */
  hasActiveExternalEdit?: boolean;
}): boolean {
  return params.surfaceVisible
    || params.hasOwnedEditorTab
    || !!params.hasActiveExternalEdit;
}

export function listRemoteBrowseConnectionIds(
  tabs: ReadonlyArray<{
    connection: { id: string; isLocal: boolean } | null;
  }>,
): string[] {
  const ids = new Set<string>();
  for (const tab of tabs) {
    const connection = tab.connection;
    if (!connection || connection.isLocal) continue;
    ids.add(connection.id);
  }
  return [...ids];
}

/** Stable SFTP pane tab ids for editor ownership across browse reconnects. */
export function listRemoteBrowseSftpTabIds(
  tabs: ReadonlyArray<{
    id: string;
    connection: { id: string; isLocal: boolean } | null;
  }>,
): string[] {
  const ids = new Set<string>();
  for (const tab of tabs) {
    const connection = tab.connection;
    if (!connection || connection.isLocal) continue;
    ids.add(tab.id);
  }
  return [...ids];
}

export function shouldParkBrowseSessions(params: {
  interactive: boolean;
  /** True after we already soft-closed browse while the owner stayed mounted. */
  browseParked: boolean;
  /** Defer park while unfinished transfers may still use browse sessions pre-lease. */
  activeTransfersCount?: number;
  /**
   * Defer park while an external editor still holds a downloaded temp file.
   * Parking calls closeSftp, which deletes those temps and breaks save/sync.
   */
  activeExternalEditCount?: number;
}): boolean {
  if (params.activeTransfersCount && params.activeTransfersCount > 0) return false;
  if (params.activeExternalEditCount && params.activeExternalEditCount > 0) return false;
  return !params.interactive && !params.browseParked;
}

export function shouldRestoreBrowseSessions(params: {
  interactive: boolean;
  browseParked: boolean;
}): boolean {
  return params.interactive && params.browseParked;
}

export interface BrowseSessionEntry {
  connectionId: string;
  sftpId: string;
}

/** Snapshot + clear the connectionId→sftpId map used by the file browser. */
export function takeBrowseSessionsForClose(
  sessions: Map<string, string>,
): BrowseSessionEntry[] {
  const entries = [...sessions.entries()].map(([connectionId, sftpId]) => ({
    connectionId,
    sftpId,
  }));
  sessions.clear();
  return entries;
}

export function listRemoteConnectionIdsForRestore(params: {
  leftTabs: ReadonlyArray<{ connection: { id: string; isLocal: boolean } | null }>;
  rightTabs: ReadonlyArray<{ connection: { id: string; isLocal: boolean } | null }>;
  liveSessionConnectionIds: ReadonlySet<string>;
}): string[] {
  const ids = new Set<string>();
  for (const tab of [...params.leftTabs, ...params.rightTabs]) {
    const connection = tab.connection;
    if (!connection || connection.isLocal) continue;
    if (params.liveSessionConnectionIds.has(connection.id)) continue;
    ids.add(connection.id);
  }
  return [...ids];
}
