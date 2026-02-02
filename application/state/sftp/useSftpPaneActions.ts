import { useCallback } from "react";
import type { Host, SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { SftpPane } from "./types";
import { getParentPath, isNavigableDirectory, isWindowsRoot, joinPath } from "./utils";

interface UseSftpPaneActionsParams {
  getActivePane: (side: "left" | "right") => SftpPane | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  updateActiveTab: (side: "left" | "right", updater: (pane: SftpPane) => SftpPane) => void;
  leftTabsRef: React.MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  rightTabsRef: React.MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  navSeqRef: React.MutableRefObject<{ left: number; right: number }>;
  dirCacheRef: React.MutableRefObject<Map<string, { files: SftpFileEntry[]; timestamp: number }>>;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  lastConnectedHostRef: React.MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  reconnectingRef: React.MutableRefObject<{ left: boolean; right: boolean }>;
  makeCacheKey: (connectionId: string, path: string, encoding?: SftpFilenameEncoding) => string;
  clearCacheForConnection: (connectionId: string) => void;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
  handleSessionError: (side: "left" | "right", error: Error) => void;
  isSessionError: (err: unknown) => boolean;
  dirCacheTtlMs: number;
}

interface UseSftpPaneActionsResult {
  navigateTo: (side: "left" | "right", path: string, options?: { force?: boolean }) => Promise<void>;
  refresh: (side: "left" | "right") => Promise<void>;
  navigateUp: (side: "left" | "right") => Promise<void>;
  openEntry: (side: "left" | "right", entry: SftpFileEntry) => Promise<void>;
  toggleSelection: (side: "left" | "right", fileName: string, multiSelect: boolean) => void;
  rangeSelect: (side: "left" | "right", fileNames: string[]) => void;
  clearSelection: (side: "left" | "right") => void;
  selectAll: (side: "left" | "right") => void;
  setFilter: (side: "left" | "right", filter: string) => void;
  getFilteredFiles: (pane: SftpPane) => SftpFileEntry[];
  createDirectory: (side: "left" | "right", name: string) => Promise<void>;
  createFile: (side: "left" | "right", name: string) => Promise<void>;
  deleteFiles: (side: "left" | "right", fileNames: string[]) => Promise<void>;
  deleteFilesAtPath: (
    side: "left" | "right",
    connectionId: string,
    path: string,
    fileNames: string[],
  ) => Promise<void>;
  renameFile: (side: "left" | "right", oldName: string, newName: string) => Promise<void>;
  changePermissions: (side: "left" | "right", filePath: string, mode: string) => Promise<void>;
}

export const useSftpPaneActions = ({
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
  dirCacheTtlMs,
}: UseSftpPaneActionsParams): UseSftpPaneActionsResult => {
  const navigateTo = useCallback(
    async (
      side: "left" | "right",
      path: string,
      options?: { force?: boolean },
    ) => {
      console.log("[SFTP navigateTo] called", { side, path, force: options?.force });

      const pane = getActivePane(side);
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const activeTabId = sideTabs.activeTabId;

      console.log("[SFTP navigateTo] state check", {
        paneId: pane?.id,
        hasConnection: !!pane?.connection,
        activeTabId,
        currentPath: pane?.connection?.currentPath,
      });

      if (!pane?.connection || !activeTabId) {
        console.log("[SFTP navigateTo] No pane/connection/activeTabId, returning early");
        return;
      }

      const requestId = ++navSeqRef.current[side];
      const cacheKey = makeCacheKey(pane.connection.id, path, pane.filenameEncoding);
      const cached = options?.force
        ? undefined
        : dirCacheRef.current.get(cacheKey);

      if (
        cached &&
        Date.now() - cached.timestamp < dirCacheTtlMs &&
        cached.files
      ) {
        console.log("[SFTP navigateTo] Using cached files for path", { path, cacheKey });
        updateTab(side, activeTabId, (prev) => ({
          ...prev,
          connection: prev.connection
            ? { ...prev.connection, currentPath: path }
            : null,
          files: cached.files,
          loading: false,
          error: null,
          selectedFiles: new Set(),
        }));
        return;
      }

      console.log("[SFTP navigateTo] Fetching files from server for path", { path });
      updateTab(side, activeTabId, (prev) => ({ ...prev, loading: true, error: null }));

      try {
        let files: SftpFileEntry[];

        if (pane.connection.isLocal) {
          files = await listLocalFiles(path);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            clearCacheForConnection(pane.connection.id);
            updateTab(side, activeTabId, (prev) => ({
              ...prev,
              connection: null,
              files: [],
              loading: false,
              reconnecting: false,
              error: "SFTP session lost. Please reconnect.",
              selectedFiles: new Set(),
              filter: "",
            }));
            return;
          }

          try {
            files = await listRemoteFiles(sftpId, path, pane.filenameEncoding);
          } catch (err) {
            if (isSessionError(err)) {
              sftpSessionsRef.current.delete(pane.connection.id);
              clearCacheForConnection(pane.connection.id);
              updateTab(side, activeTabId, (prev) => ({
                ...prev,
                connection: null,
                files: [],
                loading: false,
                reconnecting: false,
                error: "SFTP session expired. Please reconnect.",
                selectedFiles: new Set(),
                filter: "",
              }));
              return;
            }
            throw err as Error;
          }
        }

        if (navSeqRef.current[side] !== requestId) return;

        dirCacheRef.current.set(cacheKey, {
          files,
          timestamp: Date.now(),
        });

        updateTab(side, activeTabId, (prev) => ({
          ...prev,
          connection: prev.connection
            ? { ...prev.connection, currentPath: path }
            : null,
          files,
          loading: false,
          selectedFiles: new Set(),
        }));
      } catch (err) {
        if (navSeqRef.current[side] !== requestId) return;
        updateTab(side, activeTabId, (prev) => ({
          ...prev,
          error:
            err instanceof Error ? err.message : "Failed to list directory",
          loading: false,
        }));
      }
    },
    [
      getActivePane,
      updateTab,
      leftTabsRef,
      rightTabsRef,
      navSeqRef,
      dirCacheRef,
      makeCacheKey,
      dirCacheTtlMs,
      listLocalFiles,
      listRemoteFiles,
      sftpSessionsRef,
      clearCacheForConnection,
      isSessionError,
    ],
  );

  const refresh = useCallback(
    async (side: "left" | "right") => {
      const pane = getActivePane(side);
      if (pane?.connection) {
        await navigateTo(side, pane.connection.currentPath, { force: true });
      } else if (!pane?.connection && pane?.error) {
        const lastHost = lastConnectedHostRef.current[side];
        if (lastHost && !reconnectingRef.current[side]) {
          reconnectingRef.current[side] = true;
          updateActiveTab(side, (prev) => ({
            ...prev,
            reconnecting: true,
            error: "sftp.reconnecting.title",
          }));
        } else if (!lastHost) {
          updateActiveTab(side, (prev) => ({
            ...prev,
            error: "sftp.error.connectionLostManual",
          }));
        }
      }
    },
    [getActivePane, navigateTo, updateActiveTab, lastConnectedHostRef, reconnectingRef],
  );

  const navigateUp = useCallback(
    async (side: "left" | "right") => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const currentPath = pane.connection.currentPath;
      const isAtRoot = currentPath === "/" || isWindowsRoot(currentPath);

      if (!isAtRoot) {
        const parentPath = getParentPath(currentPath);
        await navigateTo(side, parentPath);
      }
    },
    [getActivePane, navigateTo],
  );

  const openEntry = useCallback(
    async (side: "left" | "right", entry: SftpFileEntry) => {
      console.log("[SFTP openEntry] called", { side, entryName: entry.name, entryType: entry.type });

      const pane = getActivePane(side);
      console.log("[SFTP openEntry] getActivePane result", {
        paneId: pane?.id,
        hasConnection: !!pane?.connection,
        currentPath: pane?.connection?.currentPath,
      });

      if (!pane?.connection) {
        console.log("[SFTP openEntry] No pane or connection, returning early");
        return;
      }

      if (entry.name === "..") {
        const currentPath = pane.connection.currentPath;
        const isAtRoot = currentPath === "/" || isWindowsRoot(currentPath);
        console.log("[SFTP openEntry] Navigating up from '..'", {
          currentPath,
          isAtRoot,
          isWindowsRoot: isWindowsRoot(currentPath),
        });

        if (!isAtRoot) {
          const parentPath = getParentPath(currentPath);
          console.log("[SFTP openEntry] Calculated parent path", { currentPath, parentPath });
          await navigateTo(side, parentPath);
        } else {
          console.log("[SFTP openEntry] Already at root, not navigating");
        }
        return;
      }

      if (isNavigableDirectory(entry)) {
        const newPath = joinPath(pane.connection.currentPath, entry.name);
        console.log("[SFTP openEntry] Navigating into directory", { currentPath: pane.connection.currentPath, entryName: entry.name, newPath });
        await navigateTo(side, newPath);
      }
    },
    [getActivePane, navigateTo],
  );

  const toggleSelection = useCallback(
    (side: "left" | "right", fileName: string, multiSelect: boolean) => {
      updateActiveTab(side, (prev) => {
        const newSelection = new Set(multiSelect ? prev.selectedFiles : []);
        if (newSelection.has(fileName)) {
          newSelection.delete(fileName);
        } else {
          newSelection.add(fileName);
        }
        return { ...prev, selectedFiles: newSelection };
      });
    },
    [updateActiveTab],
  );

  const rangeSelect = useCallback(
    (side: "left" | "right", fileNames: string[]) => {
      const newSelection = new Set<string>();
      for (const name of fileNames) {
        if (name && name !== "..") {
          newSelection.add(name);
        }
      }

      updateActiveTab(side, (prev) => ({ ...prev, selectedFiles: newSelection }));
    },
    [updateActiveTab],
  );

  const clearSelection = useCallback((side: "left" | "right") => {
    updateActiveTab(side, (prev) => ({ ...prev, selectedFiles: new Set() }));
  }, [updateActiveTab]);

  const selectAll = useCallback(
    (side: "left" | "right") => {
      const pane = getActivePane(side);
      if (!pane) return;

      updateActiveTab(side, (prev) => ({
        ...prev,
        selectedFiles: new Set(
          pane.files.filter((f) => f.name !== "..").map((f) => f.name),
        ),
      }));
    },
    [getActivePane, updateActiveTab],
  );

  const setFilter = useCallback((side: "left" | "right", filter: string) => {
    updateActiveTab(side, (prev) => ({ ...prev, filter }));
  }, [updateActiveTab]);

  const getFilteredFiles = useCallback((pane: SftpPane): SftpFileEntry[] => {
    const term = pane.filter.trim().toLowerCase();
    if (!term) return pane.files;
    return pane.files.filter(
      (f) => f.name === ".." || f.name.toLowerCase().includes(term),
    );
  }, []);

  const createDirectory = useCallback(
    async (side: "left" | "right", name: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const fullPath = joinPath(pane.connection.currentPath, name);

      try {
        if (pane.connection.isLocal) {
          await netcattyBridge.get()?.mkdirLocal?.(fullPath);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          await netcattyBridge.get()?.mkdirSftp(sftpId, fullPath, pane.filenameEncoding);
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [getActivePane, refresh, handleSessionError, sftpSessionsRef, isSessionError],
  );

  const createFile = useCallback(
    async (side: "left" | "right", name: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const fullPath = joinPath(pane.connection.currentPath, name);

      try {
        if (pane.connection.isLocal) {
          const bridge = netcattyBridge.get();
          if (bridge?.writeLocalFile) {
            const emptyBuffer = new ArrayBuffer(0);
            await bridge.writeLocalFile(fullPath, emptyBuffer);
          } else {
            throw new Error("Local file writing not supported");
          }
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          const bridge = netcattyBridge.get();
          if (bridge?.writeSftpBinary) {
            const emptyBuffer = new ArrayBuffer(0);
            await bridge.writeSftpBinary(sftpId, fullPath, emptyBuffer, pane.filenameEncoding);
          } else if (bridge?.writeSftp) {
            await bridge.writeSftp(sftpId, fullPath, "", pane.filenameEncoding);
          } else {
            throw new Error("No write method available");
          }
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [getActivePane, refresh, handleSessionError, sftpSessionsRef, isSessionError],
  );

  const deleteFiles = useCallback(
    async (side: "left" | "right", fileNames: string[]) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      try {
        for (const name of fileNames) {
          const fullPath = joinPath(pane.connection.currentPath, name);

          if (pane.connection.isLocal) {
            await netcattyBridge.get()?.deleteLocalFile?.(fullPath);
          } else {
            const sftpId = sftpSessionsRef.current.get(pane.connection.id);
            if (!sftpId) {
              handleSessionError(side, new Error("SFTP session not found"));
              return;
            }
            await netcattyBridge.get()?.deleteSftp?.(sftpId, fullPath, pane.filenameEncoding);
          }
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [getActivePane, refresh, handleSessionError, sftpSessionsRef, isSessionError],
  );

  const deleteFilesAtPath = useCallback(
    async (
      side: "left" | "right",
      connectionId: string,
      path: string,
      fileNames: string[],
    ) => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const pane = sideTabs.tabs.find((tab) => tab.connection?.id === connectionId);
      if (!pane?.connection) {
        throw new Error("Source pane is no longer available");
      }
      const bridge = netcattyBridge.get();
      if (!bridge) {
        throw new Error("Netcatty bridge not available");
      }

      try {
        for (const name of fileNames) {
          const fullPath = joinPath(path, name);

          if (pane.connection.isLocal) {
            if (!bridge.deleteLocalFile) {
              throw new Error("Local delete unavailable");
            }
            await bridge.deleteLocalFile(fullPath);
          } else {
            const sftpId = sftpSessionsRef.current.get(pane.connection.id);
            if (!sftpId) {
              const error = new Error("SFTP session not found");
              handleSessionError(side, error);
              throw error;
            }
            if (!bridge.deleteSftp) {
              throw new Error("SFTP delete unavailable");
            }
            await bridge.deleteSftp(sftpId, fullPath, pane.filenameEncoding);
          }
        }

        clearCacheForConnection(pane.connection.id);

        if (sideTabs.activeTabId === pane.id && pane.connection.currentPath === path) {
          await refresh(side);
        } else {
          updateTab(side, pane.id, (prev) => {
            if (!prev.connection || prev.connection.id !== connectionId) return prev;
            if (prev.connection.currentPath !== path) return prev;

            const removeSet = new Set(fileNames);
            const filteredFiles = prev.files.filter((file) => !removeSet.has(file.name));
            const nextSelection = new Set(prev.selectedFiles);
            for (const name of fileNames) {
              nextSelection.delete(name);
            }
            return {
              ...prev,
              files: filteredFiles,
              selectedFiles: nextSelection,
            };
          });
        }
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          throw err;
        }
        throw err;
      }
    },
    [
      clearCacheForConnection,
      handleSessionError,
      isSessionError,
      leftTabsRef,
      refresh,
      rightTabsRef,
      sftpSessionsRef,
      updateTab,
    ],
  );

  const renameFile = useCallback(
    async (side: "left" | "right", oldName: string, newName: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const oldPath = joinPath(pane.connection.currentPath, oldName);
      const newPath = joinPath(pane.connection.currentPath, newName);

      try {
        if (pane.connection.isLocal) {
          await netcattyBridge.get()?.renameLocalFile?.(oldPath, newPath);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          await netcattyBridge.get()?.renameSftp?.(sftpId, oldPath, newPath, pane.filenameEncoding);
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [getActivePane, refresh, handleSessionError, sftpSessionsRef, isSessionError],
  );

  const changePermissions = useCallback(
    async (
      side: "left" | "right",
      filePath: string,
      mode: string,
    ) => {
      const pane = getActivePane(side);
      if (!pane?.connection || pane.connection.isLocal) {
        logger.warn("Cannot change permissions on local files");
        return;
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId || !netcattyBridge.get()?.chmodSftp) {
        handleSessionError(side, new Error("SFTP session not found"));
        return;
      }

      try {
        await netcattyBridge.get()!.chmodSftp!(sftpId, filePath, mode, pane.filenameEncoding);
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        logger.error("Failed to change permissions:", err);
      }
    },
    [getActivePane, refresh, handleSessionError, sftpSessionsRef, isSessionError],
  );

  return {
    navigateTo,
    refresh,
    navigateUp,
    openEntry,
    toggleSelection,
    rangeSelect,
    clearSelection,
    selectAll,
    setFilter,
    getFilteredFiles,
    createDirectory,
    createFile,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    changePermissions,
  };
};
