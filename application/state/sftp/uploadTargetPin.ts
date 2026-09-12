import type { SftpPane } from "./types";

export type UploadEndpointPin = {
  isLocal: boolean;
  hostId: string | null;
  cacheKey: string | null;
  /** When present, reconnecting the same tab is still a target change. */
  connectionId?: string;
};

export function captureUploadEndpoint(
  connection: NonNullable<SftpPane["connection"]>,
  connectionCacheKeyMap: Map<string, string>,
  options?: { pinConnectionId?: boolean },
): UploadEndpointPin {
  return {
    isLocal: connection.isLocal,
    hostId: connection.isLocal ? null : (connection.hostId ?? null),
    cacheKey: connection.isLocal
      ? "local"
      : (connectionCacheKeyMap.get(connection.id) ?? null),
    ...(options?.pinConnectionId ? { connectionId: connection.id } : undefined),
  };
}

export function assertUploadEndpointUnchanged(
  connection: NonNullable<SftpPane["connection"]>,
  expected: UploadEndpointPin,
  connectionCacheKeyMap: Map<string, string>,
): void {
  if (expected.connectionId && connection.id !== expected.connectionId) {
    throw new Error("Upload target changed before the transfer started");
  }
  if (connection.isLocal !== expected.isLocal) {
    throw new Error("Upload target changed before the transfer started");
  }
  if (connection.isLocal) return;
  if ((connection.hostId ?? null) !== expected.hostId) {
    throw new Error("Upload target changed before the transfer started");
  }
  if (expected.cacheKey) {
    const liveKey = connectionCacheKeyMap.get(connection.id) ?? null;
    // Same-host reconnect re-stamps the key; a different endpoint must stop.
    if (liveKey && liveKey !== expected.cacheKey) {
      throw new Error("Upload target changed before the transfer started");
    }
  }
}

/**
 * Resolve the pane that should receive an external upload.
 * Prefer stable tabId (survives reconnect) over connectionId, then active pane.
 */
export function resolveUploadTargetPane(params: {
  side: "left" | "right";
  tabId?: string;
  connectionId?: string;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  getPaneByTabId: (tabId: string) => SftpPane | null;
  getPaneByConnectionId: (connectionId: string) => SftpPane | null;
}): SftpPane {
  const {
    side,
    tabId,
    connectionId,
    getActivePane,
    getPaneByTabId,
    getPaneByConnectionId,
  } = params;

  if (tabId) {
    const pane = getPaneByTabId(tabId);
    if (!pane?.connection) {
      throw new Error("Upload target connection is no longer available");
    }
    return pane;
  }

  if (connectionId) {
    const pane = getPaneByConnectionId(connectionId);
    if (!pane?.connection) {
      throw new Error("Upload target connection is no longer available");
    }
    return pane;
  }

  const pane = getActivePane(side);
  if (!pane?.connection) {
    throw new Error("No active connection");
  }
  return pane;
}
