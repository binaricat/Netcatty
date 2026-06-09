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

import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { SftpSidePanelDeferredMount } from "./SftpSidePanelDeferredMount";
import { formatHostPort } from "../domain/host";
import { useI18n } from "../application/i18n/I18nProvider";
import { useSftpState } from "../application/state/useSftpState";
import { registerEditorSftpWriterScoped } from "../application/state/editorSftpBridge";
import { editorTabStore } from "../application/state/editorTabStore";
import { releaseEditorTabSaveCoordinator } from "../application/state/editorTabSave";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
import { getParentPath, isConcreteTransferTargetPath } from "../application/state/sftp/utils";
import { buildCacheKey } from "../application/state/sftp/sharedRemoteHostCache";
import { logger } from "../lib/logger";
import type { DropEntry } from "../lib/sftpFileUtils";
import { Host, Identity, SSHKey } from "../types";
import type { TransferTask } from "../types";
import { toast } from "./ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
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
import { shouldFollowTerminalCwdNavigate } from "./sftp/sftpFollowTerminalCwd";

interface SftpSidePanelProps {
  hosts: Host[];
  writableHosts?: Host[];
  keys: SSHKey[];
  identities: Identity[];
  updateHosts: (hosts: Host[]) => void;
  sftpDefaultViewMode: "list" | "tree";
  /** The host to connect to (follows focused terminal) */
  activeHost: Host | null;
  /** The terminal session id whose SSH connection can be reused for SFTP */
  activeSessionId?: string | null;
  initialLocation?: { hostId: string; path: string } | null;
  onInitialLocationApplied?: (location: { hostId: string; path: string }) => void;
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
  onGetTerminalCwd?: (options?: { preferFreshBackend?: boolean }) => Promise<string | null>;
  activeTerminalCwd?: string | null;
  sftpFollowTerminalCwd?: boolean;
  onSftpFollowTerminalCwdChange?: (enabled: boolean) => void;
  onRequestTerminalFocus?: () => void;
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
}

