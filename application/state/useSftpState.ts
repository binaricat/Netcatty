import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Host,
  Identity,
  SftpFilenameEncoding,
  SftpFileEntry,
  SSHKey,
} from "../../domain/models";
import {
  createEmptyPane,
  SftpStateOptions,
} from "./sftp/types";
import {
  formatDate,
  formatFileSize,
  getFileExtension,
  getFileName,
  getParentPath,
  joinPath,
} from "./sftp/utils";
import { useSftpTabsState } from "./sftp/useSftpTabsState";
import { isSessionError } from "./sftp/errors";
import { useSftpExternalOperations } from "./sftp/useSftpExternalOperations";
import { useSftpTransfers } from "./sftp/useSftpTransfers";
import { useSftpPaneActions } from "./sftp/useSftpPaneActions";
import { useSftpConnections } from "./sftp/useSftpConnections";
import { useSftpFileWatch } from "./sftp/useSftpFileWatch";
import { useSftpSessionCleanup } from "./sftp/useSftpSessionCleanup";
import { useSftpSessionErrors } from "./sftp/useSftpSessionErrors";
import { ensureRemoteSftpSession } from "./sftp/ensureRemoteSftpSession";
import { openTransferSftpSession } from "./sftp/dedicatedTransferResume";
import {
  buildTransferPoolKey,
  getSharedTransferConnectionPool,
} from "./sftp/transferConnectionPool";
import {
  collectLiveRemoteConnectionIds,
  shouldParkBrowseSessions,
  shouldRestoreBrowseSessions,
  takeBrowseSessionsForClose,
  takeUnusedBrowseSessions,
} from "./sftp/browseSessionLifecycle";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { logger } from "../../lib/logger";

// types + utils now live in ./sftp/*

