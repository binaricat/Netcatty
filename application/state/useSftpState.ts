import { useCallback, useMemo, useRef } from "react";
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

// types + utils now live in ./sftp/*

export const useSftpState = (
  hosts: Host[],
  keys: SSHKey[],
  identities: Identity[],
  options?: SftpStateOptions
) => {
  const tabsState = useSftpTabsState();
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
    addTab,
    closeTab,
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

  // Ref to track pending reconnections to avoid multiple reconnect attempts
  const reconnectingRef = useRef<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  // Store last connected host info for reconnection
  const lastConnectedHostRef = useRef<{
    left: Host | "local" | null;
    right: Host | "local" | null;
  }>({
    left: null,
    right: null,
  });

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

  const { connect, disconnect, listLocalFiles, listRemoteFiles } = useSftpConnections({
    hosts,
    keys,
    identities,
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
    reconnectingRef,
    makeCacheKey,
    clearCacheForConnection,
    createEmptyPane,
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
    createFile,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    changePermissions,
  } = useSftpPaneActions({
    getActivePane,
    updateTab,
    updateActiveTab,
    leftTabsRef,
    rightTabsRef,
    navSeqRef,
    dirCacheRef,
    sftpSessionsRef,
    lastConnectedHostRef,
    reconnectingRef,
    makeCacheKey,
    clearCacheForConnection,
    listLocalFiles,
    listRemoteFiles,
    handleSessionError,
    isSessionError,
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

  const {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
  } = useSftpTransfers({
    getActivePane,
    refresh,
    sftpSessionsRef,
    listLocalFiles,
    listRemoteFiles,
    handleSessionError,
  });

  const {
    readTextFile,
    readBinaryFile,
    writeTextFile,
    downloadToTempAndOpen,
    uploadExternalFiles,
    cancelExternalUpload,
    selectApplication,
  } = useSftpExternalOperations({
    getActivePane,
    refresh,
    sftpSessionsRef,
    addExternalUpload,
    updateExternalUpload,
    dismissExternalUpload: dismissTransfer,
  });

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
    selectAll,
    setFilter,
    setFilenameEncoding,
    createDirectory,
    createFile,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    changePermissions,
    readTextFile,
    readBinaryFile,
    writeTextFile,
    downloadToTempAndOpen,
    uploadExternalFiles,
    cancelExternalUpload,
    selectApplication,
    startTransfer,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
    getSftpIdForConnection,
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
    selectAll,
    setFilter,
    setFilenameEncoding,
    createDirectory,
    createFile,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    changePermissions,
    readTextFile,
    readBinaryFile,
    writeTextFile,
    downloadToTempAndOpen,
    uploadExternalFiles,
    cancelExternalUpload,
    selectApplication,
    startTransfer,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
    getSftpIdForConnection,
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
    selectAll: (...args: Parameters<typeof selectAll>) => methodsRef.current.selectAll(...args),
    setFilter: (...args: Parameters<typeof setFilter>) => methodsRef.current.setFilter(...args),
    setFilenameEncoding: (...args: Parameters<typeof setFilenameEncoding>) =>
      methodsRef.current.setFilenameEncoding(...args),
    createDirectory: (...args: Parameters<typeof createDirectory>) => methodsRef.current.createDirectory(...args),
    createFile: (...args: Parameters<typeof createFile>) => methodsRef.current.createFile(...args),
    deleteFiles: (...args: Parameters<typeof deleteFiles>) => methodsRef.current.deleteFiles(...args),
    deleteFilesAtPath: (...args: Parameters<typeof deleteFilesAtPath>) =>
      methodsRef.current.deleteFilesAtPath(...args),
    renameFile: (...args: Parameters<typeof renameFile>) => methodsRef.current.renameFile(...args),
    changePermissions: (...args: Parameters<typeof changePermissions>) => methodsRef.current.changePermissions(...args),
    readTextFile: (...args: Parameters<typeof readTextFile>) => methodsRef.current.readTextFile(...args),
    readBinaryFile: (...args: Parameters<typeof readBinaryFile>) => methodsRef.current.readBinaryFile(...args),
    writeTextFile: (...args: Parameters<typeof writeTextFile>) => methodsRef.current.writeTextFile(...args),
    downloadToTempAndOpen: (...args: Parameters<typeof downloadToTempAndOpen>) => methodsRef.current.downloadToTempAndOpen(...args),
    uploadExternalFiles: (...args: Parameters<typeof uploadExternalFiles>) => methodsRef.current.uploadExternalFiles(...args),
    cancelExternalUpload: () => methodsRef.current.cancelExternalUpload(),
    selectApplication: () => methodsRef.current.selectApplication(),
    startTransfer: (...args: Parameters<typeof startTransfer>) => methodsRef.current.startTransfer(...args),
    addExternalUpload: (...args: Parameters<typeof addExternalUpload>) => methodsRef.current.addExternalUpload(...args),
    updateExternalUpload: (...args: Parameters<typeof updateExternalUpload>) => methodsRef.current.updateExternalUpload(...args),
    cancelTransfer: (...args: Parameters<typeof cancelTransfer>) => methodsRef.current.cancelTransfer(...args),
    retryTransfer: (...args: Parameters<typeof retryTransfer>) => methodsRef.current.retryTransfer(...args),
    clearCompletedTransfers: () => methodsRef.current.clearCompletedTransfers(),
    dismissTransfer: (...args: Parameters<typeof dismissTransfer>) => methodsRef.current.dismissTransfer(...args),
    resolveConflict: (...args: Parameters<typeof resolveConflict>) => methodsRef.current.resolveConflict(...args),
    getSftpIdForConnection: (...args: Parameters<typeof getSftpIdForConnection>) => methodsRef.current.getSftpIdForConnection(...args),
  }), []); // Empty deps - these wrappers never change

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
    stableMethods,
  ]);
};

export type SftpStateApi = ReturnType<typeof useSftpState>;
