import type { Host } from "../../../domain/models";
import type { MutableRefObject } from "react";
import { isSessionError } from "./errors";
import type { SftpPane } from "./types";

export interface EnsureRemoteSftpSessionParams {
  side: "left" | "right";
  getActivePane: (side: "left" | "right") => SftpPane | null;
  sftpSessionsRef: MutableRefObject<Map<string, string>>;
  lastConnectedHostRef: MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  connect: (
    side: "left" | "right",
    host: Host | "local",
    options?: { initialPath?: string; ignoreSharedCache?: boolean; tabId?: string },
  ) => Promise<void>;
  /** Resolve vault host by id when lastConnectedHostRef is missing (tab race). */
  resolveHostById?: (hostId: string) => Host | null | undefined;
  probeSession?: (sftpId: string) => Promise<boolean>;
  forceReconnect?: boolean;
  /** Stable tab identity — reconnect replaces connection ids, not tab ids. */
  tabId?: string;
}

/**
 * Return a live remote SFTP session id for the active pane, reconnecting the
 * host when the mapping is missing or the backend session is gone.
 */
export async function ensureRemoteSftpSession(
  params: EnsureRemoteSftpSessionParams,
): Promise<string> {
  const {
    side,
    getActivePane,
    sftpSessionsRef,
    lastConnectedHostRef,
    connect,
    resolveHostById,
    probeSession,
    forceReconnect = false,
    tabId,
  } = params;

  const resolveHost = (): Host => {
    const pane = getActivePane(side);
    const lastHost = lastConnectedHostRef.current[side];
    if (lastHost && lastHost !== "local") return lastHost;
    const hostId = pane?.connection && !pane.connection.isLocal ? pane.connection.hostId : undefined;
    if (hostId && resolveHostById) {
      const fromVault = resolveHostById(hostId);
      if (fromVault) return fromVault;
    }
    // Pane connection only stores hostId/label — inventing root@label:22 would
    // open the wrong endpoint. Fail clearly so the caller can reconnect via
    // vault host metadata instead of a synthetic identity.
    if (pane?.connection && !pane.connection.isLocal) {
      throw new Error(
        `Cannot reconnect SFTP for "${pane.connection.hostLabel}": host credentials are unavailable. Reopen the host from the vault.`,
      );
    }
    throw new Error("No remote host available to reconnect");
  };

  const readMappedId = (): string | undefined => {
    const pane = getActivePane(side);
    if (!pane?.connection || pane.connection.isLocal) {
      throw new Error("No remote SFTP connection on this pane");
    }
    return sftpSessionsRef.current.get(pane.connection.id);
  };

  if (!forceReconnect) {
    const existing = readMappedId();
    if (existing) {
      if (!probeSession) return existing;
      try {
        const ok = await probeSession(existing);
        if (ok) return existing;
      } catch (error) {
        if (!isSessionError(error)) throw error;
      }
      const pane = getActivePane(side);
      if (pane?.connection) sftpSessionsRef.current.delete(pane.connection.id);
    }
  } else {
    const pane = getActivePane(side);
    if (pane?.connection) sftpSessionsRef.current.delete(pane.connection.id);
  }

  const paneBefore = getActivePane(side);
  const resumePath = paneBefore?.connection?.currentPath;
  const host = resolveHost();
  await connect(side, host, {
    initialPath: resumePath,
    ignoreSharedCache: true,
    ...(tabId ? { tabId } : {}),
  });

  const sftpId = readMappedId();
  if (!sftpId) {
    throw new Error("SFTP session not found after reconnect");
  }
  return sftpId;
}
