import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { Host, Identity, KnownHost, SftpConnection, SftpFileEntry, SftpFilenameEncoding, SSHKey } from "../../../domain/models";
import type { SftpHostKeyInfo, SftpHostKeyVerificationState, SftpPane } from "./types";
import { useSftpDirectoryListing } from "./useSftpDirectoryListing";
import { useSftpHostCredentials } from "./useSftpHostCredentials";
import { buildCacheKey, getSharedRemoteHostCache, setSharedRemoteHostCache } from "./sharedRemoteHostCache";
import { resolveRemoteSftpStartState } from "./sftpConnectStartPath";
import { normalizeSftpPaneNavigationPath } from "./utils";
import {
  setDirectoryCacheEntry,
  type DirectoryListingCache,
} from "./directoryListingCache";

interface UseSftpConnectionsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  onAddKnownHost?: (knownHost: KnownHost) => void;
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
  leftTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  rightTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  leftTabs: { tabs: SftpPane[] };
  rightTabs: { tabs: SftpPane[] };
  leftPane: SftpPane;
  rightPane: SftpPane;
  setLeftTabs: React.Dispatch<React.SetStateAction<{ tabs: SftpPane[]; activeTabId: string | null }>>;
  setRightTabs: React.Dispatch<React.SetStateAction<{ tabs: SftpPane[]; activeTabId: string | null }>>;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (prev: SftpPane) => SftpPane) => void;
  navSeqRef: MutableRefObject<{ left: number; right: number }>;
  dirCacheRef: MutableRefObject<DirectoryListingCache>;
  sftpSessionsRef: MutableRefObject<Map<string, string>>;
  lastConnectedHostRef: MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  connectionCacheKeyMapRef: MutableRefObject<Map<string, string>>;
  connectedHostByTabIdRef: MutableRefObject<Map<string, Host | "local">>;
  reconnectingRef: MutableRefObject<{ left: boolean; right: boolean }>;
  makeCacheKey: (connectionId: string, path: string, encoding?: SftpFilenameEncoding) => string;
  clearCacheForConnection: (connectionId: string) => void;
  createEmptyPane: (id?: string, showHiddenFiles?: boolean) => SftpPane;
  autoConnectLocalOnMount?: boolean;
  /** Fired after a browse SFTP id is closed so renderer retainers can drop. */
  onRemoteSessionClosed?: (sftpId: string) => void;
}

export interface SftpConnectOptions {
  forceNewTab?: boolean;
  ignoreSharedCache?: boolean;
  initialPath?: string;
  /** Reconnect this tab instead of whichever tab is currently active on the side. */
  tabId?: string;
  onTabCreated?: (tabId: string) => void;
  sourceSessionId?: string;
}

type SftpOpenBridge = Pick<NetcattyBridge, "openSftp"> &
  Partial<Pick<NetcattyBridge, "openSftpForSession">>;

interface OpenSftpWithSessionPreferenceParams {
  bridge: SftpOpenBridge | null | undefined;
  sourceSessionId?: string;
  openOptions: NetcattySSHOptions;
}

export function takeSftpConnectionMetadataForClose(params: {
  connectionId: string;
  sftpSessions: Map<string, string>;
  connectionCacheKeys: Map<string, string>;
  clearCacheForConnection: (connectionId: string) => void;
}): string | undefined {
  const sftpId = params.sftpSessions.get(params.connectionId);
  params.sftpSessions.delete(params.connectionId);
  params.connectionCacheKeys.delete(params.connectionId);
  params.clearCacheForConnection(params.connectionId);
  return sftpId;
}

export async function releaseSftpConnectionMetadata(params: {
  connectionId: string;
  isLocal?: boolean;
  sftpSessions: Map<string, string>;
  connectionCacheKeys: Map<string, string>;
  clearCacheForConnection: (connectionId: string) => void;
  closeSftp: (sftpId: string) => Promise<unknown>;
  onRemoteSessionClosed?: (sftpId: string) => void;
}): Promise<void> {
  const sftpId = takeSftpConnectionMetadataForClose(params);
  if (params.isLocal || !sftpId) return;
  try {
    await params.closeSftp(sftpId);
  } catch {
    // Best-effort: backend owner cleanup remains the final safety net.
  }
  params.onRemoteSessionClosed?.(sftpId);
}