const SftpSidePanelInner: React.FC<SftpSidePanelProps> = ({
  hosts,
  writableHosts,
  keys,
  identities,
  updateHosts,
  sftpDefaultViewMode,
  activeHost,
  activeSessionId,
  initialLocation,
  onInitialLocationApplied,
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
  activeTerminalCwd = null,
  sftpFollowTerminalCwd = false,
  onSftpFollowTerminalCwdChange,
  onRequestTerminalFocus,
  terminalSettings,
}) => {
  const { t } = useI18n();
  const hostWriteSource = writableHosts ?? hosts;

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
    terminalSettings,
  }), [fileWatchHandlers, sftpUseCompressedUpload, sftpShowHiddenFiles, terminalSettings]);

  const sftp = useSftpState(hosts, keys, identities, sftpOptions);
  const {
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    listLocalDir,
    listDrives,
    openPath,
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
      const closed = editorTabStore.forceCloseBySessions([...owned]);
      closed.forEach(releaseEditorTabSaveCoordinator);
    };
  }, []);

  const behaviorRef = useRef(sftpDoubleClickBehavior);
  behaviorRef.current = sftpDoubleClickBehavior;

  const autoSyncRef = useRef(sftpAutoSync);
  autoSyncRef.current = sftpAutoSync;

  const connectedKeyRef = useRef<string | null>(null);
  const connectedHostObjRef = useRef<Host | null>(null);
  const lastAppliedInitialLocationKeyRef = useRef<string | null>(null);
  const handledPendingUploadIdRef = useRef<string | null>(null);
  const tabConnectionKeyMapRef = useRef<Map<string, string>>(new Map());
  const [interactiveWorkActive, setInteractiveWorkActive] = useState(false);
  const [sftpUiReady, setSftpUiReady] = useState(false);

  const runAutoConnect = useCallback(() => {
    if (!activeHost) return;

    const s = sftpRef.current;
    const hasActiveWork = interactiveWorkActive
      || (s.activeFileWatchCountRef?.current ?? 0) > 0;

    const proto = activeHost.protocol;
    if (proto === 'serial' || activeHost.id?.startsWith('serial-')) {
      connectedKeyRef.current = null;
      return;
    }
    if (proto === 'local' || activeHost.id?.startsWith('local-')) {
      if (hasActiveWork) return;
      const leftConn = s.leftPane.connection;
      if (leftConn?.isLocal) {
        connectedKeyRef.current = "local";
        return;
      }
      const existingLocalTab = s.leftTabs.tabs.find((tab) =>
        tab.connection?.isLocal && tab.connection.status === "connected",
      );
      if (existingLocalTab) {
        s.selectTab("left", existingLocalTab.id);
        connectedKeyRef.current = "local";
        return;
      }
      connectedKeyRef.current = "local";
      const needsNewTab = !!(leftConn && leftConn.status === "connected");
      if (needsNewTab) {
        s.connect("left", "local", { forceNewTab: true });
      } else if (leftConn) {
        void s.disconnect("left").then(() => s.connect("left", "local"));
      } else {
        s.connect("left", "local");
      }
      return;
    }

    const connectionKey = buildCacheKey(
      activeHost.id,
      activeHost.hostname,
      activeHost.port,
      activeHost.protocol,
      activeHost.sftpSudo,
      activeHost.username,
    );
    if (connectedKeyRef.current === connectionKey) return;
    if (hasActiveWork) return;

    logger.info("[SftpSidePanel] Auto-connect triggered", {
      hostId: activeHost.id,
      hostLabel: activeHost.label,
      protocol: activeHost.protocol,
      hostname: activeHost.hostname,
    });

    const tabs = s.leftTabs.tabs;
    const existingTab = tabs.find((tab) => {
      if (!tab.connection || tab.connection.hostId !== activeHost.id) return false;
      if (tab.connection.status === "error" || tab.connection.status === "disconnected") return false;
      return tabConnectionKeyMapRef.current.get(tab.id) === connectionKey;
    });
    if (existingTab) {
      s.selectTab("left", existingTab.id);
      connectedKeyRef.current = connectionKey;
      connectedHostObjRef.current = activeHost;
      return;
    }

    const currentConn = s.leftPane.connection;
    const needsNewTab = !!(currentConn && currentConn.status === "connected");

    connectedKeyRef.current = connectionKey;
    connectedHostObjRef.current = activeHost;
    s.connect("left", activeHost, {
      sourceSessionId: activeSessionId ?? undefined,
      ...(needsNewTab ? { forceNewTab: true } : undefined),
      onTabCreated: (tabId) => {
        tabConnectionKeyMapRef.current.set(tabId, connectionKey);
      },
    });
  }, [activeHost, activeSessionId, interactiveWorkActive]);

  useEffect(() => {
    if (!activeHost || !isVisible) return;

    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      if (!cancelled) runAutoConnect();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [activeHost, activeSessionId, interactiveWorkActive, isVisible, runAutoConnect]);

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

    const locationKey = `${connectedKeyRef.current}:${initialLocation.path}`;
    if (lastAppliedInitialLocationKeyRef.current === locationKey) return;

    lastAppliedInitialLocationKeyRef.current = locationKey;
    onInitialLocationApplied?.(initialLocation);

    if (connection.currentPath === initialLocation.path) {
      return;
    }

    sftpRef.current.navigateTo("left", initialLocation.path);
  }, [
    activeHost,
    initialLocation,
    onInitialLocationApplied,
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

  return (
    <SftpSidePanelDeferredMount ready={sftpUiReady} onReady={() => setSftpUiReady(true)}>
      <SftpSidePanelInteractiveBody
        hosts={hosts}
        hostWriteSource={hostWriteSource}
        updateHosts={updateHosts}
        sftp={sftp}
        sftpRef={sftpRef}
        sftpDefaultViewMode={sftpDefaultViewMode}
        activeHost={activeHost}
        showWorkspaceHostHeader={showWorkspaceHostHeader}
        renderOverlays={renderOverlays}
        sftpDoubleClickBehavior={sftpDoubleClickBehavior}
        sftpAutoSync={sftpAutoSync}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        editorWordWrap={editorWordWrap}
        setEditorWordWrap={setEditorWordWrap}
        onGetTerminalCwd={onGetTerminalCwd}
        activeTerminalCwd={activeTerminalCwd}
        sftpFollowTerminalCwd={sftpFollowTerminalCwd}
        onSftpFollowTerminalCwdChange={onSftpFollowTerminalCwdChange}
        onRequestTerminalFocus={onRequestTerminalFocus}
        isVisible={isVisible}
        behaviorRef={behaviorRef}
        autoSyncRef={autoSyncRef}
        connectedHostObjRef={connectedHostObjRef}
        connectedKeyRef={connectedKeyRef}
        onInteractiveWorkChange={setInteractiveWorkActive}
        listSftp={listSftp}
        mkdirLocal={mkdirLocal}
        deleteLocalFile={deleteLocalFile}
        showSaveDialog={showSaveDialog}
        selectDirectory={selectDirectory}
        startStreamTransfer={startStreamTransfer}
        listLocalDir={listLocalDir}
        listDrives={listDrives}
        openPath={openPath}
        t={t}
      />
    </SftpSidePanelDeferredMount>
  );
};