export const useSftpState = (
  hosts: Host[],
  keys: SSHKey[],
  identities: Identity[],
  options?: SftpStateOptions
) => {
  const transferOwnerIdRef = useRef(options?.transferOwnerId ?? crypto.randomUUID());
  const createPane = useCallback(
    (id?: string, showHiddenFiles = options?.defaultShowHiddenFiles ?? false) =>
      createEmptyPane(id, showHiddenFiles),
    [options?.defaultShowHiddenFiles],
  );

  const tabsState = useSftpTabsState({
    defaultShowHiddenFiles: options?.defaultShowHiddenFiles,
  });
  const {
    leftTabs,
    rightTabs,
    leftTabsRef,
    rightTabsRef,
    setLeftTabs,
    setRightTabs,
    leftPane,
    rightPane,
    getActivePane,
    updateTab,
    updateActiveTab,
    clearSelectionsExcept,
    setTabShowHiddenFiles,
    addTab,
    closeTab: closeTabFromTabsState,
    selectTab,
    reorderTabs,
    moveTabToOtherSide,
    getTabsInfo,
    getActiveTabId,
  } = tabsState;

  // SFTP session refs
  const sftpSessionsRef = useRef<Map<string, string>>(new Map()); // connectionId -> sftpId

  // Getter for sftpId from connectionId (for stream transfers)
  const getSftpIdForConnection = useCallback((connectionId: string) => {
    return sftpSessionsRef.current.get(connectionId);
  }, []);

  // Directory listing cache (connectionId + path)
  const DIR_CACHE_TTL_MS = 10_000;
  const dirCacheRef = useRef<
    Map<string, { files: SftpFileEntry[]; timestamp: number }>
  >(new Map());

  // Navigation sequence per pane, used to ignore stale async results
  const navSeqRef = useRef<{ left: number; right: number }>({
    left: 0,
    right: 0,
  });

  const makeCacheKey = useCallback(
    (connectionId: string, path: string, encoding?: SftpFilenameEncoding) =>
      `${connectionId}::${encoding || "auto"}::${path}`,
    [],
  );

  const clearCacheForConnection = useCallback((connectionId: string) => {
    for (const key of dirCacheRef.current.keys()) {
      if (key.startsWith(`${connectionId}::`)) {
        dirCacheRef.current.delete(key);
      }
    }
  }, []);

  const clearDirCacheEntry = useCallback((connectionId: string, path: string) => {
    // Remove all encoding variants of this path from the cache
    for (const key of dirCacheRef.current.keys()) {
      if (key.startsWith(`${connectionId}::`) && key.endsWith(`::${path}`)) {
        dirCacheRef.current.delete(key);
      }
    }
  }, []);

  const getPaneByConnectionId = useCallback((connectionId: string) => {
    for (const tab of leftTabsRef.current.tabs) {
      if (tab.connection?.id === connectionId) return tab;
    }
    for (const tab of rightTabsRef.current.tabs) {
      if (tab.connection?.id === connectionId) return tab;
    }
    return null;
  }, [leftTabsRef, rightTabsRef]);

  const getTabByConnectionId = useCallback((connectionId: string) => {
    for (const tab of leftTabsRef.current.tabs) {
      if (tab.connection?.id === connectionId) {
        return { side: "left" as const, tabId: tab.id, pane: tab };
      }
    }
    for (const tab of rightTabsRef.current.tabs) {
      if (tab.connection?.id === connectionId) {
        return { side: "right" as const, tabId: tab.id, pane: tab };
      }
    }
    return null;
  }, [leftTabsRef, rightTabsRef]);

  // Ref to track pending reconnections to avoid multiple reconnect attempts
  const reconnectingRef = useRef<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  // Map connectionId → cache key, set at connect time so each tab's
  // navigateTo can use the correct cache key even when multiple tabs
  // share the same hostId with different session-time overrides.
  const connectionCacheKeyMapRef = useRef<Map<string, string>>(new Map());

  // Full endpoint key captured at connect time (hostId:hostname:port:…).
  const getConnectionCacheKey = useCallback((connectionId: string) => {
    return connectionCacheKeyMapRef.current.get(connectionId) ?? null;
  }, []);

  // Store last connected host info for reconnection
  const lastConnectedHostRef = useRef<{
    left: Host | "local" | null;
    right: Host | "local" | null;
  }>({
    left: null,
    right: null,
  });

  // Keep reconnect metadata in sync when auto-connect reuses an existing tab
  // without calling connect() (selectTab alone does not update this ref).
  const setLastConnectedHost = useCallback((
    side: "left" | "right",
    host: Host | "local" | null,
  ) => {
    lastConnectedHostRef.current[side] = host;
  }, []);

  const handleSessionError = useSftpSessionErrors({
    getActivePane,
    leftTabsRef,
    rightTabsRef,
    updateActiveTab,
    sftpSessionsRef,
    clearCacheForConnection,
    navSeqRef,
    lastConnectedHostRef,
    reconnectingRef,
  });

  useSftpSessionCleanup(sftpSessionsRef);
  useSftpFileWatch(options);

  // Closing a remote tab must reclaim its browse channel. With interactive
  // kept true while the main SFTP page stays mounted, unused mappings would
  // otherwise accumulate until unmount.
  const closeTab = useCallback(
    (side: "left" | "right", tabId: string) => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const closingTab = sideTabs.tabs.find((tab) => tab.id === tabId);
      const closingConnectionId = closingTab?.connection?.id ?? null;

      const liveConnectionIds = collectLiveRemoteConnectionIds({
        leftTabs: leftTabsRef.current.tabs,
        rightTabs: rightTabsRef.current.tabs,
        exclude: { side, tabId },
      });
      const unused = takeUnusedBrowseSessions(sftpSessionsRef.current, liveConnectionIds);

      closeTabFromTabsState(side, tabId);

      // Local panes never enter sftpSessionsRef; remote orphans are cleared below.
      if (closingConnectionId && !liveConnectionIds.has(closingConnectionId)) {
        connectionCacheKeyMapRef.current.delete(closingConnectionId);
        clearCacheForConnection(closingConnectionId);
      }

      if (unused.length === 0) return;
      logger.info(`[SFTP] Reclaiming ${unused.length} browse session(s) after tab close`);
      void Promise.all(unused.map(async ({ connectionId, sftpId }) => {
        connectionCacheKeyMapRef.current.delete(connectionId);
        clearCacheForConnection(connectionId);
        try {
          // closeSftp soft-closes when transfer leases still hold the id.
          await netcattyBridge.get()?.closeSftp?.(sftpId);
        } catch {
          // best-effort — session may already be gone
        }
      }));
    },
    [clearCacheForConnection, closeTabFromTabsState, leftTabsRef, rightTabsRef],
  );

  // FileZilla-style dedicated transfer connection pool (1–2 sessions per host).
  // Shared across SFTP panels so we never open more than maxPerHost globally.
  const transferPoolRef = useRef(
    getSharedTransferConnectionPool({
      closeSession: async (sftpId) => {
        try {
          await netcattyBridge.get()?.closeSftp?.(sftpId);
        } catch {
          // best-effort idle/session cleanup
        }
      },
    }),
  );

  // Periodically reclaim idle transfer sessions (default TTL 30s).
  useEffect(() => {
    const pool = transferPoolRef.current;
    const timer = window.setInterval(() => {
      void pool.closeIdle().then((closed) => {
        if (closed > 0) {
          logger.debug(`[SFTP] Closed ${closed} idle transfer connection(s)`);
        }
      });
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const acquireTransferSession = useCallback(
    async (hostId: string, transferId: string) => {
      const host = hosts.find((candidate) => candidate.id === hostId);
      if (!host) {
        throw new Error(`Host not found for transfer session: ${hostId}`);
      }
      const poolKey = buildTransferPoolKey({
        hostId: host.id,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        protocol: host.protocol,
        sftpSudo: host.sftpSudo,
      });
      return transferPoolRef.current.acquire(poolKey, transferId, async () => {
        logger.info(`[SFTP] Opening dedicated transfer connection for ${host.label || host.hostname}`);
        return openTransferSftpSession(host, {
          hosts,
          keys,
          identities,
          knownHosts: options?.knownHosts,
          terminalSettings: options?.terminalSettings,
        });
      });
    },
    [hosts, identities, keys, options?.knownHosts, options?.terminalSettings],
  );

  /** True after browse channels were soft-closed while this owner stayed mounted. */
  const browseParkedRef = useRef(false);
  const browseLifecycleGenRef = useRef(0);

  const {
    connect,
    disconnect,
    listLocalFiles,
    listRemoteFiles,
    hostKeyVerification,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  } = useSftpConnections({
    hosts,
    keys,
    identities,
    knownHosts: options?.knownHosts,
    onAddKnownHost: options?.onAddKnownHost,
    terminalSettings: options?.terminalSettings,
    leftTabsRef,
    rightTabsRef,
    leftTabs,
    rightTabs,
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
    createEmptyPane: createPane,
    autoConnectLocalOnMount: options?.autoConnectLocalOnMount,
  });

  const {
    navigateTo,
    refresh,
    navigateUp,
    openEntry,
    setFilter,
    toggleSelection,
    rangeSelect,
    clearSelection,
    selectAll,
    getFilteredFiles,
    createDirectory,
    createDirectoryAtPath,
    createFile,
    createFileAtPath,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    renameFileAtPath,
    moveEntriesToPath,
    changePermissions,
  } = useSftpPaneActions({
    hosts,
    getActivePane,
    updateTab,
    updateActiveTab,
    leftTabsRef,
    rightTabsRef,
    navSeqRef,
    dirCacheRef,
    sftpSessionsRef,
    lastConnectedHostRef,
    connectionCacheKeyMapRef,
    reconnectingRef,
    makeCacheKey,
    clearCacheForConnection,
    listLocalFiles,
    listRemoteFiles,
    handleSessionError,
    isSessionError,
    clearSelectionsExcept,
    dirCacheTtlMs: DIR_CACHE_TTL_MS,
  });

  const setFilenameEncoding = useCallback(
    (side: "left" | "right", encoding: SftpFilenameEncoding) => {
      updateActiveTab(side, (prev) => ({
        ...prev,
        filenameEncoding: encoding,
      }));

      const pane = getActivePane(side);
      if (pane?.connection && !pane.connection.isLocal) {
        clearCacheForConnection(pane.connection.id);
        // Defer refresh so state update lands before we read filenameEncoding in navigateTo.
        setTimeout(() => {
          const refreshedPane = getActivePane(side);
          if (refreshedPane?.connection) {
            navigateTo(side, refreshedPane.connection.currentPath, { force: true });
          }
        }, 0);
      }
    },
    [clearCacheForConnection, getActivePane, navigateTo, updateActiveTab],
  );

  const setShowHiddenFiles = useCallback(
    (side: "left" | "right", tabId: string, showHiddenFiles: boolean) => {
      setTabShowHiddenFiles(side, tabId, showHiddenFiles);
    },
    [setTabShowHiddenFiles],
  );

  const {
    transfers,
    conflicts: transferConflicts,
    activeTransfersCount,
    startTransfer,
    downloadToLocal,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    prioritizeTransfer,
    isTransferCancelled,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict: resolveTransferConflict,
  } = useSftpTransfers({
    ownerId: transferOwnerIdRef.current,
    canPrepareAdoption: options?.canPrepareTransferAdoption,
    getActivePane,
    getPaneByConnectionId,
    getTabByConnectionId,
    updateTab,
    refresh,
    clearCacheForConnection,
    sftpSessionsRef,
    connectionCacheKeyMapRef,
    listLocalFiles,
    listRemoteFiles,
    handleSessionError,
    acquireTransferSession,
  });

  const {
    readTextFile,
    readBinaryFile,
    writeTextFile,
    writeTextFileByConnection,
    downloadToTempAndOpen,
    openWithSystemDefault,
    uploadExternalFiles,
    uploadExternalFileList,
    uploadExternalFolderPath,
    uploadExternalEntries,
    cancelExternalUpload,
    selectApplication,
    activeFileWatchCountRef,
    uploadConflicts,
    resolveUploadConflict,
  } = useSftpExternalOperations({
    ownerId: transferOwnerIdRef.current,
    getActivePane,
    getPaneByConnectionId,
    refresh,
    sftpSessionsRef,
    connectionCacheKeyMapRef,
    ensureRemoteSftpId: async (side, ensureOptions) => {
      const bridge = netcattyBridge.get();
      return ensureRemoteSftpSession({
        side,
        getActivePane,
        sftpSessionsRef,
        lastConnectedHostRef,
        connect,
        resolveHostById: (hostId) => hosts.find((host) => host.id === hostId) ?? null,
        forceReconnect: ensureOptions?.forceReconnect,
        probeSession: async (sftpId) => {
          // Lightweight liveness check; any session-error from the bridge
          // triggers a reconnect in ensureRemoteSftpSession.
          if (!bridge?.getSftpHomeDir) return true;
          const result = await bridge.getSftpHomeDir(sftpId);
          if (result && result.success === false) {
            throw new Error(result.error || "SFTP session not found");
          }
          return true;
        },
      });
    },
    acquireTransferSession,
    clearDirCacheEntry,
    useCompressedUpload: options?.useCompressedUpload,
    addExternalUpload,
    updateExternalUpload,
    isTransferCancelled,
    dismissExternalUpload: dismissTransfer,
  });

  const conflicts = useMemo(
    () => [...transferConflicts, ...uploadConflicts],
    [transferConflicts, uploadConflicts],
  );
  const resolveAnyConflict = useCallback(
    (...args: Parameters<typeof resolveTransferConflict>) => {
      const [conflictId] = args;
      if (uploadConflicts.some((conflict) => conflict.transferId === conflictId)) {
        return resolveUploadConflict(...args);
      }
      return resolveTransferConflict(...args);
    },
    [resolveTransferConflict, resolveUploadConflict, uploadConflicts],
  );

  // FileZilla-style: when the browser UI is hidden, soft-close browse SFTP
  // channels. Defer park while this owner still has unfinished transfers so
  // pre-lease prep (conflict/stat) cannot race a hard-close of the browse id.
  // In-flight streams also soft-close via leases; pool handles bulk I/O.
  const interactive = options?.interactive !== false;
  useEffect(() => {
    const gen = ++browseLifecycleGenRef.current;

    const parkBrowse = async () => {
      if (!shouldParkBrowseSessions({
        interactive,
        browseParked: browseParkedRef.current,
        activeTransfersCount,
      })) {
        return;
      }
      const entries = takeBrowseSessionsForClose(sftpSessionsRef.current);
      if (entries.length === 0) {
        browseParkedRef.current = true;
        return;
      }
      browseParkedRef.current = true;
      logger.info(`[SFTP] Parking ${entries.length} browse session(s) (transfers keep pool leases)`);
      await Promise.all(entries.map(async ({ connectionId, sftpId }) => {
        clearCacheForConnection(connectionId);
        try {
          // closeSftp soft-closes when transfer leases still hold the id.
          await netcattyBridge.get()?.closeSftp?.(sftpId);
        } catch {
          // best-effort — session may already be gone
        }
      }));
    };

    const restoreBrowse = async () => {
      if (!shouldRestoreBrowseSessions({
        interactive,
        browseParked: browseParkedRef.current,
      })) {
        return;
      }
      browseParkedRef.current = false;
      const sides: Array<"left" | "right"> = ["left", "right"];
      for (const side of sides) {
        if (gen !== browseLifecycleGenRef.current) return;
        const pane = getActivePane(side);
        if (!pane?.connection || pane.connection.isLocal) continue;
        if (sftpSessionsRef.current.has(pane.connection.id)) continue;
        try {
          await ensureRemoteSftpSession({
            side,
            getActivePane,
            sftpSessionsRef,
            lastConnectedHostRef,
            connect,
            resolveHostById: (hostId) => hosts.find((host) => host.id === hostId) ?? null,
            probeSession: async (sftpId) => {
              const bridge = netcattyBridge.get();
              if (!bridge?.getSftpHomeDir) return true;
              const result = await bridge.getSftpHomeDir(sftpId);
              if (result && result.success === false) {
                throw new Error(result.error || "SFTP session not found");
              }
              return true;
            },
          });
          logger.info(`[SFTP] Restored browse session on ${side}`);
        } catch (err) {
          logger.warn(`[SFTP] Failed to restore browse session on ${side}`, err);
        }
      }
    };

    if (!interactive) {
      void parkBrowse();
    } else {
      void restoreBrowse();
    }
  }, [
    interactive,
    activeTransfersCount,
    clearCacheForConnection,
    connect,
    getActivePane,
    hosts,
    lastConnectedHostRef,
    sftpSessionsRef,
  ]);

  // Store methods in a ref to create stable wrapper functions
  // This prevents callback reference changes from causing re-renders in consumers
  const methodsRef = useRef({
    getFilteredFiles,
    addTab,
    closeTab,
    selectTab,
    reorderTabs,
    moveTabToOtherSide,
    getTabsInfo,
    getActiveTabId,
    getActivePane,
    connect,
    disconnect,
    navigateTo,
    navigateUp,
    refresh,
    openEntry,
    toggleSelection,
    rangeSelect,
    clearSelection,
    clearSelectionsExcept,
    selectAll,
    setFilter,
    setFilenameEncoding,
    setShowHiddenFiles,
    createDirectory,
    createDirectoryAtPath,
    createFile,
    createFileAtPath,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    renameFileAtPath,
    moveEntriesToPath,
    changePermissions,
    readTextFile,
    readBinaryFile,
    writeTextFile,
    writeTextFileByConnection,
    downloadToTempAndOpen,
    openWithSystemDefault,
    uploadExternalFiles,
    uploadExternalFileList,
    uploadExternalFolderPath,
    uploadExternalEntries,
    cancelExternalUpload,
    selectApplication,
    startTransfer,
    downloadToLocal,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    prioritizeTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict: resolveAnyConflict,
    getSftpIdForConnection,
    getConnectionCacheKey,
    setLastConnectedHost,
    reportSessionError: handleSessionError,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  });
  methodsRef.current = {
    getFilteredFiles,
    addTab,
    closeTab,
    selectTab,
    reorderTabs,
    moveTabToOtherSide,
    getTabsInfo,
    getActiveTabId,
    getActivePane,
    connect,
    disconnect,
    navigateTo,
    navigateUp,
    refresh,
    openEntry,
    toggleSelection,
    rangeSelect,
    clearSelection,
    clearSelectionsExcept,
    selectAll,
    setFilter,
    setFilenameEncoding,
    setShowHiddenFiles,
    createDirectory,
    createDirectoryAtPath,
    createFile,
    createFileAtPath,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    renameFileAtPath,
    moveEntriesToPath,
    changePermissions,
    readTextFile,
    readBinaryFile,
    writeTextFile,
    writeTextFileByConnection,
    downloadToTempAndOpen,
    openWithSystemDefault,
    uploadExternalFiles,
    uploadExternalFileList,
    uploadExternalFolderPath,
    uploadExternalEntries,
    cancelExternalUpload,
    selectApplication,
    startTransfer,
    downloadToLocal,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict: resolveAnyConflict,
    getSftpIdForConnection,
    getConnectionCacheKey,
    setLastConnectedHost,
    reportSessionError: handleSessionError,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  };

  // Create stable method wrappers that call through methodsRef
  // These are created once and never change reference
  const stableMethods = useMemo(() => ({
    getFilteredFiles: (...args: Parameters<typeof getFilteredFiles>) => methodsRef.current.getFilteredFiles(...args),
    addTab: (...args: Parameters<typeof addTab>) => methodsRef.current.addTab(...args),
    closeTab: (...args: Parameters<typeof closeTab>) => methodsRef.current.closeTab(...args),
    selectTab: (...args: Parameters<typeof selectTab>) => methodsRef.current.selectTab(...args),
    reorderTabs: (...args: Parameters<typeof reorderTabs>) => methodsRef.current.reorderTabs(...args),
    moveTabToOtherSide: (...args: Parameters<typeof moveTabToOtherSide>) => methodsRef.current.moveTabToOtherSide(...args),
    getTabsInfo: (...args: Parameters<typeof getTabsInfo>) => methodsRef.current.getTabsInfo(...args),
    getActiveTabId: (...args: Parameters<typeof getActiveTabId>) => methodsRef.current.getActiveTabId(...args),
    getActivePane: (...args: Parameters<typeof getActivePane>) => methodsRef.current.getActivePane(...args),
    connect: (...args: Parameters<typeof connect>) => methodsRef.current.connect(...args),
    disconnect: (...args: Parameters<typeof disconnect>) => methodsRef.current.disconnect(...args),
    navigateTo: (...args: Parameters<typeof navigateTo>) => methodsRef.current.navigateTo(...args),
    navigateUp: (...args: Parameters<typeof navigateUp>) => methodsRef.current.navigateUp(...args),
    refresh: (...args: Parameters<typeof refresh>) => methodsRef.current.refresh(...args),
    openEntry: (...args: Parameters<typeof openEntry>) => methodsRef.current.openEntry(...args),
    toggleSelection: (...args: Parameters<typeof toggleSelection>) => methodsRef.current.toggleSelection(...args),
    rangeSelect: (...args: Parameters<typeof rangeSelect>) => methodsRef.current.rangeSelect(...args),
    clearSelection: (...args: Parameters<typeof clearSelection>) => methodsRef.current.clearSelection(...args),
    clearSelectionsExcept: (...args: Parameters<typeof clearSelectionsExcept>) =>
      methodsRef.current.clearSelectionsExcept(...args),
    selectAll: (...args: Parameters<typeof selectAll>) => methodsRef.current.selectAll(...args),
    setFilter: (...args: Parameters<typeof setFilter>) => methodsRef.current.setFilter(...args),
    setFilenameEncoding: (...args: Parameters<typeof setFilenameEncoding>) =>
      methodsRef.current.setFilenameEncoding(...args),
    setShowHiddenFiles: (...args: Parameters<typeof setShowHiddenFiles>) =>
      methodsRef.current.setShowHiddenFiles(...args),
    createDirectory: (...args: Parameters<typeof createDirectory>) => methodsRef.current.createDirectory(...args),
    createDirectoryAtPath: (...args: Parameters<typeof createDirectoryAtPath>) =>
      methodsRef.current.createDirectoryAtPath(...args),
    createFile: (...args: Parameters<typeof createFile>) => methodsRef.current.createFile(...args),
    createFileAtPath: (...args: Parameters<typeof createFileAtPath>) =>
      methodsRef.current.createFileAtPath(...args),
    deleteFiles: (...args: Parameters<typeof deleteFiles>) => methodsRef.current.deleteFiles(...args),
    deleteFilesAtPath: (...args: Parameters<typeof deleteFilesAtPath>) =>
      methodsRef.current.deleteFilesAtPath(...args),
    renameFile: (...args: Parameters<typeof renameFile>) => methodsRef.current.renameFile(...args),
    renameFileAtPath: (...args: Parameters<typeof renameFileAtPath>) => methodsRef.current.renameFileAtPath(...args),
    moveEntriesToPath: (...args: Parameters<typeof moveEntriesToPath>) => methodsRef.current.moveEntriesToPath(...args),
    changePermissions: (...args: Parameters<typeof changePermissions>) => methodsRef.current.changePermissions(...args),
    readTextFile: (...args: Parameters<typeof readTextFile>) => methodsRef.current.readTextFile(...args),
    readBinaryFile: (...args: Parameters<typeof readBinaryFile>) => methodsRef.current.readBinaryFile(...args),
    writeTextFile: (...args: Parameters<typeof writeTextFile>) => methodsRef.current.writeTextFile(...args),
    writeTextFileByConnection: (...args: Parameters<typeof writeTextFileByConnection>) =>
      methodsRef.current.writeTextFileByConnection(...args),
    downloadToTempAndOpen: (...args: Parameters<typeof downloadToTempAndOpen>) => methodsRef.current.downloadToTempAndOpen(...args),
    openWithSystemDefault: (...args: Parameters<typeof openWithSystemDefault>) =>
      methodsRef.current.openWithSystemDefault(...args),
    uploadExternalFiles: (...args: Parameters<typeof uploadExternalFiles>) => methodsRef.current.uploadExternalFiles(...args),
    uploadExternalFileList: (...args: Parameters<typeof uploadExternalFileList>) =>
      methodsRef.current.uploadExternalFileList(...args),
    uploadExternalFolderPath: (...args: Parameters<typeof uploadExternalFolderPath>) =>
      methodsRef.current.uploadExternalFolderPath(...args),
    uploadExternalEntries: (...args: Parameters<typeof uploadExternalEntries>) =>
      methodsRef.current.uploadExternalEntries(...args),
    cancelExternalUpload: (taskId?: string) => methodsRef.current.cancelExternalUpload(taskId),
    selectApplication: () => methodsRef.current.selectApplication(),
    startTransfer: (...args: Parameters<typeof startTransfer>) => methodsRef.current.startTransfer(...args),
    downloadToLocal: (...args: Parameters<typeof downloadToLocal>) => methodsRef.current.downloadToLocal(...args),
    addExternalUpload: (...args: Parameters<typeof addExternalUpload>) => methodsRef.current.addExternalUpload(...args),
    updateExternalUpload: (...args: Parameters<typeof updateExternalUpload>) => methodsRef.current.updateExternalUpload(...args),
    cancelTransfer: (...args: Parameters<typeof cancelTransfer>) => methodsRef.current.cancelTransfer(...args),
    pauseTransfer: (...args: Parameters<typeof pauseTransfer>) => methodsRef.current.pauseTransfer(...args),
    resumeTransfer: (...args: Parameters<typeof resumeTransfer>) => methodsRef.current.resumeTransfer(...args),
    prioritizeTransfer: (...args: Parameters<typeof prioritizeTransfer>) => methodsRef.current.prioritizeTransfer(...args),
    retryTransfer: (...args: Parameters<typeof retryTransfer>) => methodsRef.current.retryTransfer(...args),
    clearCompletedTransfers: () => methodsRef.current.clearCompletedTransfers(),
    dismissTransfer: (...args: Parameters<typeof dismissTransfer>) => methodsRef.current.dismissTransfer(...args),
    resolveConflict: (...args: Parameters<typeof resolveAnyConflict>) => methodsRef.current.resolveConflict(...args),
    getSftpIdForConnection: (...args: Parameters<typeof getSftpIdForConnection>) => methodsRef.current.getSftpIdForConnection(...args),
    getConnectionCacheKey: (...args: Parameters<typeof getConnectionCacheKey>) => methodsRef.current.getConnectionCacheKey(...args),
    setLastConnectedHost: (...args: Parameters<typeof setLastConnectedHost>) => methodsRef.current.setLastConnectedHost(...args),
    reportSessionError: (...args: Parameters<typeof handleSessionError>) => methodsRef.current.reportSessionError(...args),
    rejectHostKeyVerification: () => methodsRef.current.rejectHostKeyVerification(),
    acceptHostKeyVerification: () => methodsRef.current.acceptHostKeyVerification(),
    acceptAndSaveHostKeyVerification: () => methodsRef.current.acceptAndSaveHostKeyVerification(),
    activeFileWatchCountRef,
  }), [activeFileWatchCountRef]); // activeFileWatchCountRef is a stable ref

  // Return object with stable method references but reactive state
  // State changes will cause re-renders, but method references stay stable
  return useMemo(() => ({
    // Reactive state - changes trigger re-renders
    leftPane,
    rightPane,
    leftTabs,
    rightTabs,
    transfers,
    activeTransfersCount,
    conflicts,
    hostKeyVerification,

    // Stable methods - never change reference
    ...stableMethods,

    // Pure helper functions (these are defined at module level, always stable)
    formatFileSize,
    formatDate,
    getFileExtension,
    joinPath,
    getParentPath,
    getFileName,
  }), [
    // Only state in deps - methods come from stableMethods which is stable
    leftPane,
    rightPane,
    leftTabs,
    rightTabs,
    transfers,
    activeTransfersCount,
    conflicts,
    hostKeyVerification,
    stableMethods,
  ]);
};

export type SftpStateApi = ReturnType<typeof useSftpState>;