export function createSftpConnectionId(
  side: "left" | "right",
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `${side}-${randomUUID()}`;
}

/** Open SFTP through an already-authenticated terminal session before retrying normal auth. */
export async function openSftpWithSessionPreference({
  bridge,
  sourceSessionId,
  openOptions,
}: OpenSftpWithSessionPreferenceParams): Promise<string> {
  if (!bridge?.openSftp) throw new Error("SFTP bridge unavailable");
  if (sourceSessionId && bridge.openSftpForSession) {
    try {
      return await bridge.openSftpForSession(sourceSessionId, openOptions);
    } catch {
      // Fall through to the existing SFTP open path so users still get a usable
      // file browser when the live SSH transport cannot provide an SFTP channel.
    }
  }
  return bridge.openSftp(openOptions);
}

/** One complete SFTP connect attempt: optional shared-channel reuse, then one fresh dial. */
export const openSftpConnectionOnce = openSftpWithSessionPreference;

export function rejectHostKeyVerificationRequest(
  bridge: Partial<Pick<NetcattyBridge, "respondHostKeyVerification">> | null | undefined,
  requestId: string,
): void {
  void bridge?.respondHostKeyVerification?.(requestId, false, false);
}

/**
 * Pinned reconnects must follow a tab across left/right moves. Callers may still
 * pass the side captured at upload start; resolve the tab's live side instead.
 */
export function resolvePinnedReconnectSide(
  requestedSide: "left" | "right",
  tabId: string | undefined,
  leftTabs: ReadonlyArray<{ id: string }>,
  rightTabs: ReadonlyArray<{ id: string }>,
): "left" | "right" {
  if (!tabId) return requestedSide;
  if (leftTabs.some((tab) => tab.id === tabId)) return "left";
  if (rightTabs.some((tab) => tab.id === tabId)) return "right";
  throw new Error("SFTP tab is no longer available");
}

export function createPinnedReconnectSideResolver(
  requestedSide: "left" | "right",
  tabId: string | undefined,
  getLeftTabs: () => ReadonlyArray<{ id: string }>,
  getRightTabs: () => ReadonlyArray<{ id: string }>,
): () => "left" | "right" {
  let lastResolvedSide = resolvePinnedReconnectSide(
    requestedSide,
    tabId,
    getLeftTabs(),
    getRightTabs(),
  );
  return () => {
    try {
      lastResolvedSide = resolvePinnedReconnectSide(
        requestedSide,
        tabId,
        getLeftTabs(),
        getRightTabs(),
      );
    } catch {
      // Keep the last known side so stale-session cleanup remains non-throwing
      // when the tab is closed during an asynchronous reconnect.
    }
    return lastResolvedSide;
  };
}

interface UseSftpConnectionsResult {
  connect: (side: "left" | "right", host: Host | "local", options?: SftpConnectOptions) => Promise<void>;
  disconnect: (side: "left" | "right") => Promise<void>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
  hostKeyVerification: SftpHostKeyVerificationState | null;
  rejectHostKeyVerification: () => void;
  acceptHostKeyVerification: () => void;
  acceptAndSaveHostKeyVerification: () => void;
}

type HostKeyVerificationRequest = SftpHostKeyInfo & {
  requestId: string;
  sessionId?: string;
};

const toSftpHostKeyInfo = (request: HostKeyVerificationRequest): SftpHostKeyInfo => ({
  hostname: request.hostname,
  port: request.port || 22,
  keyType: request.keyType,
  fingerprint: request.fingerprint,
  publicKey: request.publicKey,
  status: request.status,
  knownHostId: request.knownHostId,
  knownFingerprint: request.knownFingerprint,
});

const createKnownHostFromSftpHostKeyInfo = (
  hostKeyInfo: SftpHostKeyInfo,
  now = Date.now(),
  idSuffix = Math.random().toString(36).slice(2, 11),
): KnownHost => ({
  id: hostKeyInfo.knownHostId || `kh-${now}-${idSuffix}`,
  hostname: hostKeyInfo.hostname,
  port: hostKeyInfo.port || 22,
  keyType: hostKeyInfo.keyType,
  publicKey: hostKeyInfo.publicKey || `SHA256:${hostKeyInfo.fingerprint}`,
  fingerprint: hostKeyInfo.fingerprint,
  discoveredAt: now,
});