type SftpSidePanelInteractiveBodyProps = {
  hosts: Host[];
  hostWriteSource: Host[];
  updateHosts: (hosts: Host[]) => void;
  sftp: ReturnType<typeof useSftpState>;
  sftpRef: MutableRefObject<ReturnType<typeof useSftpState>>;
  sftpDefaultViewMode: "list" | "tree";
  activeHost: Host | null;
  showWorkspaceHostHeader: boolean;
  renderOverlays: boolean;
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  onGetTerminalCwd?: (options?: { preferFreshBackend?: boolean }) => Promise<string | null>;
  activeTerminalCwd?: string | null;
  sftpFollowTerminalCwd: boolean;
  onSftpFollowTerminalCwdChange?: (enabled: boolean) => void;
  onRequestTerminalFocus?: () => void;
  isVisible: boolean;
  behaviorRef: MutableRefObject<"open" | "transfer">;
  autoSyncRef: MutableRefObject<boolean>;
  connectedHostObjRef: MutableRefObject<Host | null>;
  connectedKeyRef: MutableRefObject<string | null>;
  onInteractiveWorkChange: (active: boolean) => void;
  listSftp: ReturnType<typeof useSftpBackend>["listSftp"];
  mkdirLocal: ReturnType<typeof useSftpBackend>["mkdirLocal"];
  deleteLocalFile: ReturnType<typeof useSftpBackend>["deleteLocalFile"];
  showSaveDialog: ReturnType<typeof useSftpBackend>["showSaveDialog"];
  selectDirectory: ReturnType<typeof useSftpBackend>["selectDirectory"];
  startStreamTransfer: ReturnType<typeof useSftpBackend>["startStreamTransfer"];
  listLocalDir: ReturnType<typeof useSftpBackend>["listLocalDir"];
  listDrives: ReturnType<typeof useSftpBackend>["listDrives"];
  openPath: ReturnType<typeof useSftpBackend>["openPath"];
  t: ReturnType<typeof useI18n>["t"];
};

