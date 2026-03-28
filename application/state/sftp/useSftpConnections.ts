import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { Host, Identity, SftpConnection, SftpFileEntry, SftpFilenameEncoding, SSHKey } from "../../../domain/models";
import type { SftpPane } from "./types";
import { useSftpDirectoryListing } from "./useSftpDirectoryListing";
import { useSftpHostCredentials } from "./useSftpHostCredentials";
import { buildCacheKey, getSharedRemoteHostCache, setSharedRemoteHostCache } from "./sharedRemoteHostCache";

interface UseSftpConnectionsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
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
  dirCacheRef: MutableRefObject<Map<string, { files: SftpFileEntry[]; timestamp: number }>>;
  sftpSessionsRef: MutableRefObject<Map<string, string>>;
  lastConnectedHostRef: MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  connectionCacheKeyMapRef: MutableRefObject<Map<string, string>>;
  reconnectingRef: MutableRefObject<{ left: boolean; right: boolean }>;
  makeCacheKey: (connectionId: string, path: string, encoding?: SftpFilenameEncoding) => string;
  clearCacheForConnection: (connectionId: string) => void;
  createEmptyPane: (id?: string, showHiddenFiles?: boolean) => SftpPane;
  autoConnectLocalOnMount?: boolean;
}

interface UseSftpConnectionsResult {
  connect: (side: "left" | "right", host: Host | "local", options?: { forceNewTab?: boolean; onTabCreated?: (tabId: string) => void }) => Promise<void>;
  disconnect: (side: "left" | "right") => Promise<void>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
}

