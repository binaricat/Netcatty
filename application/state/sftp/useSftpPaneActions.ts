import { useCallback, useRef } from "react";
import type { Host, SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { SftpPane } from "./types";
import { getFileName, getParentPath, isNavigableDirectory, isWindowsRoot, joinPath } from "./utils";
import { buildCacheKey, setSharedRemoteHostCache } from "./sharedRemoteHostCache";

/** Shared empty set for navigation resets — never mutate this. */
const EMPTY_SET = new Set<string>();

interface UseSftpPaneActionsParams {
  hosts: Host[];
  getActivePane: (side: "left" | "right") => SftpPane | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  updateActiveTab: (side: "left" | "right", updater: (pane: SftpPane) => SftpPane) => void;
  leftTabsRef: React.MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  rightTabsRef: React.MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  navSeqRef: React.MutableRefObject<{ left: number; right: number }>;
  dirCacheRef: React.MutableRefObject<Map<string, { files: SftpFileEntry[]; timestamp: number }>>;
  sftpSessionsRef: React.MutableRefObject<Map<string, string>>;
  lastConnectedHostRef: React.MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  connectionCacheKeyMapRef: React.MutableRefObject<Map<string, string>>;
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
  navigateTo: (side: "left" | "right", path: string, options?: { force?: boolean; tabId?: string }) => Promise<void>;
  refresh: (side: "left" | "right", options?: { tabId?: string }) => Promise<void>;
  navigateUp: (side: "left" | "right") => Promise<void>;
  openEntry: (side: "left" | "right", entry: SftpFileEntry) => Promise<void>;
  toggleSelection: (side: "left" | "right", fileName: string, multiSelect: boolean) => void;
  rangeSelect: (side: "left" | "right", fileNames: string[]) => void;
  clearSelection: (side: "left" | "right") => void;
  selectAll: (side: "left" | "right") => void;
  setFilter: (side: "left" | "right", filter: string) => void;
  getFilteredFiles: (pane: SftpPane) => SftpFileEntry[];
  createDirectory: (side: "left" | "right", name: string) => Promise<void>;
  createDirectoryAtPath: (side: "left" | "right", path: string, name: string) => Promise<void>;
  createFile: (side: "left" | "right", name: string) => Promise<void>;
  createFileAtPath: (side: "left" | "right", path: string, name: string) => Promise<void>;
  deleteFiles: (side: "left" | "right", fileNames: string[]) => Promise<void>;
  deleteFilesAtPath: (
    side: "left" | "right",
    connectionId: string,
    path: string,
    fileNames: string[],
  ) => Promise<void>;
  renameFile: (side: "left" | "right", oldName: string, newName: string) => Promise<void>;
  renameFileAtPath: (side: "left" | "right", oldPath: string, newName: string) => Promise<void>;
  moveEntriesToPath: (side: "left" | "right", sourcePaths: string[], targetPath: string) => Promise<void>;
  changePermissions: (side: "left" | "right", filePath: string, mode: string) => Promise<void>;
}

export const useSftpPaneActions = ({
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
  dirCacheTtlMs,
}: UseSftpPaneActionsParams): UseSftpPaneActionsResult => {
  const normalizePathForCompare = useCallback((path: string): string => {
    if (isWindowsRoot(path)) return path.replace(/\//g, "\\").toLowerCase();
    if (/^[A-Za-z]:/.test(path)) {
      return path.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
    }
    if (path === "/") return "/";
    return path.replace(/\/+$/, "");
  }, []);

  const isSamePath = useCallback((a: string, b: string): boolean => {
    return normalizePathForCompare(a) === normalizePathForCompare(b);
  }, [normalizePathForCompare]);

  const isDescendantPath = useCallback((candidate: string, parent: string): boolean => {
    const normalizedCandidate = normalizePathForCompare(candidate);
    const normalizedParent = normalizePathForCompare(parent);
    if (normalizedCandidate === normalizedParent) return false;

    if (/^[a-z]:\\$/.test(normalizedParent)) {
      return normalizedCandidate.startsWith(normalizedParent);
    }

    if (normalizedParent === "/") {
      return normalizedCandidate.startsWith("/");
    }

    const separator = normalizedParent.includes("\\") ? "\\" : "/";
    return normalizedCandidate.startsWith(`${normalizedParent}${separator}`);
  }, [normalizePathForCompare]);

  // Build the shared cache key for the active pane. Prefer the last connected
  // host (which includes session-time overrides), fall back to the vault hosts list.
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const getActivePaneCacheKey = useCallback((side: "left" | "right", hostId: string, connectionId?: string): string => {
    // Prefer the per-connection cache key — it's set at connect time and
    // correctly identifies the endpoint even when multiple tabs share the
    // same hostId with different session-time overrides.
    if (connectionId) {
      const perConnKey = connectionCacheKeyMapRef.current.get(connectionId);
      if (perConnKey) return perConnKey;
    }
    // Fallback: lastConnectedHostRef (per-side, may be stale for multi-tab)
    const connHost = lastConnectedHostRef.current[side];
    if (connHost && connHost !== "local" && connHost.id === hostId) {
      return buildCacheKey(connHost.id, connHost.hostname, connHost.port, connHost.protocol, connHost.sftpSudo, connHost.username);
    }
    // Fall back to vault host
    const host = hostsRef.current.find(h => h.id === hostId);
    if (host) {
      return buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username);
    }
    return hostId;
  }, [connectionCacheKeyMapRef, lastConnectedHostRef]);

  // Track the latest navigation request ID per tab, so we can distinguish
  // whether a superseded request was superseded by the same tab or a different tab.
  const tabNavSeqRef = useRef(new Map<string, number>());

  // Track the last confirmed (successfully loaded) state per tab, so that
  // restore-on-error/supersede always reverts to a known-good state rather
  // than an intermediate optimistic state from another in-flight navigation.
  // Includes connectionId so stale entries from a previous host are ignored.
  const lastConfirmedRef = useRef(
    new Map<string, { connectionId: string; path: string; files: SftpFileEntry[]; selectedFiles: Set<string> }>(),
  );

  const navigateTo = useCallback(
    async (
      side: "left" | "right",
      path: string,
      options?: { force?: boolean; tabId?: string },
    ) => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      // When tabId is specified, target that specific tab instead of the active one.
      // This allows refreshing a background tab (e.g. after a transfer completes
      // while focus has switched to another host).
      const targetTabId = options?.tabId ?? sideTabs.activeTabId;
      const pane = options?.tabId
        ? sideTabs.tabs.find((t) => t.id === options.tabId) ?? null
        : getActivePane(side);

      if (!pane?.connection || !targetTabId) {
        return;
      }

      const connectionId = pane.connection.id;
      const requestId = ++navSeqRef.current[side];
      const cacheKey = makeCacheKey(connectionId, path, pane.filenameEncoding);
      const cached = options?.force
        ? undefined
        : dirCacheRef.current.get(cacheKey);

      if (
        cached &&
        Date.now() - cached.timestamp < dirCacheTtlMs &&
        cached.files
      ) {
        tabNavSeqRef.current.set(targetTabId, requestId);
        lastConfirmedRef.current.set(targetTabId, {
          connectionId,
          path,
          files: cached.files,
          selectedFiles: EMPTY_SET,
        });
        updateTab(side, targetTabId, (prev) => ({
          ...prev,
          connection: prev.connection
            ? { ...prev.connection, currentPath: path }
            : null,
          files: cached.files,
          loading: false,
          error: null,
          selectedFiles: EMPTY_SET,
        }));
        if (!pane.connection.isLocal) {
          // Use hostId as the shared cache key — this is safe because the
          // shared cache is a best-effort optimization and hostId uniquely
          // identifies the connection in the common case. Session-time
          // overrides create separate connections with distinct cache keys
          // at the connect() layer.
          setSharedRemoteHostCache(getActivePaneCacheKey(side, pane.connection.hostId, pane.connection.id), {
            path,
            homeDir: pane.connection.homeDir ?? path,
            files: cached.files,
            filenameEncoding: pane.filenameEncoding,
          });
        }
        return;
      }

      // Re-seed confirmed state whenever the pane is settled (not loading), or
      // when the connection has changed. This captures post-mutation state from
      // optimistic updates (e.g. deleteFilesAtPath) so that a failed refresh
      // doesn't resurrect deleted items.
      const existing = lastConfirmedRef.current.get(targetTabId);
      if (!existing || existing.connectionId !== connectionId || !pane.loading) {
        lastConfirmedRef.current.set(targetTabId, {
          connectionId,
          path: pane.connection.currentPath,
          files: pane.files,
          selectedFiles: pane.selectedFiles,
        });
      }
      const confirmed = lastConfirmedRef.current.get(targetTabId)!;
      const previousPath = confirmed.path;
      const previousFiles = confirmed.files;
      const previousSelection = confirmed.selectedFiles;
      tabNavSeqRef.current.set(targetTabId, requestId);
      // Keep existing files visible during loading — the loading overlay
      // (pointer-events-none) prevents interaction. This avoids blanking a tab
      // that gets superseded by another tab navigating on the same side.
      updateTab(side, targetTabId, (prev) => ({
        ...prev,
        connection: prev.connection
          ? { ...prev.connection, currentPath: path }
          : null,
        selectedFiles: EMPTY_SET,
        loading: true,
        error: null,
      }));

      try {
        let files: SftpFileEntry[];

        if (pane.connection.isLocal) {
          files = await listLocalFiles(path);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            clearCacheForConnection(pane.connection.id);
            // For background tabs (explicit tabId), update that tab directly
            // instead of handleSessionError which targets the active tab.
            if (options?.tabId) {
              updateTab(side, targetTabId, (prev) => ({
                ...prev,
                error: "sftp.error.sessionLost",
                loading: false,
              }));
            } else {
              handleSessionError(side, new Error("SFTP session lost"));
            }
            return;
          }

          try {
            files = await listRemoteFiles(sftpId, path, pane.filenameEncoding);
          } catch (err) {
            if (isSessionError(err)) {
              sftpSessionsRef.current.delete(pane.connection.id);
              clearCacheForConnection(pane.connection.id);
              if (options?.tabId) {
                updateTab(side, targetTabId, (prev) => ({
                  ...prev,
                  error: "sftp.error.sessionLost",
                  loading: false,
                }));
              } else {
                handleSessionError(side, err as Error);
              }
              return;
            }
            throw err as Error;
          }
        }

        if (navSeqRef.current[side] !== requestId) {
          // Side-level sequence was bumped by another tab's navigation or
          // a connect/disconnect. Check if THIS tab's request is still current.
          if (tabNavSeqRef.current.get(targetTabId) !== requestId) {
            // This tab also has a newer navigation — drop completely.
            return;
          }
          // Side was superseded by another tab, but this tab's request is
          // still current. The fetched files are valid — fall through to
          // apply them instead of restoring previousPath.
        }

        dirCacheRef.current.set(cacheKey, {
          files,
          timestamp: Date.now(),
        });

        lastConfirmedRef.current.set(targetTabId, {
          connectionId,
          path,
          files,
          selectedFiles: EMPTY_SET,
        });

        updateTab(side, targetTabId, (prev) => ({
          ...prev,
          connection: prev.connection
            ? { ...prev.connection, currentPath: path }
            : null,
          files,
          loading: false,
          selectedFiles: EMPTY_SET,
        }));
        if (!pane.connection.isLocal) {
          setSharedRemoteHostCache(getActivePaneCacheKey(side, pane.connection.hostId, pane.connection.id), {
            path,
            homeDir: pane.connection.homeDir ?? path,
            files,
            filenameEncoding: pane.filenameEncoding,
          });
        }
      } catch (err) {
        if (navSeqRef.current[side] !== requestId) {
          if (tabNavSeqRef.current.get(targetTabId) !== requestId) {
            return;
          }
          // Side superseded by another tab, but this tab's request is
          // current — fall through to show the error on this tab.
        }
        updateTab(side, targetTabId, (prev) => {
          if (prev.connection?.id !== connectionId) {
            return prev;
          }
          return {
            ...prev,
            connection: { ...prev.connection, currentPath: previousPath },
            files: previousFiles,
            selectedFiles: previousSelection,
            error:
              err instanceof Error ? err.message : "Failed to list directory",
            loading: false,
          };
        });
      }
    },
    [
      getActivePane,
      getActivePaneCacheKey,
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
      handleSessionError,
      isSessionError,
    ],
  );

  const refresh = useCallback(
    async (side: "left" | "right", options?: { tabId?: string }) => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const pane = options?.tabId
        ? sideTabs.tabs.find((t) => t.id === options.tabId) ?? null
        : getActivePane(side);
      if (pane?.connection) {
        const hasRemoteSession = pane.connection.isLocal || sftpSessionsRef.current.has(pane.connection.id);
        if (!hasRemoteSession) {
          if (options?.tabId) return;
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
          return;
        }
        await navigateTo(side, pane.connection.currentPath, { force: true, tabId: options?.tabId });
      } else if (!pane?.connection && pane?.error) {
        // For background tabs, don't trigger reconnection (it operates on
        // the active tab). Just leave the error state for the user to see
        // when they switch back to that tab.
        if (options?.tabId) return;
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
    [getActivePane, leftTabsRef, rightTabsRef, navigateTo, updateActiveTab, lastConnectedHostRef, reconnectingRef, sftpSessionsRef],
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
      const pane = getActivePane(side);

      if (!pane?.connection) {
        return;
      }

      if (entry.name === "..") {
        const currentPath = pane.connection.currentPath;
        const isAtRoot = currentPath === "/" || isWindowsRoot(currentPath);
        if (!isAtRoot) {
          const parentPath = getParentPath(currentPath);
          await navigateTo(side, parentPath);
        }
        return;
      }

      if (isNavigableDirectory(entry)) {
        const newPath = joinPath(pane.connection.currentPath, entry.name);
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
    updateActiveTab(side, (prev) => ({ ...prev, selectedFiles: EMPTY_SET }));
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

  const createDirectoryAtPath = useCallback(
    async (side: "left" | "right", path: string, name: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const fullPath = joinPath(path, name);

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
        if (pane.connection.currentPath === path) {
          await refresh(side);
        }
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

  const createDirectory = useCallback(
    async (side: "left" | "right", name: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;
      await createDirectoryAtPath(side, pane.connection.currentPath, name);
    },
    [createDirectoryAtPath, getActivePane],
  );

  const createFileAtPath = useCallback(
    async (side: "left" | "right", path: string, name: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const fullPath = joinPath(path, name);

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
        if (pane.connection.currentPath === path) {
          await refresh(side);
        }
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
      await createFileAtPath(side, pane.connection.currentPath, name);
    },
    [createFileAtPath, getActivePane],
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

  // Rename using a full source path (for tree view where entryPath is already absolute).
  // newName is still a basename; the new path is built as joinPath(parent, newName).
  const renameFileAtPath = useCallback(
    async (side: "left" | "right", oldPath: string, newName: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection) return;

      const parentPath = getParentPath(oldPath);
      const newPath = joinPath(parentPath, newName);

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
        if (pane.connection.currentPath === parentPath) {
          await refresh(side);
        }
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

  const moveEntriesToPath = useCallback(
    async (side: "left" | "right", sourcePaths: string[], targetPath: string) => {
      const pane = getActivePane(side);
      if (!pane?.connection || sourcePaths.length === 0) return;

      const uniqueSources = Array.from(new Set(sourcePaths.filter(Boolean)));
      const filteredSources = uniqueSources
        .sort((a, b) => a.length - b.length)
        .filter((path, index, arr) =>
          !arr.slice(0, index).some((otherPath) => isSamePath(path, otherPath) || isDescendantPath(path, otherPath)),
        );

      const movableSources = filteredSources.filter((sourcePath) => {
        if (isSamePath(sourcePath, targetPath)) return false;
        if (isDescendantPath(targetPath, sourcePath)) return false;
        const destinationPath = joinPath(targetPath, getFileName(sourcePath));
        return !isSamePath(destinationPath, sourcePath);
      });

      if (movableSources.length === 0) return;

      const sourceParentNames = new Map<string, string[]>();
      for (const sourcePath of movableSources) {
        const parentPath = getParentPath(sourcePath);
        const names = sourceParentNames.get(parentPath) ?? [];
        names.push(getFileName(sourcePath));
        sourceParentNames.set(parentPath, names);
      }

      try {
        if (pane.connection.isLocal) {
          const renameLocalFile = netcattyBridge.get()?.renameLocalFile;
          if (!renameLocalFile) {
            throw new Error("Local rename unavailable");
          }
          for (const sourcePath of movableSources) {
            const destinationPath = joinPath(targetPath, getFileName(sourcePath));
            await renameLocalFile(sourcePath, destinationPath);
          }
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          const renameSftp = netcattyBridge.get()?.renameSftp;
          if (!renameSftp) {
            throw new Error("SFTP rename unavailable");
          }
          for (const sourcePath of movableSources) {
            const destinationPath = joinPath(targetPath, getFileName(sourcePath));
            await renameSftp(sftpId, sourcePath, destinationPath, pane.filenameEncoding);
          }
        }
        clearCacheForConnection(pane.connection.id);
        const currentPath = pane.connection.currentPath;
        const sourceParents = Array.from(sourceParentNames.keys());
        const currentPathAffected =
          sourceParents.some((path) => isSamePath(path, currentPath)) ||
          isSamePath(targetPath, currentPath);

        if (currentPathAffected) {
          await refresh(side);
        } else {
          updateActiveTab(side, (prev) => {
            if (!prev.connection || prev.connection.id !== pane.connection?.id) {
              return prev;
            }

            const namesInCurrentPath = sourceParentNames.get(prev.connection.currentPath);
            if (!namesInCurrentPath || namesInCurrentPath.length === 0) {
              return prev;
            }

            const removeSet = new Set(namesInCurrentPath);
            const nextSelection = new Set(prev.selectedFiles);
            for (const name of removeSet) {
              nextSelection.delete(name);
            }

            return {
              ...prev,
              files: prev.files.filter((file) => !removeSet.has(file.name)),
              selectedFiles: nextSelection,
            };
          });
        }
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [clearCacheForConnection, getActivePane, handleSessionError, isDescendantPath, isSamePath, isSessionError, refresh, sftpSessionsRef, updateActiveTab],
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
    createDirectoryAtPath,
    createFile,
    createFileAtPath,
    deleteFiles,
    deleteFilesAtPath,
    renameFile,
    renameFileAtPath,
    moveEntriesToPath,
    changePermissions,
  };
};
