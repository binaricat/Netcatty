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
  const { showSaveDialog, startStreamTransfer } = useSftpBackend();

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
    loadingTextContent: _loadingTextContent,
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
    showSaveDialog,
    startStreamTransfer,
    getSftpIdForConnection: sftp.getSftpIdForConnection,
  });

  const {
    leftPanes,
    leftTabsInfo: _leftTabsInfo,
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
  const connectedHostIdRef = useRef<string | null>(null);
  const lastAppliedInitialLocationKeyRef = useRef<string | null>(null);
  const handledPendingUploadIdRef = useRef<string | null>(null);
  // Maps tab IDs to the connectionKey used to create them, so we can
  // correctly identify tabs when the same host ID has different overrides.
  const tabConnectionKeyMapRef = useRef<Map<string, string>>(new Map());
  const prevIsVisibleRef = useRef(isVisible);

  // Reset location guard when the panel is reopened so the terminal cwd
  // is re-applied even if it matches the previous session's path.
  useEffect(() => {
    if (isVisible && !prevIsVisibleRef.current) {
      lastAppliedInitialLocationKeyRef.current = null;
    }
    prevIsVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    if (!activeHost) return;
    // Don't attempt SFTP for local or serial terminals — disconnect any
    // existing remote connection so the panel doesn't remain bound to the
    // wrong host when focus moves to a non-SFTP pane.
    const proto = activeHost.protocol;
    if (proto === 'local' || proto === 'serial' || activeHost.id?.startsWith('local-') || activeHost.id?.startsWith('serial-')) {
      const s = sftpRef.current;
      const leftConn = s.leftPane.connection;
      if (leftConn && !leftConn.isLocal) {
        s.disconnect("left");
        connectedHostIdRef.current = null;
      }
      return;
    }
    // Build a connection key that accounts for session-time overrides
    // (same host ID may have different port/protocol in different workspace panes)
    const connectionKey = `${activeHost.id}:${activeHost.hostname}:${activeHost.port ?? ''}:${activeHost.protocol ?? ''}`;
    if (connectedHostIdRef.current === connectionKey) return;

    const s = sftpRef.current;
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
      connectedHostIdRef.current = connectionKey;
      return;
    }

    // Connect to the host - connect() handles creating a tab if needed
    connectedHostIdRef.current = connectionKey;
    // Store the pending key so the effect below can map it once the tab is created
    pendingConnectionKeyRef.current = connectionKey;
    s.connect("left", activeHost);
  }, [activeHost]); // Only depend on activeHost, not sftp

  // Track the active tab's connectionKey after connect() creates it.
  // This runs on every leftTabs change and picks up new tabs that connect() spawned.
  const pendingConnectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const activeTabId = sftp.leftTabs.activeTabId;
    if (activeTabId && pendingConnectionKeyRef.current) {
      tabConnectionKeyMapRef.current.set(activeTabId, pendingConnectionKeyRef.current);
      pendingConnectionKeyRef.current = null;
    }
  }, [sftp.leftTabs.activeTabId]);

  // Clear the remembered connection key when the pane disconnects or the
  // session is lost, so re-opening SFTP for the same terminal reconnects.
  useEffect(() => {
    const connection = sftp.leftPane.connection;
    if (!connection || connection.status === "error" || connection.status === "disconnected") {
      connectedHostIdRef.current = null;
    }
  }, [sftp.leftPane.connection?.status]);

  useEffect(() => {
    if (!activeHost || !initialLocation) return;
    if (initialLocation.hostId !== activeHost.id || !initialLocation.path) return;

    const activePane = sftpRef.current.leftPane;
    const connection = activePane.connection;
    if (!connection || connection.isLocal || connection.hostId !== activeHost.id) return;
    if (connection.status !== "connected") return;

    const locationKey = `${initialLocation.hostId}:${initialLocation.path}`;
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
    // Match by full connection identity so uploads for the same host ID
    // with different session-time overrides are not sent to the wrong endpoint.
    if (connectedHostIdRef.current !== pendingUpload.connectionKey) return;

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

  const visibleTransfers = useMemo(
    () => [...sftp.transfers].reverse().slice(0, 5),
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
        // Match on full endpoint identity so that the same host ID with
        // different session-time overrides doesn't allow cross-endpoint reveals.
        return connection.hostId === task.targetHostId
          && connectedHostIdRef.current === `${task.targetHostId}:${activeHost?.hostname ?? ''}:${activeHost?.port ?? ''}:${activeHost?.protocol ?? ''}`;
      }

      return connection.id === task.targetConnectionId;
    },
    [sftp.leftPane.connection, activeHost],
  );

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
        {showWorkspaceHostHeader && activeHost && (
          <div className="shrink-0 border-b border-border/50 bg-muted/20 px-3 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <DistroAvatar
                host={activeHost}
                fallback={activeHost.label.slice(0, 2).toUpperCase()}
                size="sm"
                className="h-5 w-5 rounded-sm shrink-0"
              />
              <div
                className="min-w-0 flex-1 max-w-[calc(100%-1.75rem)] text-[11px] leading-5 truncate"
                title={`${activeHost.label} · ${(activeHost.username || "root")}@${activeHost.hostname}:${activeHost.port || 22}`}
              >
                <span className="font-medium">
                  {activeHost.label}
                </span>
                <span className="mx-1 text-muted-foreground">·</span>
                <span className="font-mono text-muted-foreground">
                  {(activeHost.username || "root")}@{activeHost.hostname}:{activeHost.port || 22}
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
  prev.initialLocation?.hostId === next.initialLocation?.hostId &&
  prev.initialLocation?.path === next.initialLocation?.path;

export const SftpSidePanel = memo(SftpSidePanelInner, sidePanelAreEqual);
SftpSidePanel.displayName = "SftpSidePanel";
