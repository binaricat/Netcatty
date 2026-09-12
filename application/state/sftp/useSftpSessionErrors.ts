import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { Host } from "../../../domain/models";
import type { SftpPane } from "./types";

interface UseSftpSessionErrorsParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  leftTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  rightTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  updateActiveTab: (
    side: "left" | "right",
    updater: (prev: SftpPane) => SftpPane,
  ) => void;
  navSeqRef: MutableRefObject<{ left: number; right: number }>;
  lastConnectedHostRef: MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  releaseConnection: (connectionId: string) => Promise<void>;
}

/**
 * Whether we still know enough to reconnect after a session drop.
 * Prefer reconnect over wiping the pane to the empty "select host" screen —
 * that wipe was especially easy to hit when listing "/" failed/timed out on
 * some hosts while the file list was empty or lastHost had raced away.
 */
export function canReconnectSftpPane(params: {
  lastHost: Host | "local" | null;
  connection: SftpPane["connection"];
}): boolean {
  const { lastHost, connection } = params;
  if (lastHost && lastHost !== "local") return true;
  if (lastHost === "local") return true;
  if (connection && !connection.isLocal && !!connection.hostId) return true;
  if (connection?.isLocal) return true;
  return false;
}

export const useSftpSessionErrors = ({
  getActivePane,
  leftTabsRef,
  rightTabsRef,
  updateActiveTab,
  navSeqRef,
  lastConnectedHostRef,
  releaseConnection,
}: UseSftpSessionErrorsParams) =>
  useCallback(
    (side: "left" | "right", _error: Error) => {
      const pane = getActivePane(side);
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;

      if (!pane || !sideTabs.activeTabId) return;

      if (pane.connection) {
        void releaseConnection(pane.connection.id);
      }

      navSeqRef.current[side] += 1;

      const lastHost = lastConnectedHostRef.current[side];
      const canReconnect = canReconnectSftpPane({
        lastHost,
        connection: pane.connection,
      });

      if (canReconnect) {
        // Keep the connection object (host identity + path) so the UI does not
        // collapse into the empty host picker when listing root (or any path)
        // fails with a transient session error on some servers.
        updateActiveTab(side, (prev) => ({
          ...prev,
          reconnecting: true,
          loading: false,
          error: "sftp.error.connectionLostReconnecting",
        }));
        return;
      }

      // No host identity left — fall back to empty picker.
      updateActiveTab(side, (prev) => ({
        ...prev,
        connection: null,
        files: [],
        loading: false,
        reconnecting: false,
        error: "sftp.error.sessionLost",
        selectedFiles: new Set(),
        filter: "",
      }));
    },
    [
      getActivePane,
      leftTabsRef,
      rightTabsRef,
      updateActiveTab,
      navSeqRef,
      lastConnectedHostRef,
      releaseConnection,
    ],
  );