export const useSftpConnections = ({
  hosts,
  keys,
  identities,
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
  reconnectingRef,
  makeCacheKey,
  clearCacheForConnection,
  createEmptyPane,
  autoConnectLocalOnMount = true,
}: UseSftpConnectionsParams): UseSftpConnectionsResult => {
  const getHostCredentials = useSftpHostCredentials({ hosts, keys, identities });
  const { listLocalFiles, listRemoteFiles } = useSftpDirectoryListing();

  const connect = useCallback(
    async (side: "left" | "right", host: Host | "local", options?: { forceNewTab?: boolean; onTabCreated?: (tabId: string) => void }) => {
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;

      let activeTabId: string | null = null;
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;

      if (!sideTabs.activeTabId || options?.forceNewTab) {
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

      const isReconnectAttempt = reconnectingRef.current[side];

      // Notify caller of the tab ID synchronously, before any async work.
      // This allows callers to map metadata (e.g. connection keys) to the tab
      // immediately, avoiding race conditions with deferred effects.
      options?.onTabCreated?.(activeTabId);

      const connectionId = `${side}-${Date.now()}`;

      navSeqRef.current[side] += 1;
      const connectRequestId = navSeqRef.current[side];

      lastConnectedHostRef.current[side] = host;
      // Store the cache key for this connection so pane actions can look it up
      // by connectionId instead of relying on the per-side lastConnectedHostRef.
      if (host !== "local") {
        connectionCacheKeyMapRef.current.set(
          connectionId,
          buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username),
        );
      }

      const currentPane = getActivePane(side);
      // Reset encoding to host's configured encoding or "auto" when connecting to a new host
      // This ensures proper auto-detection works and respects host-level encoding settings
      const filenameEncoding: SftpFilenameEncoding =
        host === "local" ? "auto" : (host.sftpEncoding ?? "auto");

      // When forceNewTab is set, we're preserving the old tab for instant switching —
      // don't close its SFTP session or clear its cache.
      if (!options?.forceNewTab) {
        if (currentPane?.connection) {
          clearCacheForConnection(currentPane.connection.id);
        }
        if (currentPane?.connection && !currentPane.connection.isLocal) {
          const oldSftpId = sftpSessionsRef.current.get(currentPane.connection.id);
          if (oldSftpId) {
            // Delete the mapping BEFORE the async closeSftp call to prevent
            // concurrent code from using a stale sftpId that the backend may
            // have already removed during the await.
            sftpSessionsRef.current.delete(currentPane.connection.id);
            try {
              await netcattyBridge.get()?.closeSftp(oldSftpId);
            } catch {
              // Ignore errors when closing stale SFTP sessions
            }
          }
        }
      }

      if (host === "local") {
        let homeDir = await netcattyBridge.get()?.getHomeDir?.();
        if (!homeDir) {
          const isWindows = navigator.platform.toLowerCase().includes("win");
          homeDir = isWindows ? "C:\\Users\\damao" : "/Users/damao";
        }

        const connection: SftpConnection = {
          id: connectionId,
          hostId: "local",
          hostLabel: "Local",
          isLocal: true,
          status: "connected",
          currentPath: homeDir,
          homeDir,
        };

        updateTab(side, activeTabId, (prev) => ({
          ...prev,
          connection,
          loading: true,
          reconnecting: false,
          error: null,
          connectionLogs: [],
          filenameEncoding, // Reset encoding for new connection
        }));

        try {
          const files = await listLocalFiles(homeDir);
          if (navSeqRef.current[side] !== connectRequestId) return;
          dirCacheRef.current.set(makeCacheKey(connectionId, homeDir, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          reconnectingRef.current[side] = false;
          updateTab(side, activeTabId, (prev) => ({
            ...prev,
            files,
            loading: false,
            reconnecting: false,
          }));
        } catch (err) {
          if (navSeqRef.current[side] !== connectRequestId) return;
          reconnectingRef.current[side] = false;
          updateTab(side, activeTabId, (prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : "Failed to list directory",
            loading: false,
            reconnecting: false,
          }));
        }
      } else {
        const hostCacheKey = buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username);
        const sharedHostCacheCandidate = getSharedRemoteHostCache(hostCacheKey);
        const sharedHostCache =
          sharedHostCacheCandidate?.filenameEncoding === filenameEncoding
            ? sharedHostCacheCandidate
            : null;
        const cachedStartPath = sharedHostCache?.path ?? "/";

        const connection: SftpConnection = {
          id: connectionId,
          hostId: host.id,
          hostLabel: host.label,
          isLocal: false,
          status: "connecting",
          currentPath: cachedStartPath,
        };

        updateTab(side, activeTabId, (prev) => ({
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
            if (navSeqRef.current[side] !== connectRequestId) return;
            updateTab(side, activeTabId, (prev) => ({
              ...prev,
              connectionLogs: [...prev.connectionLogs, logLine],
            }));
          });
        }

        try {
          const credentials = getHostCredentials(host);
          const openSftp = bridge?.openSftp;
          if (!openSftp) throw new Error("SFTP bridge unavailable");

          const isAuthError = (err: unknown): boolean => {
            if (!(err instanceof Error)) return false;
            const msg = err.message.toLowerCase();
            return (
              msg.includes("authentication") ||
              msg.includes("auth") ||
              msg.includes("password") ||
              msg.includes("permission denied")
            );
          };

          const hasKey = !!credentials.privateKey;
          const hasPassword = !!credentials.password;

          let sftpId: string | undefined;
          if (hasKey) {
            try {
              const keyFirstCredentials = {
                sessionId: `sftp-${connectionId}`,
                ...credentials,
              };
              if (!credentials.sudo) {
                keyFirstCredentials.password = undefined;
              }
              sftpId = await openSftp(keyFirstCredentials);
            } catch (err) {
              if (hasPassword && isAuthError(err)) {
                sftpId = await openSftp({
                  sessionId: `sftp-${connectionId}`,
                  ...credentials,
                  privateKey: undefined,
                  certificate: undefined,
                  publicKey: undefined,
                  keyId: undefined,
                  keySource: undefined,
                });
              } else {
                throw err;
              }
            }
          } else {
            sftpId = await openSftp({
              sessionId: `sftp-${connectionId}`,
              ...credentials,
            });
          }

          if (!sftpId) throw new Error("Failed to open SFTP session");

          sftpSessionsRef.current.set(connectionId, sftpId);

          let startPath = sharedHostCache?.path ?? "/";
          let homeDir = sharedHostCache?.homeDir ?? startPath;

          if (!sharedHostCache) {
            // Detect home directory: SSH exec `echo ~` → SFTP realpath('.') → hardcoded fallback
            const bridge = netcattyBridge.get();
            let detected = false;

            if (bridge?.getSftpHomeDir) {
              try {
                const result = await bridge.getSftpHomeDir(sftpId);
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

          const provisionalCacheKey = sharedHostCache
            ? makeCacheKey(connectionId, startPath, filenameEncoding)
            : null;
          if (sharedHostCache && provisionalCacheKey) {
            dirCacheRef.current.set(provisionalCacheKey, {
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
            let fallbackSucceeded = false;
            if (sharedHostCache && startPath !== homeDir) {
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
          if (navSeqRef.current[side] !== connectRequestId) return;
          dirCacheRef.current.set(makeCacheKey(connectionId, startPath, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          setSharedRemoteHostCache(hostCacheKey, {
            path: startPath,
            homeDir,
            files,
            filenameEncoding,
          });

          reconnectingRef.current[side] = false;

          updateTab(side, activeTabId, (prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "connected",
                  currentPath: startPath,
                  homeDir,
                }
              : null,
            files,
            loading: false,
            reconnecting: false,
            connectionLogs: [], // Clear after successful connect to avoid replay during navigation
          }));
        } catch (err) {
          if (navSeqRef.current[side] !== connectRequestId) return;
          reconnectingRef.current[side] = false;
          updateTab(side, activeTabId, (prev) => ({
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

    const scheduleReconnect = (side: "left" | "right") => {
      const lastHost = lastConnectedHostRef.current[side];
      if (!lastHost || !reconnectingRef.current[side]) return;

      const timer = window.setTimeout(() => {
        if (!reconnectingRef.current[side]) return;
        void connect(side, lastHost);
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
  }, [leftPane.reconnecting, rightPane.reconnecting, connect, lastConnectedHostRef, reconnectingRef]);

  const disconnect = useCallback(
    async (side: "left" | "right") => {
      const pane = getActivePane(side);
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const activeTabId = sideTabs.activeTabId;

      if (!pane || !activeTabId) return;

      navSeqRef.current[side] += 1;

      if (pane.connection) {
        clearCacheForConnection(pane.connection.id);
      }

      reconnectingRef.current[side] = false;
      lastConnectedHostRef.current[side] = null;

      if (pane.connection && !pane.connection.isLocal) {
        const sftpId = sftpSessionsRef.current.get(pane.connection.id);
        if (sftpId) {
          try {
            await netcattyBridge.get()?.closeSftp(sftpId);
          } catch {
            // Ignore errors when closing SFTP session during disconnect
          }
          sftpSessionsRef.current.delete(pane.connection.id);
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
  };
};
