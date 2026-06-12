import type { SftpPane } from "../../application/state/sftp/types";

export type SftpTabDuplicateMode = "defaultPath" | "currentPath";

export type SftpTabDuplicateRequest =
  | { kind: "local"; path?: string }
  | { kind: "remote"; hostId: string; path?: string };

export function getSftpTabDuplicateRequest(
  pane: Pick<SftpPane, "connection"> | null | undefined,
  mode: SftpTabDuplicateMode,
): SftpTabDuplicateRequest | null {
  const connection = pane?.connection;
  if (!connection || connection.status !== "connected") {
    return null;
  }

  const path = mode === "currentPath" && connection.currentPath
    ? { path: connection.currentPath }
    : {};

  if (connection.isLocal) {
    return {
      kind: "local",
      ...path,
    };
  }

  if (!connection.hostId) {
    return null;
  }

  return {
    kind: "remote",
    hostId: connection.hostId,
    ...path,
  };
}
