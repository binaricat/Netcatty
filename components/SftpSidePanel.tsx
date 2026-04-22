/**
 * SftpSidePanel - SFTP file browser rendered as a resizable side panel
 *
 * Reuses SftpView's components (SftpPaneView, SftpContextProvider, etc.)
 * to provide a unified SFTP experience. Renders a single pane (left side only).
 *
 * IMPORTANT: Does NOT use the global activeTabStore to avoid conflicts with
 * the main SftpView tab. Instead manages pane visibility internally.
 *
 * Used in TerminalLayer to provide SFTP alongside terminal sessions.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatHostPort } from "../domain/host";
import { useI18n } from "../application/i18n/I18nProvider";
import { useSftpState } from "../application/state/useSftpState";
import { registerEditorSftpWriterScoped } from "../application/state/editorSftpBridge";
import { editorTabStore } from "../application/state/editorTabStore";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
import { getParentPath } from "../application/state/sftp/utils";
import { buildCacheKey } from "../application/state/sftp/sharedRemoteHostCache";
import { logger } from "../lib/logger";
import type { DropEntry } from "../lib/sftpFileUtils";
import { Host, Identity, SSHKey } from "../types";
import type { TransferTask } from "../types";
import { toast } from "./ui/toast";
import { DistroAvatar } from "./DistroAvatar";

import { SftpPaneView } from "./sftp/SftpPaneView";
import { SftpOverlays } from "./sftp/SftpOverlays";
import { SftpTransferQueue } from "./sftp/SftpTransferQueue";
import { SftpContextProvider } from "./sftp";
import { useSftpViewPaneCallbacks } from "./sftp/hooks/useSftpViewPaneCallbacks";
import { useSftpViewTabs } from "./sftp/hooks/useSftpViewTabs";
import { useSftpKeyboardShortcuts } from "./sftp/hooks/useSftpKeyboardShortcuts";
import { sftpFocusStore } from "./sftp/hooks/useSftpFocusedPane";
import { keepOnlyPaneSelections } from "./sftp/hooks/selectionScope";
import { KeyBinding, HotkeyScheme } from "../domain/models";

interface SftpSidePanelProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  updateHosts: (hosts: Host[]) => void;
  sftpDefaultViewMode: "list" | "tree";
  /** The host to connect to (follows focused terminal) */
  activeHost: Host | null;
  initialLocation?: { hostId: string; path: string } | null;
  showWorkspaceHostHeader?: boolean;
  isVisible?: boolean;
  renderOverlays?: boolean;
  pendingUpload?: {
    requestId: string;
    hostId: string;
    connectionKey: string;
    targetPath?: string;
    entries: DropEntry[];
  } | null;
  onPendingUploadHandled?: (requestId: string) => void;
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  onGetTerminalCwd?: () => Promise<string | null>;
}