export const useSftpConnections = ({
  hosts,
  keys,
  identities,
  knownHosts,
  onAddKnownHost,
  terminalSettings,
  leftTabsRef,
  rightTabsRef,
  leftTabs,
  rightTabs: _rightTabs,
  leftPane,
  rightPane,
  setLeftTabs,
  setRightTabs,
  getActivePane,
  updateTab,
  navSeqRef,
  dirCacheRef,
  sftpSessionsRef,
  lastConnectedHostRef,
  connectionCacheKeyMapRef,
  connectedHostByTabIdRef,
  reconnectingRef,
  makeCacheKey,
  clearCacheForConnection,
  createEmptyPane,
  autoConnectLocalOnMount = true,
  onRemoteSessionClosed,
}: UseSftpConnectionsParams): UseSftpConnectionsResult => {
  const onRemoteSessionClosedRef = useRef(onRemoteSessionClosed);
  onRemoteSessionClosedRef.current = onRemoteSessionClosed;
  const notifyRemoteSessionClosed = useCallback((sftpId: string | undefined) => {
    if (sftpId) onRemoteSessionClosedRef.current?.(sftpId);
  }, []);
  const getHostCredentials = useSftpHostCredentials({ hosts, keys, identities, knownHosts, terminalSettings });
  const { listLocalFiles, listRemoteFiles } = useSftpDirectoryListing();
  const [hostKeyVerification, setHostKeyVerification] = useState<SftpHostKeyVerificationState | null>(null);
  const hostKeyVerificationRef = useRef<(SftpHostKeyVerificationState & { requestId: string; sessionId: string }) | null>(null);
  const activeHostKeySessionsRef = useRef<Map<string, { side: "left" | "right"; tabId: string }>>(new Map());

  const setPendingHostKeyVerification = useCallback((
    next: (SftpHostKeyVerificationState & { requestId: string; sessionId: string }) | null,
  ) => {
    hostKeyVerificationRef.current = next;
    setHostKeyVerification(next ? {
      hostKeyInfo: next.hostKeyInfo,
      progressLogs: next.progressLogs,
    } : null);
  }, []);

  useEffect(() => {
    const dispose = netcattyBridge.get()?.onHostKeyVerification?.((request: HostKeyVerificationRequest) => {
      const sessionId = request.sessionId;
      if (!sessionId) return;
      const activeSession = activeHostKeySessionsRef.current.get(sessionId);
      if (!activeSession) return;

      const hostKeyInfo = toSftpHostKeyInfo(request);
      const logLine = request.status === "changed"
        ? `Host key changed for ${request.hostname}. Waiting for confirmation...`
        : `Host key verification required for ${request.hostname}.`;

      let activeSide: "left" | "right";
      try {
        activeSide = resolvePinnedReconnectSide(
          activeSession.side,
          activeSession.tabId,
          leftTabsRef.current.tabs,
          rightTabsRef.current.tabs,
        );
      } catch {
        rejectHostKeyVerificationRequest(netcattyBridge.get(), request.requestId);
        return;
      }
      updateTab(activeSide, activeSession.tabId, (prev) => ({
        ...prev,
        connectionLogs: [...prev.connectionLogs, logLine],
      }));
      setPendingHostKeyVerification({
        requestId: request.requestId,
        sessionId,
        hostKeyInfo,
        progressLogs: [logLine],
      });
    });

    return () => {
      dispose?.();
    };
  }, [leftTabsRef, rightTabsRef, setPendingHostKeyVerification, updateTab]);

  const respondToHostKeyVerification = useCallback((accept: boolean, addToKnownHosts = false) => {
    const pending = hostKeyVerificationRef.current;
    if (!pending) return;
    if (accept && addToKnownHosts) {
      onAddKnownHost?.(createKnownHostFromSftpHostKeyInfo(pending.hostKeyInfo));
    }
    void netcattyBridge.get()?.respondHostKeyVerification?.(
      pending.requestId,
      accept,
      addToKnownHosts,
    );
    setPendingHostKeyVerification(null);
  }, [onAddKnownHost, setPendingHostKeyVerification]);

  const rejectHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(false);
  }, [respondToHostKeyVerification]);

  const acceptHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(true, false);
  }, [respondToHostKeyVerification]);

  const acceptAndSaveHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(true, true);
  }, [respondToHostKeyVerification]);

  const connect = useCallback(
    async (requestedSide: "left" | "right", host: Host | "local", options?: SftpConnectOptions) => {
      // Follow pinned tabs that were dragged to the other side mid-reconnect.
      const resolveTargetSide = createPinnedReconnectSideResolver(
        requestedSide,
        options?.tabId,
        () => leftTabsRef.current.tabs,
        () => rightTabsRef.current.tabs,
      );
      const side = resolveTargetSide();
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;

      let activeTabId: string | null = null;
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;

      if (options?.tabId) {
        // Background reconnect for a pinned upload must not retarget the focused tab.
        activeTabId = options.tabId;
      } else if (!sideTabs.activeTabId || options?.forceNewTab) {
        const newPane = createEmptyPane();
        activeTabId = newPane.id;
        setTabs((prev) => ({
          tabs: [...prev.tabs, newPane],
          activeTabId: newPane.id,
        }));
      } else {
        activeTabId = sideTabs.activeTabId;
      }

      if (!activeTabId) return;

      // Pinned reconnect of a non-active tab must not clobber the active tab's
      // lastConnectedHost / reconnecting recovery state on this side.
      const isPinnedBackgroundReconnect =
        !!options?.tabId
        && !!sideTabs.activeTabId
        && options.tabId !== sideTabs.activeTabId;
      const clearSideReconnecting = () => {
        if (!isPinnedBackgroundReconnect) {
          reconnectingRef.current[side] = false;
        }
      };

      const getTargetPaneEarly = () => {
        const targetSide = resolveTargetSide();
        const tabs = targetSide === "left" ? leftTabsRef.current.tabs : rightTabsRef.current.tabs;
        return tabs.find((tab) => tab.id === activeTabId) ?? null;
      };
      const updateTargetTab = (updater: (prev: SftpPane) => SftpPane) => {
        updateTab(resolveTargetSide(), activeTabId, updater);
      };

      // Capture path/endpoint before we replace the connection so same-endpoint
      // auto-reconnect can land back where the user was browsing instead of home.
      // Do not inherit path across endpoints (including same hostId with different
      // hostname/port/user) if a reconnect flag is still set while switching.
      const previousConnection = getTargetPaneEarly()?.connection;
      const previousPath = previousConnection?.currentPath;
      const previousConnectionKey = !previousConnection
        ? null
        : previousConnection.isLocal
          ? "local"
          : (connectionCacheKeyMapRef.current.get(previousConnection.id) ?? null);
      const targetConnectionKey = host === "local"
        ? "local"
        : buildCacheKey(
          host.id,
          host.hostname,
          host.port,
          host.protocol,
          host.sftpSudo,
          host.username,
          host.sftpFileProtocol,
        );
      if (
        !isPinnedBackgroundReconnect
        && reconnectingRef.current[side]
        && previousConnectionKey
        && previousConnectionKey !== targetConnectionKey
      ) {
        clearSideReconnecting();
      }
      // Background pin reconnects resume via options.initialPath, not the side-wide flag.
      const isReconnectAttempt = isPinnedBackgroundReconnect
        ? !!options?.initialPath
        : reconnectingRef.current[side];
      const sameEndpointReconnect =
        isReconnectAttempt
        && !!previousPath
        && previousConnectionKey === targetConnectionKey;
      const effectiveInitialPath =
        options?.initialPath
        ?? (sameEndpointReconnect ? previousPath : undefined);

      // Notify caller of the tab ID synchronously, before any async work.
      // This allows callers to map metadata (e.g. connection keys) to the tab
      // immediately, avoiding race conditions with deferred effects.
      options?.onTabCreated?.(activeTabId);

      const connectionId = createSftpConnectionId(side);

      navSeqRef.current[side] += 1;
      const connectRequestId = navSeqRef.current[side];
      const getTargetPane = () => {
        const targetSide = resolveTargetSide();
        const tabs = targetSide === "left" ? leftTabsRef.current.tabs : rightTabsRef.current.tabs;
        return tabs.find((tab) => tab.id === activeTabId) ?? null;
      };
      const isTargetConnectionCurrent = () => {
        const pane = getTargetPane();
        if (!pane) return false;
        if (pane.connection?.id === connectionId) return true;
        return !pane.connection && navSeqRef.current[side] === connectRequestId;
      };
      const isTargetConnectionAtPath = (path: string) => {
        const connection = getTargetPane()?.connection;
        if (!connection) return navSeqRef.current[side] === connectRequestId;
        return connection?.id === connectionId && connection.currentPath === path;
      };
      const closeSftpSessionForConnection = async () => {
        await releaseSftpConnectionMetadata({
          connectionId,
          sftpSessions: sftpSessionsRef.current,
          connectionCacheKeys: connectionCacheKeyMapRef.current,
          clearCacheForConnection,
          closeSftp: async (sftpId) => netcattyBridge.get()?.closeSftp(sftpId),
          onRemoteSessionClosed: (sftpId) => notifyRemoteSessionClosed(sftpId),
        });
      };

      // Keep side-wide recovery host pointed at the active tab only.
      if (!isPinnedBackgroundReconnect) {
        lastConnectedHostRef.current[side] = host;
      }
      // Always remember the full connect-time Host for this tab so background
      // upload reconnects can restore session-time overrides (not just vault hostId).
      connectedHostByTabIdRef.current.set(activeTabId, host);
      // Store the cache key for this connection so pane actions can look it up
      // by connectionId instead of relying on the per-side lastConnectedHostRef.
      if (host !== "local") {
        connectionCacheKeyMapRef.current.set(
          connectionId,
          buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username, host.sftpFileProtocol),
        );
      }

      const currentPane = getTargetPaneEarly();
      // Reset encoding to host's configured encoding or "auto" when connecting to a new host
      // This ensures proper auto-detection works and respects host-level encoding settings
      const filenameEncoding: SftpFilenameEncoding =
        host === "local" ? "auto" : (host.sftpEncoding ?? "auto");

      // When forceNewTab is set, we're preserving the old tab for instant switching —
      // don't close its SFTP session or clear its cache.
      if (!options?.forceNewTab) {
        if (currentPane?.connection) {
          const oldSftpId = takeSftpConnectionMetadataForClose({
            connectionId: currentPane.connection.id,
            sftpSessions: sftpSessionsRef.current,
            connectionCacheKeys: connectionCacheKeyMapRef.current,
            clearCacheForConnection,
          });
          if (!currentPane.connection.isLocal && oldSftpId) {
            try {
              await netcattyBridge.get()?.closeSftp(oldSftpId);
            } catch {
              // Ignore errors when closing stale SFTP sessions
            }
            notifyRemoteSessionClosed(oldSftpId);
          }
        }
      }

      if (host === "local") {
        let homeDir = await netcattyBridge.get()?.getHomeDir?.();
        if (!homeDir) {
          const isWindows = navigator.platform.toLowerCase().includes("win");
          homeDir = isWindows ? "C:\\Users\\damao" : "/Users/damao";
        }

        const startPath = normalizeSftpPaneNavigationPath(
          effectiveInitialPath || homeDir,
          homeDir,
        );

        const connection: SftpConnection = {
          id: connectionId,
          hostId: "local",
          hostLabel: "Local",
          isLocal: true,
          status: "connected",
          currentPath: startPath,
          homeDir,
        };

        updateTargetTab((prev) => ({
          ...prev,
          connection,
          loading: true,
          reconnecting: false,
          error: null,
          connectionLogs: [],
          filenameEncoding, // Reset encoding for new connection
        }));

        try {
          const files = await listLocalFiles(startPath);
          if (!isTargetConnectionAtPath(startPath)) return;
          setDirectoryCacheEntry(dirCacheRef.current, makeCacheKey(connectionId, startPath, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          clearSideReconnecting();
          updateTargetTab((prev) => ({
            ...prev,
            files,
            loading: false,
            reconnecting: false,
          }));
        } catch (err) {
          if (!isTargetConnectionAtPath(startPath)) return;
          clearSideReconnecting();
          updateTargetTab((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : "Failed to list directory",
            loading: false,
            reconnecting: false,
          }));
        }
      } else {
        const hostCacheKey = buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username, host.sftpFileProtocol);
        const sharedHostCacheCandidate = options?.ignoreSharedCache
          ? null
          : getSharedRemoteHostCache(hostCacheKey);
        const { initialPath, sharedHostCache, cachedStartPath } = resolveRemoteSftpStartState({
          filenameEncoding,
          ignoreSharedCache: options?.ignoreSharedCache,
          initialPath: effectiveInitialPath,
          sharedHostCacheCandidate,
        });
        const normalizedCachedStartPath = normalizeSftpPaneNavigationPath(
          cachedStartPath,
          sharedHostCache?.homeDir,
          sharedHostCache?.path,
        );

        // Sudo never reuses a terminal shell; normalize before UI state so
        // reusedConnection (spinner/overlay) matches the actual open path.
        const sourceSessionId = host.sftpSudo ? undefined : options?.sourceSessionId;

        const connection: SftpConnection = {
          id: connectionId,
          hostId: host.id,
          hostLabel: host.label,
          isLocal: false,
          status: "connecting",
          currentPath: normalizedCachedStartPath,
          // Suppress loading animation when connection reuse is requested.
          // If the backend falls back to a fresh connection, the pane stays
          // non-interactive (loading=true) with stale cached files visible —
          // no worse than the previous UX of always showing a spinner.
          reusedConnection: !!sourceSessionId,
          fileProtocol: host.sftpFileProtocol ?? 'auto',
        };

        updateTargetTab((prev) => ({
          ...prev,
          connection,
          // Always show loading while connecting — even with cached files.
          // The cached file list is shown as a preview, but the pane stays
          // non-interactive until the SFTP session is actually established.
          loading: true,
          reconnecting: prev.reconnecting,
          error: null,
          connectionLogs: [],
          files: prev.reconnecting ? prev.files : (sharedHostCache?.files ?? []),
          filenameEncoding, // Reset encoding for new connection
        }));

        // Subscribe to SFTP connection progress events for auth logging
        const sftpSessionId = `sftp-${connectionId}`;
        activeHostKeySessionsRef.current.set(sftpSessionId, { side, tabId: activeTabId });
        let unsubSftpProgress: (() => void) | undefined;
        const bridge = netcattyBridge.get();
        if (bridge?.onSftpConnectionProgress) {
          unsubSftpProgress = bridge.onSftpConnectionProgress((sid, label, status, detail) => {
            if (sid !== sftpSessionId) return;
            let logLine: string;
            switch (status) {
              case 'connecting':
                logLine = `Connecting to ${label}...`;
                break;
              case 'authenticating':
                logLine = `${label} - Key exchange complete`;
                break;
              case 'auth-attempt':
                if (detail?.endsWith('rejected')) {
                  logLine = `${label} - ✗ ${detail}`;
                } else if (detail === 'all methods exhausted') {
                  logLine = `${label} - ✗ All authentication methods exhausted`;
                } else if (detail === 'waiting for user input...' || detail === 'user responded') {
                  logLine = `${label} - ${detail}`;
                } else {
                  logLine = `${label} - Trying ${detail}...`;
                }
                break;
              case 'connected':
                logLine = `${label} - Connected`;
                break;
              case 'error':
                logLine = `${label} - Error${detail ? `: ${detail}` : ''}`;
                break;
              default:
                logLine = `${label} - ${status}${detail ? `: ${detail}` : ''}`;
            }
            // Only update if this is still the active request (avoids stale logs leaking)
            if (!isTargetConnectionCurrent()) return;
            updateTargetTab((prev) => ({
              ...prev,
              connectionLogs: [...prev.connectionLogs, logLine],
            }));
          });
        }

        try {
          const openSftp = bridge?.openSftp;
          if (!openSftp) throw new Error("SFTP bridge unavailable");

          const credentials = getHostCredentials(host);
          // The main-process SSH auth driver owns key/password/MFA fallback.
          // Keep one renderer connect entry so a failed fresh dial is never
          // immediately repeated after a shared-channel attempt fails.
          const sftpId = await openSftpConnectionOnce({
            bridge,
            sourceSessionId,
            openOptions: {
              sessionId: sftpSessionId,
              ...credentials,
            },
          });

          if (!sftpId) throw new Error("Failed to open SFTP session");

          sftpSessionsRef.current.set(connectionId, sftpId);
          if (!isTargetConnectionCurrent()) {
            await closeSftpSessionForConnection();
            return;
          }

          let startPath = sharedHostCache?.path ?? "/";
          let homeDir = sharedHostCache?.homeDir ?? startPath;

          if (!sharedHostCache) {
            // Detect home directory: SSH exec `echo ~` → SFTP realpath('.') → hardcoded fallback
            const bridge = netcattyBridge.get();
            let detected = false;

            if (bridge?.getSftpHomeDir) {
              try {
                const result = await bridge.getSftpHomeDir(sftpId, host.sftpEncoding);
                if (result?.success && result.homeDir) {
                  startPath = result.homeDir;
                  homeDir = result.homeDir;
                  detected = true;
                }
              } catch {
                // Fall through to hardcoded candidates
              }
            }

            if (!detected) {
              const candidates: string[] = [];
              if (credentials.username === "root") {
                candidates.push("/root");
              } else if (credentials.username) {
                candidates.push(`/home/${credentials.username}`);
                candidates.push("/root");
              } else {
                candidates.push("/root");
              }
              const statSftp = bridge?.statSftp;
              if (statSftp) {
                for (const candidate of candidates) {
                  try {
                    const stat = await statSftp(sftpId, candidate, filenameEncoding);
                    if (stat?.type === "directory") {
                      startPath = candidate;
                      homeDir = candidate;
                      break;
                    }
                  } catch {
                    // Ignore missing/permission errors
                  }
                }
              } else {
                // Fallback: probe candidates via listSftp when statSftp is unavailable
                for (const candidate of candidates) {
                  try {
                    const files = await bridge?.listSftp(sftpId, candidate, filenameEncoding);
                    if (files) {
                      startPath = candidate;
                      homeDir = candidate;
                      break;
                    }
                  } catch {
                    // Ignore missing/permission errors
                  }
                }
              }
            }
          }

          if (initialPath) {
            startPath = initialPath;
          }
          startPath = normalizeSftpPaneNavigationPath(startPath, homeDir);

          const provisionalCacheKey = sharedHostCache
            ? makeCacheKey(connectionId, startPath, filenameEncoding)
            : null;
          if (sharedHostCache && provisionalCacheKey) {
            setDirectoryCacheEntry(dirCacheRef.current, provisionalCacheKey, {
              files: sharedHostCache.files,
              timestamp: Date.now(),
            });
          }

          let files: SftpFileEntry[] = [];
          try {
            files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
          } catch {
            // Cached path may be stale (deleted, permissions changed).
            // Remove the provisional cache entry so phantom files don't resurface.
            if (provisionalCacheKey) {
              dirCacheRef.current.delete(provisionalCacheKey);
            }
            // Fall back to homeDir, then "/", chaining attempts.
            // Remembered/reconnect paths can be stale even when shared cache is gone.
            let fallbackSucceeded = false;
            if (startPath !== homeDir) {
              try {
                startPath = homeDir;
                files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
                fallbackSucceeded = true;
              } catch {
                // homeDir also failed, try root
              }
            }
            if (!fallbackSucceeded && startPath !== "/") {
              try {
                startPath = "/";
                files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
                fallbackSucceeded = true;
              } catch {
                // root also failed
              }
            }
            if (!fallbackSucceeded) {
              throw new Error("Cannot list any remote directory");
            }
          }
          if (!isTargetConnectionCurrent()) {
            await closeSftpSessionForConnection();
            return;
          }
          setDirectoryCacheEntry(dirCacheRef.current, makeCacheKey(connectionId, startPath, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          setSharedRemoteHostCache(hostCacheKey, {
            path: startPath,
            homeDir,
            files,
            filenameEncoding,
          });

          clearSideReconnecting();

          updateTargetTab((prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "connected",
                  currentPath: startPath,
                  homeDir,
                  reusedConnection: undefined,
                }
              : null,
            files,
            loading: false,
            reconnecting: false,
            connectionLogs: [], // Clear after successful connect to avoid replay during navigation
          }));
        } catch (err) {
          if (!isTargetConnectionCurrent()) {
            await closeSftpSessionForConnection();
            return;
          }
          // A backend may already be open when initial directory discovery
          // fails. Never leave that handle mapped behind an error pane.
          await closeSftpSessionForConnection();
          clearSideReconnecting();
          updateTargetTab((prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "error",
                  error: err instanceof Error ? err.message : "Connection failed",
                }
              : null,
            files: isReconnectAttempt ? [] : prev.files,
            selectedFiles: isReconnectAttempt ? new Set<string>() : prev.selectedFiles,
            error: isReconnectAttempt
              ? "sftp.error.reconnectFailed"
              : (err instanceof Error ? err.message : "Connection failed"),
            loading: false,
            reconnecting: false,
          }));
        } finally {
          activeHostKeySessionsRef.current.delete(sftpSessionId);
          if (hostKeyVerificationRef.current?.sessionId === sftpSessionId) {
            setPendingHostKeyVerification(null);
          }
          unsubSftpProgress?.();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      getHostCredentials,
      getActivePane,
      updateTab,
      clearCacheForConnection,
      createEmptyPane,
      makeCacheKey,
      listLocalFiles,
      listRemoteFiles,
      setPendingHostKeyVerification,
    ],
  );

  const initialConnectDoneRef = useRef(false);

  useEffect(() => {
    if (
      autoConnectLocalOnMount &&
      !initialConnectDoneRef.current &&
      leftTabs.tabs.length === 0
    ) {
      const timer = window.setTimeout(() => {
        initialConnectDoneRef.current = true;
        connect("left", "local");
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [autoConnectLocalOnMount, connect, leftTabs.tabs.length]);

  useEffect(() => {
    const reconnectTimers: number[] = [];

    /** Prefer lastConnectedHostRef; fall back to vault host via connection.hostId. */
    const resolveReconnectHost = (side: "left" | "right"): Host | "local" | null => {
      const lastHost = lastConnectedHostRef.current[side];
      if (lastHost) return lastHost;

      const connection = getActivePane(side)?.connection;
      if (!connection) return null;
      if (connection.isLocal) {
        lastConnectedHostRef.current[side] = "local";
        return "local";
      }
      if (!connection.hostId) return null;
      const host = hosts.find((candidate) => candidate.id === connection.hostId) ?? null;
      if (host) {
        // Seed the ref so later refresh/session-error paths do not depend on tab races.
        lastConnectedHostRef.current[side] = host;
      }
      return host;
    };

    const scheduleReconnect = (side: "left" | "right") => {
      if (!reconnectingRef.current[side]) return;
      const host = resolveReconnectHost(side);
      if (!host) return;

      const timer = window.setTimeout(() => {
        if (!reconnectingRef.current[side]) return;
        void connect(side, host);
      }, 1000);
      reconnectTimers.push(timer);
    };

    if (leftPane.reconnecting && reconnectingRef.current.left) {
      scheduleReconnect("left");
    }
    if (rightPane.reconnecting && reconnectingRef.current.right) {
      scheduleReconnect("right");
    }

    return () => {
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    leftPane.reconnecting,
    rightPane.reconnecting,
    connect,
    getActivePane,
    hosts,
    lastConnectedHostRef,
    reconnectingRef,
  ]);

  const disconnect = useCallback(
    async (side: "left" | "right") => {
      const pane = getActivePane(side);
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const activeTabId = sideTabs.activeTabId;

      if (!pane || !activeTabId) return;

      navSeqRef.current[side] += 1;

      const sftpId = pane.connection
        ? takeSftpConnectionMetadataForClose({
          connectionId: pane.connection.id,
          sftpSessions: sftpSessionsRef.current,
          connectionCacheKeys: connectionCacheKeyMapRef.current,
          clearCacheForConnection,
        })
        : undefined;

      reconnectingRef.current[side] = false;
      lastConnectedHostRef.current[side] = null;
      connectedHostByTabIdRef.current.delete(activeTabId);

      if (pane.connection && !pane.connection.isLocal) {
        if (sftpId) {
          try {
            await netcattyBridge.get()?.closeSftp(sftpId);
          } catch {
            // Ignore errors when closing SFTP session during disconnect
          }
          notifyRemoteSessionClosed(sftpId);
        }
      }

      updateTab(side, activeTabId, () => createEmptyPane(activeTabId, pane.showHiddenFiles));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getActivePane, clearCacheForConnection, updateTab],
  );

  return {
    connect,
    disconnect,
    listLocalFiles,
    listRemoteFiles,
    hostKeyVerification,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  };
};
