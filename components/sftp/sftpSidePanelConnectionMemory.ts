export const MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS = 32;

export function canApplySftpSidePanelInitialLocation(params: {
  activeHostId: string;
  initialLocation: { hostId: string; path: string };
  expectedConnectionKey: string;
  actualConnectionKey: string | null;
  pendingRequiresExactTarget: boolean;
  pendingTargetConnectionId: string | null;
  connection: {
    id: string;
    hostId: string;
    isLocal: boolean;
    status: string;
  } | null | undefined;
}): boolean {
  const { connection } = params;
  if (!params.initialLocation.path) return false;
  if (params.initialLocation.hostId !== params.activeHostId) return false;
  if (!connection || connection.isLocal || connection.status !== "connected") return false;
  if (connection.hostId !== params.activeHostId) return false;
  if (params.actualConnectionKey !== params.expectedConnectionKey) return false;
  if (
    params.pendingRequiresExactTarget
    && (
      !params.pendingTargetConnectionId
      || connection.id !== params.pendingTargetConnectionId
    )
  ) return false;
  return true;
}

export function pruneSftpSidePanelState<Value>(
  valuesById: Map<string, Value>,
  activeIdsInput: Iterable<string>,
): void {
  const activeIds = new Set(activeIdsInput);
  for (const id of valuesById.keys()) {
    if (!activeIds.has(id)) {
      valuesById.delete(id);
    }
  }
}

export function rememberSftpSidePanelPath(
  paths: Map<string, string>,
  connectionKey: string,
  remotePath: string,
  limit = MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS,
): void {
  paths.delete(connectionKey);
  paths.set(connectionKey, remotePath);
  while (paths.size > limit) {
    const oldestKey = paths.keys().next().value;
    if (oldestKey === undefined) break;
    paths.delete(oldestKey);
  }
}

export function recallSftpSidePanelPath(
  paths: Map<string, string>,
  connectionKey: string,
): string | undefined {
  const remotePath = paths.get(connectionKey);
  if (remotePath === undefined) return undefined;
  paths.delete(connectionKey);
  paths.set(connectionKey, remotePath);
  return remotePath;
}