const SftpSidePanelInner: React.FC<SftpSidePanelProps> = ({
  hosts,
  keys,
  identities,
  updateHosts,
  sftpDefaultViewMode,
  activeHost,
  initialLocation,
  showWorkspaceHostHeader = false,
  isVisible = true,
  renderOverlays = true,
  pendingUpload = null,
  onPendingUploadHandled,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
  onGetTerminalCwd,
}) => {
  const { t } = useI18n();

  const fileWatchHandlers = useMemo(() => ({
    onFileWatchSynced: (payload: { remotePath: string }) => {
      const fileName = payload.remotePath.split('/').pop() || payload.remotePath;
      toast.success(t('sftp.autoSync.success', { fileName }));
      logger.info("[SFTP] File auto-synced to remote", payload);
    },
    onFileWatchError: (payload: { error: string }) => {
      toast.error(t('sftp.autoSync.error', { error: payload.error }));
      logger.error("[SFTP] File auto-sync failed", payload);
    },
  }), [t]);

  const sftpOptions = useMemo(() => ({
    ...fileWatchHandlers,
    useCompressedUpload: sftpUseCompressedUpload,
    defaultShowHiddenFiles: sftpShowHiddenFiles,
    autoConnectLocalOnMount: false,
  }), [fileWatchHandlers, sftpUseCompressedUpload, sftpShowHiddenFiles]);

  const sftp = useSftpState(hosts, keys, identities, sftpOptions);
  const {
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    listLocalDir,
  } = useSftpBackend();

  const sftpRef = useRef(sftp);
  sftpRef.current = sftp;

  // Register this instance's writeTextFileByConnection with the editor bridge
  // so editor tabs promoted from SFTP files opened in a terminal side panel
  // can still route saves through this useSftpState.
  //
  // Intentionally no deps — go through sftpRef so SFTP state churn (transfers,
  // tab switches, listings) doesn't make this unregister+reregister on every
  // re-render.
  useEffect(() => {
    return registerEditorSftpWriterScoped((connectionId, expectedHostId, filePath, content, encoding) =>
      sftpRef.current.writeTextFileByConnection(connectionId, expectedHostId, filePath, content, encoding),
    );
  }, []);

  // When this side panel unmounts (its hosting terminal tab was closed) we
  // force-close any editor tabs bound to connections this panel owned — the
  // save channel is gone with the SFTP session and there's no way to recover
  // it. Dirty state is dropped intentionally; the user closed the terminal
  // knowing the file was open.
  //
  // Collect every connection id across all left/right tabs — the panel can
  // host multiple SFTP tabs per side, and an editor tab promoted from an
  // inactive-pane tab would otherwise be stranded by the unmount.
  useEffect(() => {
    return () => {
      const s = sftpRef.current;
      if (!s) return;
      const owned = new Set<string>();
      for (const tab of s.leftTabs?.tabs ?? []) {
        const id = tab.connection?.id;
        if (id) owned.add(id);
      }
      for (const tab of s.rightTabs?.tabs ?? []) {
        const id = tab.connection?.id;
        if (id) owned.add(id);
      }
      if (owned.size === 0) return;
      editorTabStore.forceCloseBySessions([...owned]);
    };
  }, []);

  const behaviorRef = useRef(sftpDoubleClickBehavior);
  behaviorRef.current = sftpDoubleClickBehavior;

  const autoSyncRef = useRef(sftpAutoSync);
  autoSyncRef.current = sftpAutoSync;
  const panelRootRef = useRef<HTMLDivElement>(null);
  const dialogActionScopeIdRef = useRef(`sftp-side-panel:${crypto.randomUUID()}`);
  const [hasPaneFocus, setHasPaneFocus] = useState(false);

  useSftpKeyboardShortcuts({
    keyBindings,
    hotkeyScheme,
    sftpRef,
    dialogActionScopeId: dialogActionScopeIdRef.current,
    isActive: isVisible && hasPaneFocus,
  });

  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();
  const getOpenerForFileRef = useRef(getOpenerForFile);
  getOpenerForFileRef.current = getOpenerForFile;

  const handleToggleHiddenFiles = useCallback((paneId: string) => {
    const pane = sftpRef.current.leftTabs.tabs.find((tab) => tab.id === paneId);
    if (!pane) return;
    sftpRef.current.setShowHiddenFiles("left", paneId, !pane.showHiddenFiles);
  }, []);

  const syncFocusedSelection = useCallback((tabId: string | null) => {
    if (tabId) {
      keepOnlyPaneSelections(sftpRef.current, { side: "left", tabId });
      return;
    }
    keepOnlyPaneSelections(sftpRef.current, null);
  }, []);

  const handlePaneFocus = useCallback(() => {
    sftpFocusStore.setFocusedSide("left");
    setHasPaneFocus(true);
    syncFocusedSelection(sftpRef.current.getActiveTabId("left"));
  }, [syncFocusedSelection]);

  // NOTE: We intentionally do NOT sync to activeTabStore here.
  // activeTabStore is a global singleton shared with SftpView.
  // Writing to it here would corrupt SftpView's left pane visibility.

  useEffect(() => {
    if (!isVisible) {
      setHasPaneFocus(false);
      syncFocusedSelection(null);
    }
  }, [isVisible, syncFocusedSelection]);

  useEffect(() => {
    if (!isVisible) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const elementTarget = target instanceof Element ? target : null;
      const isPortalInteraction = !!elementTarget?.closest(
        '#netcatty-context-menu-root, [role="dialog"], [data-radix-popper-content-wrapper]',
      );
      if (isPortalInteraction) {
        return;
      }

      if (panelRootRef.current?.contains(target)) {
        sftpFocusStore.setFocusedSide("left");
        setHasPaneFocus(true);
        syncFocusedSelection(sftpRef.current.getActiveTabId("left"));
      } else {
        setHasPaneFocus(false);
        syncFocusedSelection(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isVisible, syncFocusedSelection]);

  const {
    leftCallbacks,
    rightCallbacks,
    dragCallbacks,
    draggedFiles,
    permissionsState,
    setPermissionsState,
    showTextEditor,
    setShowTextEditor,
    textEditorTarget,
    setTextEditorTarget,
    textEditorContent,
    setTextEditorContent,
    showFileOpenerDialog,
    setShowFileOpenerDialog,
    fileOpenerTarget,
    setFileOpenerTarget,
    handleSaveTextFile,
    onPromoteToTab,
    handleFileOpenerSelect,
    handleSelectSystemApp,
  } = useSftpViewPaneCallbacks({
    sftpRef,
    behaviorRef,
    autoSyncRef,
    getOpenerForFileRef,
    setOpenerForExtension,
    t,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    getSftpIdForConnection: sftp.getSftpIdForConnection,
    listLocalFiles: listLocalDir,
  });

  const {
    leftPanes,
    showHostPickerLeft,
    showHostPickerRight,
    hostSearchLeft,
    hostSearchRight,
    setShowHostPickerLeft,
    setShowHostPickerRight,
    setHostSearchLeft,
    setHostSearchRight,
    handleHostSelectLeft,
    handleHostSelectRight,
  } = useSftpViewTabs({ sftp, sftpRef });

  // Auto-connect when activeHost changes.
  // Uses sftpRef to avoid re-triggering on every sftp state change.
  const connectedKeyRef = useRef<string | null>(null);
  // Store the Host object used for the current connection so the header
  // can show session-time overrides even during deferred host switches.
  const connectedHostObjRef = useRef<Host | null>(null);
  const lastAppliedInitialLocationKeyRef = useRef<string | null>(null);
  const handledPendingUploadIdRef = useRef<string | null>(null);
  // Maps tab IDs to the connectionKey used to create them, so we can
  // correctly identify tabs when the same host ID has different overrides.
  const tabConnectionKeyMapRef = useRef<Map<string, string>>(new Map());

  // NOTE: We intentionally do NOT reset lastAppliedInitialLocationKeyRef on
  // visibility changes. When the user switches terminal tabs, the panel
  // toggles isVisible but should preserve its navigation state (the user may
  // have navigated away from initialLocation). When the panel is truly
  // closed, the component unmounts and all refs are naturally reset.

  // Navigate SFTP to the terminal's current working directory
  const handleGoToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd) return;
    const cwd = await onGetTerminalCwd();
    if (cwd) {
      sftpRef.current.navigateTo("left", cwd);
    }
  }, [onGetTerminalCwd]);

  // Track whether there's active work that should block connection switching.
  // Computed outside the effect so it can be in the dependency array.
  // Block host-following while any connection-sensitive interactive UI is
  // active: text editor, permissions dialog, file-opener dialog, or
  // auto-synced external file watches.
  // Note: transfers are NOT included here — they run on their own sftpId
  // independent of the active tab, and forceNewTab preserves old connections.
  const hasActiveWork = showTextEditor || !!permissionsState || showFileOpenerDialog
    || (sftp.activeFileWatchCountRef?.current ?? 0) > 0;

  useEffect(() => {
    if (!activeHost) return;

    const s = sftpRef.current;

    // Serial terminals don't support SFTP — disconnect any existing
    // connection (remote or local) so the panel doesn't remain bound to
    // a previous host.
    const proto = activeHost.protocol;
    if (proto === 'serial' || activeHost.id?.startsWith('serial-')) {
      // Serial terminals don't support SFTP. Just clear the tracked
      // connection key so switching back to a remote terminal will
      // trigger auto-connect. Don't disconnect existing tabs — they
      // may be reused when focus returns.
      connectedKeyRef.current = null;
      return;
    }
    // Local terminals connect to the local file browser
    if (proto === 'local' || activeHost.id?.startsWith('local-')) {
      if (hasActiveWork) return;
      const leftConn = s.leftPane.connection;
      if (leftConn?.isLocal) {
        // Already connected locally
        connectedKeyRef.current = "local";
        return;
      }
      // Check for an existing local tab to reuse
      const existingLocalTab = s.leftTabs.tabs.find((tab) =>
        tab.connection?.isLocal && tab.connection.status === "connected",
      );
      if (existingLocalTab) {
        s.selectTab("left", existingLocalTab.id);
        connectedKeyRef.current = "local";
        return;
      }
      connectedKeyRef.current = "local";
      // Preserve existing remote tab when switching to local
      const needsNewTab = !!(leftConn && leftConn.status === "connected");
      if (needsNewTab) {
        s.connect("left", "local", { forceNewTab: true });
      } else if (leftConn) {
        // Await disconnect before connecting locally to avoid the async
        // disconnect wiping out the fresh local connection.
        void s.disconnect("left").then(() => s.connect("left", "local"));
      } else {
        s.connect("left", "local");
      }
      return;
    }
    // Build a connection key that accounts for session-time overrides
    // (same host ID may have different port/protocol in different workspace panes).
    // Uses buildCacheKey to stay consistent with the key recorded on upload tasks.
    const connectionKey = buildCacheKey(activeHost.id, activeHost.hostname, activeHost.port, activeHost.protocol, activeHost.sftpSudo, activeHost.username);
    if (connectedKeyRef.current === connectionKey) return;

    // Don't switch connections while transfers or editor are active
    if (hasActiveWork) return;
    logger.info("[SftpSidePanel] Auto-connect triggered", {
      hostId: activeHost.id,
      hostLabel: activeHost.label,
      protocol: activeHost.protocol,
      hostname: activeHost.hostname,
    });

    // Check if an existing SFTP tab matches this exact endpoint.
    // We track which connectionKey was used to create each tab so that
    // tabs for the same host ID with different session-time overrides
    // (port/protocol) are not incorrectly reused.
    const tabs = s.leftTabs.tabs;
    const existingTab = tabs.find((tab) => {
      if (!tab.connection || tab.connection.hostId !== activeHost.id) return false;
      // Don't reuse errored tabs — they need a fresh connection
      if (tab.connection.status === "error" || tab.connection.status === "disconnected") return false;
      return tabConnectionKeyMapRef.current.get(tab.id) === connectionKey;
    });
    if (existingTab) {
      s.selectTab("left", existingTab.id);
      connectedKeyRef.current = connectionKey;
      connectedHostObjRef.current = activeHost;
      return;
    }

    // Create a new tab when there's already an active connection, so the
    // previous tab is preserved for instant switching on focus change.
    // This covers both different hosts AND same host with different
    // session-time overrides (port/protocol), preventing the old SFTP
    // session from being closed while it may have in-flight transfers.
    const currentConn = s.leftPane.connection;
    const needsNewTab = !!(currentConn && currentConn.status === "connected");

    connectedKeyRef.current = connectionKey;
    connectedHostObjRef.current = activeHost;
    s.connect("left", activeHost, {
      ...(needsNewTab ? { forceNewTab: true } : undefined),
      onTabCreated: (tabId) => {
        tabConnectionKeyMapRef.current.set(tabId, connectionKey);
      },
    });
  }, [activeHost, hasActiveWork]); // Re-evaluate when work finishes so deferred switch can proceed

  // Clear the remembered connection key when the pane disconnects or the
  // session is lost, so re-opening SFTP for the same terminal reconnects.
  // Also reset the file-watch counter — watches are bound to the SFTP session,
  // so they stop when the session disconnects.
  useEffect(() => {
    const connection = sftp.leftPane.connection;
    if (!connection || connection.status === "error" || connection.status === "disconnected") {
      connectedKeyRef.current = null;
      if (sftp.activeFileWatchCountRef) {
        sftp.activeFileWatchCountRef.current = 0;
      }
    }
  }, [sftp.leftPane.connection, sftp.leftPane.connection?.status, sftp.activeFileWatchCountRef]);

  useEffect(() => {
    if (!activeHost || !initialLocation) return;
    if (initialLocation.hostId !== activeHost.id || !initialLocation.path) return;

    const activePane = sftpRef.current.leftPane;
    const connection = activePane.connection;
    if (!connection || connection.isLocal || connection.hostId !== activeHost.id) return;
    if (connection.status !== "connected") return;

    // Include full endpoint key so that same-hostId sessions with
    // different overrides each get their initial location applied.
    const locationKey = `${connectedKeyRef.current}:${initialLocation.path}`;
    if (lastAppliedInitialLocationKeyRef.current === locationKey) return;

    if (connection.currentPath === initialLocation.path) {
      lastAppliedInitialLocationKeyRef.current = locationKey;
      return;
    }

    lastAppliedInitialLocationKeyRef.current = locationKey;
    sftpRef.current.navigateTo("left", initialLocation.path);
  }, [
    activeHost,
    initialLocation,
    sftp.leftPane,
  ]);

  useEffect(() => {
    if (!pendingUpload || !activeHost) return;
    if (handledPendingUploadIdRef.current === pendingUpload.requestId) return;
    if (pendingUpload.hostId !== activeHost.id) return;

    const activePane = sftp.leftPane;
    const connection = activePane.connection;
    if (!connection || connection.isLocal || connection.hostId !== activeHost.id) return;
    if (connection.status !== "connected") return;

    handledPendingUploadIdRef.current = pendingUpload.requestId;

    const runUpload = async () => {
      try {
        const results = await sftpRef.current.uploadExternalEntries("left", pendingUpload.entries, {
          targetPath: pendingUpload.targetPath,
        });
        if (results.some((result) => result.cancelled)) {
          toast.info(t("sftp.upload.cancelled"), "SFTP");
          return;
        }

        const failCount = results.filter((result) => !result.success && !result.cancelled).length;
        const successCount = results.filter((result) => result.success).length;

        if (failCount === 0) {
          const message =
            successCount === 1
              ? `${t("sftp.upload")}: ${results[0]?.fileName ?? ""}`
              : `${t("sftp.uploadFiles")}: ${successCount}`;
          toast.success(message, "SFTP");
        } else {
          const failedFiles = results.filter((result) => !result.success && !result.cancelled);
          failedFiles.forEach((failed) => {
            const errorMsg = failed.error ? ` - ${failed.error}` : "";
            toast.error(
              `${t("sftp.error.uploadFailed")}: ${failed.fileName}${errorMsg}`,
              "SFTP",
            );
          });
        }
      } catch (error) {
        logger.error("[SftpSidePanel] Failed to upload dropped files:", error);
        handledPendingUploadIdRef.current = null;
        toast.error(
          error instanceof Error ? error.message : t("sftp.error.uploadFailed"),
          "SFTP",
        );
        return;
      } finally {
        onPendingUploadHandled?.(pendingUpload.requestId);
      }
    };

    void runUpload();
  }, [
    activeHost,
    onPendingUploadHandled,
    pendingUpload,
    sftp.leftPane,
    t,
  ]);

  const MAX_VISIBLE_TRANSFERS = 5;
  const visibleTransfers = useMemo(() => {
    const connection = sftp.leftPane.connection;
    if (!connection) return [];
    // Filter transfers to those relevant to the active connection's host,
    // so workspace focus switches don't show transfers from other hosts.
    const filtered = sftp.transfers.filter((t) => {
      if (t.parentTaskId) return false; // Child tasks rendered by SftpTransferQueue
      if (connection.isLocal) {
        return t.sourceConnectionId === connection.id || t.targetConnectionId === connection.id;
      }
      return t.targetHostId === connection.hostId || t.sourceConnectionId === connection.id || t.targetConnectionId === connection.id;
    });
    return [...filtered].reverse().slice(0, MAX_VISIBLE_TRANSFERS);
  }, [sftp.transfers, sftp.leftPane.connection]);

  const handleRevealTransferTarget = useCallback(
    async (task: TransferTask) => {
      const connection = sftpRef.current.leftPane.connection;
      if (!connection || connection.isLocal) return;

      const revealPath = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);
      await sftpRef.current.navigateTo("left", revealPath, { force: true });
    },
    [],
  );

  const canRevealTransferTarget = useCallback(
    (task: TransferTask) => {
      if (task.status !== "completed") return false;
      if (task.direction !== "upload" && task.direction !== "remote-to-remote") return false;

      const connection = sftp.leftPane.connection;
      if (!connection || connection.isLocal) return false;

      if (task.targetHostId) {
        if (connection.hostId !== task.targetHostId) return false;
        // If the transfer recorded a full endpoint key, use it to
        // distinguish same-hostId uploads with different session overrides.
        if (task.targetConnectionKey) {
          return connectedKeyRef.current === task.targetConnectionKey;
        }
        return true;
      }

      return connection.id === task.targetConnectionId;
    },
    [sftp.leftPane.connection],
  );

  // When the auto-connect effect defers a switch (active transfers or open
  // editor), the panel still operates on the current connection, not
  // activeHost.  Use the connected host for the header so the label matches
  // what browse/edit/delete actions actually target.
  const displayHost = useMemo(() => {
    const conn = sftp.leftPane.connection;
    if (conn && !conn.isLocal) {
      // Prefer the stored Host object from connect time — it preserves
      // session-time overrides that the vault host may lack.
      if (connectedHostObjRef.current && connectedHostObjRef.current.id === conn.hostId) {
        return connectedHostObjRef.current;
      }
      return hosts.find((h) => h.id === conn.hostId) ?? activeHost;
    }
    return activeHost;
  }, [sftp.leftPane.connection, hosts, activeHost]);

  // Determine the active pane to render (without using global activeTabStore)
  const activeLeftPaneId = sftp.leftTabs.activeTabId;

  return (
    <SftpContextProvider
      hosts={hosts}
      updateHosts={updateHosts}
      draggedFiles={draggedFiles}
      dragCallbacks={dragCallbacks}
      leftCallbacks={leftCallbacks}
      rightCallbacks={rightCallbacks}
    >
      <div
        ref={panelRootRef}
        className="h-full flex flex-col bg-background overflow-hidden"
        style={isVisible ? undefined : { display: "none" }}
        aria-hidden={!isVisible}
        onClick={handlePaneFocus}
      >
        {showWorkspaceHostHeader && displayHost && (
          <div className="shrink-0 border-b border-border/50 bg-muted/20 px-3 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <DistroAvatar
                host={displayHost}
                fallback={displayHost.label.slice(0, 2).toUpperCase()}
                size="sm"
                className="h-5 w-5 rounded-sm shrink-0"
              />
              <div
                className="min-w-0 flex-1 max-w-[calc(100%-1.75rem)] text-[11px] leading-5 truncate"
                title={`${displayHost.label} · ${(displayHost.username || "root")}@${formatHostPort(displayHost.hostname, displayHost.port || 22)}`}
              >
                <span className="font-medium">
                  {displayHost.label}
                </span>
                <span className="mx-1 text-muted-foreground">·</span>
                <span className="font-mono text-muted-foreground">
                  {(displayHost.username || "root")}@{displayHost.hostname}:{displayHost.port || 22}
                </span>
              </div>
            </div>
          </div>
        )}
        {/* File browser pane - render only the active pane */}
        <div className="relative flex-1 min-h-0">
          {leftPanes.map((pane, idx) => {
            // Manage visibility locally instead of via activeTabStore
            const isActive = activeLeftPaneId
              ? pane.id === activeLeftPaneId
              : idx === 0;
            if (!isActive) return null;

            return (
              <div key={pane.id} className="absolute inset-0 z-10">
                <SftpPaneView
                  side="left"
                  pane={pane}
                  dialogActionScopeId={dialogActionScopeIdRef.current}
                  isPaneFocused={isVisible && hasPaneFocus}
                  sftpDefaultViewMode={sftpDefaultViewMode}
                  showHeader
                  showEmptyHeader
                  forceActive
                  onToggleShowHiddenFiles={() => handleToggleHiddenFiles(pane.id)}
                  onGoToTerminalCwd={onGetTerminalCwd ? handleGoToTerminalCwd : undefined}
                />
              </div>
            );
          })}
        </div>
        <SftpTransferQueue
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          allTransfers={sftp.transfers}
          canRevealTransferTarget={canRevealTransferTarget}
          onRevealTransferTarget={handleRevealTransferTarget}
        />
      </div>

      {renderOverlays && (
        <SftpOverlays
          hosts={hosts}
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          showTransferQueue={false}
          showHostPickerLeft={showHostPickerLeft}
          showHostPickerRight={showHostPickerRight}
          hostSearchLeft={hostSearchLeft}
          hostSearchRight={hostSearchRight}
          setShowHostPickerLeft={setShowHostPickerLeft}
          setShowHostPickerRight={setShowHostPickerRight}
          setHostSearchLeft={setHostSearchLeft}
          setHostSearchRight={setHostSearchRight}
          handleHostSelectLeft={handleHostSelectLeft}
          handleHostSelectRight={handleHostSelectRight}
          permissionsState={permissionsState}
          setPermissionsState={setPermissionsState}
          showTextEditor={showTextEditor}
          setShowTextEditor={setShowTextEditor}
          textEditorTarget={textEditorTarget}
          setTextEditorTarget={setTextEditorTarget}
          textEditorContent={textEditorContent}
          setTextEditorContent={setTextEditorContent}
          handleSaveTextFile={handleSaveTextFile}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          showFileOpenerDialog={showFileOpenerDialog}
          setShowFileOpenerDialog={setShowFileOpenerDialog}
          fileOpenerTarget={fileOpenerTarget}
          setFileOpenerTarget={setFileOpenerTarget}
          handleFileOpenerSelect={handleFileOpenerSelect}
          handleSelectSystemApp={handleSelectSystemApp}
          onPromoteToTab={onPromoteToTab}
          t={t}
        />
      )}
    </SftpContextProvider>
  );
};

const sidePanelAreEqual = (prev: SftpSidePanelProps, next: SftpSidePanelProps): boolean =>
  prev.hosts === next.hosts &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.updateHosts === next.updateHosts &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.activeHost === next.activeHost &&
  prev.showWorkspaceHostHeader === next.showWorkspaceHostHeader &&
  prev.isVisible === next.isVisible &&
  prev.renderOverlays === next.renderOverlays &&
  prev.pendingUpload?.requestId === next.pendingUpload?.requestId &&
  prev.onPendingUploadHandled === next.onPendingUploadHandled &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.keyBindings === next.keyBindings &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  prev.onGetTerminalCwd === next.onGetTerminalCwd &&
  prev.initialLocation?.hostId === next.initialLocation?.hostId &&
  prev.initialLocation?.path === next.initialLocation?.path;

export const SftpSidePanel = memo(SftpSidePanelInner, sidePanelAreEqual);
SftpSidePanel.displayName = "SftpSidePanel";