const SftpSidePanelInteractiveBody: React.FC<SftpSidePanelInteractiveBodyProps> = ({
  hosts,
  hostWriteSource,
  updateHosts,
  sftp,
  sftpRef,
  sftpDefaultViewMode,
  activeHost,
  showWorkspaceHostHeader,
  renderOverlays,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
  onGetTerminalCwd,
  activeTerminalCwd = null,
  sftpFollowTerminalCwd,
  onSftpFollowTerminalCwdChange,
  onRequestTerminalFocus,
  isVisible,
  behaviorRef,
  autoSyncRef,
  connectedHostObjRef,
  connectedKeyRef,
  onInteractiveWorkChange,
  listSftp,
  mkdirLocal,
  deleteLocalFile,
  showSaveDialog,
  selectDirectory,
  startStreamTransfer,
  listLocalDir,
  listDrives,
  openPath,
  t,
}) => {
  const panelRootRef = useRef<HTMLDivElement>(null);
  const dialogActionScopeIdRef = useRef(`sftp-side-panel:${crypto.randomUUID()}`);
  const [hasPaneFocus, setHasPaneFocus] = useState(false);

  useSftpKeyboardShortcuts({
    keyBindings,
    hotkeyScheme,
    sftpRef,
    dialogActionScopeId: dialogActionScopeIdRef.current,
    isActive: hasPaneFocus,
  });

  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();
  const getOpenerForFileRef = useRef(getOpenerForFile);
  getOpenerForFileRef.current = getOpenerForFile;

  const handleToggleHiddenFiles = useCallback((paneId: string) => {
    const pane = sftpRef.current.leftTabs.tabs.find((tab) => tab.id === paneId);
    if (!pane) return;
    sftpRef.current.setShowHiddenFiles("left", paneId, !pane.showHiddenFiles);
  }, [sftpRef]);

  const syncFocusedSelection = useCallback((tabId: string | null) => {
    if (tabId) {
      keepOnlyPaneSelections(sftpRef.current, { side: "left", tabId });
      return;
    }
    keepOnlyPaneSelections(sftpRef.current, null);
  }, [sftpRef]);

  const handlePaneFocus = useCallback(() => {
    sftpFocusStore.setFocusedSide("left");
    setHasPaneFocus(true);
    syncFocusedSelection(sftpRef.current.getActiveTabId("left"));
  }, [sftpRef, syncFocusedSelection]);

  // NOTE: We intentionally do NOT sync to activeTabStore here.
  // activeTabStore is a global singleton shared with SftpView.
  // Writing to it here would corrupt SftpView's left pane visibility.

  useEffect(() => {
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
  }, [sftpRef, syncFocusedSelection]);

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
    listDrives,
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

  useEffect(() => {
    onInteractiveWorkChange(showTextEditor || !!permissionsState || showFileOpenerDialog);
  }, [onInteractiveWorkChange, permissionsState, showFileOpenerDialog, showTextEditor]);

  const canFollowTerminalCwd = useMemo(() => {
    if (!onGetTerminalCwd || !activeHost) return false;
    const proto = activeHost.protocol;
    if (proto === "local" || proto === "serial") return false;
    if (activeHost.id?.startsWith("local-") || activeHost.id?.startsWith("serial-")) return false;
    return true;
  }, [activeHost, onGetTerminalCwd]);

  const hasActiveWork = showTextEditor || !!permissionsState || showFileOpenerDialog
    || (sftp.activeFileWatchCountRef?.current ?? 0) > 0;

  const handleGoToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd) return;
    const cwd = await onGetTerminalCwd({ preferFreshBackend: true });
    if (cwd) {
      sftpRef.current.navigateTo("left", cwd);
    }
  }, [onGetTerminalCwd, sftpRef]);

  const syncFollowToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd || !sftpFollowTerminalCwd || !canFollowTerminalCwd) {
      return;
    }

    let terminalCwd = activeTerminalCwd;
    if (!terminalCwd) {
      terminalCwd = await onGetTerminalCwd({ preferFreshBackend: true });
    }
    if (!terminalCwd) return;

    const connection = sftpRef.current.leftPane.connection;
    if (!shouldFollowTerminalCwdNavigate({
      followEnabled: sftpFollowTerminalCwd,
      isVisible,
      terminalCwd,
      currentPath: connection?.currentPath,
      hasActiveWork,
      isConnected: Boolean(connection && !connection.isLocal && connection.status === "connected"),
    })) {
      return;
    }

    await sftpRef.current.navigateTo("left", terminalCwd);
  }, [
    activeTerminalCwd,
    canFollowTerminalCwd,
    hasActiveWork,
    isVisible,
    onGetTerminalCwd,
    sftpRef,
    sftpFollowTerminalCwd,
  ]);

  const handleToggleFollowTerminalCwd = useCallback(() => {
    onSftpFollowTerminalCwdChange?.(!sftpFollowTerminalCwd);
  }, [onSftpFollowTerminalCwdChange, sftpFollowTerminalCwd]);

  useEffect(() => {
    if (!sftpFollowTerminalCwd || !canFollowTerminalCwd || !isVisible || hasActiveWork) return;
    void syncFollowToTerminalCwd();
  }, [
    activeTerminalCwd,
    canFollowTerminalCwd,
    hasActiveWork,
    isVisible,
    sftpFollowTerminalCwd,
    sftp.leftPane.connection?.currentPath,
    sftp.leftPane.connection?.status,
    sftp.leftPane.connection?.isLocal,
    syncFollowToTerminalCwd,
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
      if (!isConcreteTransferTargetPath(task)) return;
      const connection = sftpRef.current.leftPane.connection;
      const revealPath = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);

      if (task.targetConnectionId === "local") {
        try {
          const result = await openPath(revealPath);
          if (result.success) return;
        } catch {
          // Show the localized error below.
        }
        toast.error(t("sftp.transfers.openTargetFolderError"), "SFTP");
        return;
      }

      if (!connection || connection.isLocal) return;

      await sftpRef.current.navigateTo("left", revealPath, { force: true });
    },
    [openPath, sftpRef, t],
  );

  const canRevealTransferTarget = useCallback(
    (task: TransferTask) => {
      if (task.status !== "completed") return false;
      if (!isConcreteTransferTargetPath(task)) return false;
      if (task.targetConnectionId === "local") {
        return true;
      }
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
    [connectedKeyRef, sftp.leftPane.connection],
  );

  const canCopyTransferTargetPath = useCallback(
    (task: TransferTask) => task.status === "completed" && isConcreteTransferTargetPath(task),
    [],
  );

  const handleCopyTransferTargetPath = useCallback(
    async (task: TransferTask) => {
      if (!isConcreteTransferTargetPath(task)) return;
      try {
        await navigator.clipboard.writeText(task.targetPath);
        toast.success(t("sftp.transfers.copyTargetPathSuccess"), "SFTP");
      } catch {
        toast.error(t("sftp.transfers.copyTargetPathError"), "SFTP");
      }
    },
    [t],
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
  }, [activeHost, connectedHostObjRef, hosts, sftp.leftPane.connection]);

  // Determine the active pane to render (without using global activeTabStore)
  const activeLeftPaneId = sftp.leftTabs.activeTabId;

  return (
    <SftpContextProvider
      hosts={hosts}
      writableHosts={hostWriteSource}
      updateHosts={updateHosts}
      draggedFiles={draggedFiles}
      dragCallbacks={dragCallbacks}
      leftCallbacks={leftCallbacks}
      rightCallbacks={rightCallbacks}
    >
      <div
        ref={panelRootRef}
        className="h-full flex flex-col bg-background overflow-hidden"
        data-section="terminal-sftp-panel"
        onClick={handlePaneFocus}
      >
        {showWorkspaceHostHeader && displayHost && (
          <div
            className="shrink-0 border-b border-border/50 bg-muted/20 px-3 py-1.5"
            data-section="terminal-sftp-host-header"
          >
            <div className="flex items-center gap-2 min-w-0">
              <DistroAvatar
                host={displayHost}
                fallback={displayHost.label.slice(0, 2).toUpperCase()}
                size="sm"
                className="h-5 w-5 rounded-sm shrink-0"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 flex-1 max-w-[calc(100%-1.75rem)] text-[11px] leading-5 truncate cursor-default">
                    <span className="font-medium">
                      {displayHost.label}
                    </span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="font-mono text-muted-foreground">
                      {(displayHost.username || "root")}@{displayHost.hostname}:{displayHost.port || 22}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {`${displayHost.label} · ${(displayHost.username || "root")}@${formatHostPort(displayHost.hostname, displayHost.port || 22)}`}
                </TooltipContent>
              </Tooltip>
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
                  isPaneFocused={hasPaneFocus}
                  sftpDefaultViewMode={sftpDefaultViewMode}
                  showHeader
                  showEmptyHeader
                  forceActive
                  onToggleShowHiddenFiles={() => handleToggleHiddenFiles(pane.id)}
                  onGoToTerminalCwd={onGetTerminalCwd ? handleGoToTerminalCwd : undefined}
                  followTerminalCwd={canFollowTerminalCwd ? sftpFollowTerminalCwd : undefined}
                  onToggleFollowTerminalCwd={canFollowTerminalCwd ? handleToggleFollowTerminalCwd : undefined}
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
          canCopyTransferTargetPath={canCopyTransferTargetPath}
          onCopyTransferTargetPath={handleCopyTransferTargetPath}
        />
      </div>

      {renderOverlays && (
        <SftpOverlays
          hosts={hosts}
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          showTransferQueue={false}
          canRevealTransferTarget={canRevealTransferTarget}
          onRevealTransferTarget={handleRevealTransferTarget}
          canCopyTransferTargetPath={canCopyTransferTargetPath}
          onCopyTransferTargetPath={handleCopyTransferTargetPath}
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
          onRequestTerminalFocus={onRequestTerminalFocus}
          t={t}
        />
      )}
    </SftpContextProvider>
  );
};

const sidePanelAreEqual = (prev: SftpSidePanelProps, next: SftpSidePanelProps): boolean =>
  prev.hosts === next.hosts &&
  prev.writableHosts === next.writableHosts &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.updateHosts === next.updateHosts &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.activeHost === next.activeHost &&
  prev.activeSessionId === next.activeSessionId &&
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
  prev.activeTerminalCwd === next.activeTerminalCwd &&
  prev.sftpFollowTerminalCwd === next.sftpFollowTerminalCwd &&
  prev.onSftpFollowTerminalCwdChange === next.onSftpFollowTerminalCwdChange &&
  prev.onRequestTerminalFocus === next.onRequestTerminalFocus &&
  prev.initialLocation?.hostId === next.initialLocation?.hostId &&
  prev.initialLocation?.path === next.initialLocation?.path &&
  // Only the keepalive fields of terminalSettings affect SFTP connection
  // resolution today; compare them directly rather than the whole object.
  prev.terminalSettings?.keepaliveInterval === next.terminalSettings?.keepaliveInterval &&
  prev.terminalSettings?.keepaliveCountMax === next.terminalSettings?.keepaliveCountMax;

export const SftpSidePanel = memo(SftpSidePanelInner, sidePanelAreEqual);
SftpSidePanel.displayName = "SftpSidePanel";
