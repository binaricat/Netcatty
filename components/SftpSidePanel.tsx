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

import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useSftpState } from "../application/state/useSftpState";
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

interface SftpSidePanelProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  updateHosts: (hosts: Host[]) => void;
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
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  onGetTerminalCwd?: () => Promise<string | null>;
}

const SftpSidePanelInner: React.FC<SftpSidePanelProps> = ({
  hosts,
  keys,
  identities,
  updateHosts,
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
  } = useSftpBackend();

  const sftpRef = useRef(sftp);
  sftpRef.current = sftp;

  const behaviorRef = useRef(sftpDoubleClickBehavior);
  behaviorRef.current = sftpDoubleClickBehavior;

  const autoSyncRef = useRef(sftpAutoSync);
  autoSyncRef.current = sftpAutoSync;

  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();
  const getOpenerForFileRef = useRef(getOpenerForFile);
  getOpenerForFileRef.current = getOpenerForFile;

  const handleToggleHiddenFiles = useCallback((paneId: string) => {
    const pane = sftpRef.current.leftTabs.tabs.find((tab) => tab.id === paneId);
    if (!pane) return;
    sftpRef.current.setShowHiddenFiles("left", paneId, !pane.showHiddenFiles);
  }, []);

  // NOTE: We intentionally do NOT sync to activeTabStore here.
  // activeTabStore is a global singleton shared with SftpView.
  // Writing to it here would corrupt SftpView's left pane visibility.

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
  const pendingConnectionKeyRef = useRef<string | null>(null);

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
  const hasActiveTransfers = useMemo(
    () => sftp.transfers.some((t) => t.status === "pending" || t.status === "transferring"),
    [sftp.transfers],
  );
  // Block host-following while any connection-sensitive UI or operation
  // is active: text editor, permissions dialog, file-opener dialog, or
  // auto-synced external file watches.
  const hasActiveWork = hasActiveTransfers || showTextEditor || !!permissionsState || showFileOpenerDialog
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

    // Create a new tab when there's already an active connection to a different
    // host, so the previous tab is preserved for instant switching on focus change.
    const currentConn = s.leftPane.connection;
    const needsNewTab = !!(currentConn && currentConn.status === "connected" && currentConn.hostId !== activeHost.id);

    connectedKeyRef.current = connectionKey;
    connectedHostObjRef.current = activeHost;
    // Store the pending key so the effect below can map it once the tab is created
    pendingConnectionKeyRef.current = connectionKey;
    s.connect("left", activeHost, needsNewTab ? { forceNewTab: true } : undefined);
  }, [activeHost, hasActiveWork]); // Re-evaluate when work finishes so deferred switch can proceed

  // Track the active tab's connectionKey after connect() creates or reuses it.
  // Watches both activeTabId (new tab) and connection status (reused tab reconnecting).
  useEffect(() => {
    const activeTabId = sftp.leftTabs.activeTabId;
    if (activeTabId && pendingConnectionKeyRef.current) {
      tabConnectionKeyMapRef.current.set(activeTabId, pendingConnectionKeyRef.current);
      pendingConnectionKeyRef.current = null;
    }
  }, [sftp.leftTabs.activeTabId, sftp.leftPane.connection?.status]);

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
  const visibleTransfers = useMemo(
    () => [...sftp.transfers].reverse().slice(0, MAX_VISIBLE_TRANSFERS),
    [sftp.transfers],
  );

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
        className="h-full flex flex-col bg-background overflow-hidden"
        style={isVisible ? undefined : { display: "none" }}
        aria-hidden={!isVisible}
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
                title={`${displayHost.label} · ${(displayHost.username || "root")}@${displayHost.hostname}:${displayHost.port || 22}`}
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
                  showHeader
                  showEmptyHeader
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
          showFileOpenerDialog={showFileOpenerDialog}
          setShowFileOpenerDialog={setShowFileOpenerDialog}
          fileOpenerTarget={fileOpenerTarget}
          setFileOpenerTarget={setFileOpenerTarget}
          handleFileOpenerSelect={handleFileOpenerSelect}
          handleSelectSystemApp={handleSelectSystemApp}
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
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  prev.onGetTerminalCwd === next.onGetTerminalCwd &&
  prev.initialLocation?.hostId === next.initialLocation?.hostId &&
  prev.initialLocation?.path === next.initialLocation?.path;

export const SftpSidePanel = memo(SftpSidePanelInner, sidePanelAreEqual);
SftpSidePanel.displayName = "SftpSidePanel";
