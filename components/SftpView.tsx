/**
 * SftpView - SFTP File Browser (Refactored)
 *
 * This is the main SFTP view component that provides a dual-pane file browser
 * for transferring files between local and remote systems.
 *
 * Components have been extracted to:
 * - components/sftp/utils.ts - Utility functions
 * - components/sftp/SftpBreadcrumb.tsx - Path navigation
 * - components/sftp/SftpFileRow.tsx - File list row
 * - components/sftp/SftpTransferItem.tsx - Transfer queue item
 * - components/sftp/SftpConflictDialog.tsx - Conflict resolution
 * - components/sftp/SftpPermissionsDialog.tsx - Permissions editor
 * - components/sftp/SftpHostPicker.tsx - Host selection dialog
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { activeTabStore as globalActiveTabStore, useIsSftpActive } from "../application/state/activeTabStore";
import { useSftpState } from "../application/state/useSftpState";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { getParentPath, isConcreteTransferTargetPath } from "../application/state/sftp/utils";
import { HotkeyScheme, KeyBinding, TerminalSession } from "../domain/models";
import {
  getPaneMagnificationShortcutLabel,
  resolveTwoPaneMagnificationStyle,
  type PaneMagnificationController,
} from "../domain/paneMagnification";
import { listSftpConnectedHosts, resolveSftpTransferSourceSessionId, sftpPickerSessionsEqual } from "../domain/sftpConnectedHosts";
import { logger } from "../lib/logger";
import { useRenderTracker } from "../lib/useRenderTracker";
import { cn } from "../lib/utils";
import { Host, Identity, KnownHost, ProxyProfile, SSHKey, TransferTask } from "../types";
import { resolveGroupDefaults, applyGroupDefaults } from "../domain/groupConfig";
import { materializeHostProxyProfile } from "../domain/proxyProfiles";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
import { registerEditorSftpWriterScoped } from "../application/state/editorSftpBridge";
import { toast } from "./ui/toast";

// Import extracted components
import { SftpTabBar } from "./sftp";
import { SftpPaneView, SftpPaneWrapper } from "./sftp/SftpPaneView";
import { SftpOverlays } from "./sftp/SftpOverlays";
import { Loader2 } from "lucide-react";

// Import context hooks
import { SftpContextProvider, activeTabStore } from "./sftp";
import { useSftpViewPaneCallbacks } from "./sftp/hooks/useSftpViewPaneCallbacks";
import { useSftpViewTabs } from "./sftp/hooks/useSftpViewTabs";
import { useSftpKeyboardShortcuts } from "./sftp/hooks/useSftpKeyboardShortcuts";
import { sftpFocusStore, SftpFocusedSide, useSftpFocusedSide } from "../application/state/sftp/sftpFocusStore";
import { keepOnlyActivePaneSelections, keepOnlyPaneSelections } from "./sftp/hooks/selectionScope";


// Wrapper component that subscribes to activeTabId for CSS visibility
// This isolates the activeTabId subscription - only this component re-renders on tab switch
// Uses visibility:hidden pattern from App.tsx for smooth tab switching
// Main SftpView component
interface SftpViewProps {
  hosts: Host[];
  /** Vault-persisted hosts only; used for writes so ephemeral deep-link hosts stay out of vault. */
  writableHosts?: Host[];
  sessions?: TerminalSession[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  groupConfigs?: import('../domain/models').GroupConfig[];
  proxyProfiles?: ProxyProfile[];
  updateHosts: (hosts: Host[]) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  sftpDefaultViewMode: "list" | "tree";
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (enabled: boolean) => void;
  terminalSettings?: { verifyHostKeys: boolean; keepaliveInterval: number; keepaliveCountMax: number };
  paneMagnificationRef?: React.MutableRefObject<PaneMagnificationController | null>;
}

const SftpViewInner: React.FC<SftpViewProps> = ({
  hosts,
  writableHosts,
  sessions = [],
  keys,
  identities,
  knownHosts = [],
  groupConfigs = [],
  proxyProfiles = [],
  updateHosts,
  onAddKnownHost,
  sftpDefaultViewMode,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
  terminalSettings,
  paneMagnificationRef,
}) => {
  const { t } = useI18n();
  const paneMagnificationShortcutLabel = getPaneMagnificationShortcutLabel(keyBindings, hotkeyScheme);
  const isActive = useIsSftpActive();
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogActionScopeIdRef = useRef("sftp-main-view");

  // File watch event handlers (stable refs to avoid re-creating the useSftpState options)
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

  const resolveTransferSourceSessionId = useCallback((hostId: string, host?: Host) => {
    const hostsById = new Map<string, Host>(hosts.map((h) => [h.id, h]));
    // Walk all sessions (not the picker one-per-hostId list) so multi-tab
    // same hostId with different live endpoints can still match.
    return resolveSftpTransferSourceSessionId(sessions, hostsById, hostId, host);
  }, [hosts, sessions]);

  const sftpOptions = useMemo(() => ({
    ...fileWatchHandlers,
    transferOwnerId: "main-sftp-view",
    // Main SFTP page stays interactive while mounted so top-tab switches
    // (e.g. Terminal ↔ SFTP) must not soft-close every tab's session.
    // The terminal side panel parks only after the panel is closed (not when
    // switching History/System while the chrome stays open).
    // Bulk transfers use dedicated pool sessions regardless.
    interactive: true,
    useCompressedUpload: sftpUseCompressedUpload,
    defaultShowHiddenFiles: sftpShowHiddenFiles,
    terminalSettings,
    knownHosts,
    onAddKnownHost,
    resolveTransferSourceSessionId,
  }), [
    fileWatchHandlers,
    sftpUseCompressedUpload,
    sftpShowHiddenFiles,
    terminalSettings,
    knownHosts,
    onAddKnownHost,
    resolveTransferSourceSessionId,
  ]);

  // Pre-resolve group defaults so SFTP connections inherit group config
  const effectiveHosts = useMemo(() => {
    const validProxyProfileIds = new Set(proxyProfiles.map((profile) => profile.id));
    return hosts.map(h => {
      const withGroupDefaults = h.group
        ? applyGroupDefaults(h, resolveGroupDefaults(h.group, groupConfigs, { validProxyProfileIds }), { validProxyProfileIds })
        : applyGroupDefaults(h, {}, { validProxyProfileIds });
      return materializeHostProxyProfile(withGroupDefaults, proxyProfiles);
    });
  }, [hosts, groupConfigs, proxyProfiles]);

  const hostWriteSource = writableHosts ?? hosts;

  const connectedHosts = useMemo(() => {
    const hostsById = new Map<string, Host>(
      effectiveHosts.map((host) => [host.id, host]),
    );
    return listSftpConnectedHosts(sessions, hostsById);
  }, [effectiveHosts, sessions]);

  const sftp = useSftpState(effectiveHosts, keys, identities, sftpOptions);

  // Get backend helpers for file downloads and local filesystem writes.
  const {
    showSaveDialog,
    selectDirectory,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    listLocalDir,
    listDrives,
    openPath,
  } = useSftpBackend();

  // Store sftp in a ref so callbacks can access the latest instance
  // without needing to re-create when sftp changes
  const sftpRef = useRef(sftp);
  sftpRef.current = sftp;

  // Register this useSftpState's writeTextFileByConnection with the bridge so
  // the editor tab's save path can reach the active SFTP session. The bridge
  // supports multiple simultaneous writers (SftpSidePanel inside terminals
  // also registers its own instance) and dispatches by trying each until one
  // owns the target connectionId.
  //
  // Intentionally no deps: `sftp` identity churns on every SFTP state change
  // (transfers, pane updates, tab switches), which would make this effect
  // unregister+reregister constantly. Route through sftpRef so the closure
  // always reads the latest writeTextFileByConnection; that method is stable
  // across sftp re-renders (it's a methodsRef-backed dispatcher).
  useEffect(() => {
    return registerEditorSftpWriterScoped((connectionId, expectedHostId, filePath, content, encoding, sftpTabId) =>
      sftpRef.current.writeTextFileByConnection(connectionId, expectedHostId, filePath, content, encoding, sftpTabId),
    );
  }, []);

  // Store behavior setting in ref for stable callbacks
  const behaviorRef = useRef(sftpDoubleClickBehavior);
  behaviorRef.current = sftpDoubleClickBehavior;

  // Store auto-sync setting in ref for stable callbacks
  const autoSyncRef = useRef(sftpAutoSync);
  autoSyncRef.current = sftpAutoSync;

  // SFTP keyboard shortcuts handler
  useSftpKeyboardShortcuts({
    keyBindings,
    hotkeyScheme,
    sftpRef,
    dialogActionScopeId: dialogActionScopeIdRef.current,
    isActive,
  });

  // Subscribe to focused side for visual indicator
  const focusedSide = useSftpFocusedSide();
  const [magnifiedSide, setMagnifiedSide] = useState<SftpFocusedSide | null>(null);
  const focusedSideRef = useRef(focusedSide);
  const magnifiedSideRef = useRef(magnifiedSide);
  focusedSideRef.current = focusedSide;
  magnifiedSideRef.current = magnifiedSide;
  const [isWideSplit, setIsWideSplit] = useState(true);
  const [showMagnificationHint, setShowMagnificationHint] = useState(false);
  const splitSurfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const surface = splitSurfaceRef.current;
    if (!surface) return undefined;
    const update = () => setIsWideSplit(surface.clientWidth >= 1024);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!magnifiedSide) {
      setShowMagnificationHint(false);
      return undefined;
    }
    setShowMagnificationHint(true);
    const timerId = window.setTimeout(() => setShowMagnificationHint(false), 1800);
    return () => window.clearTimeout(timerId);
  }, [magnifiedSide]);

  useEffect(() => {
    if (!paneMagnificationRef) return undefined;
    const controller: PaneMagnificationController = {
      getState: () => {
        if (globalActiveTabStore.getActiveTabId() !== 'sftp') return 'unavailable';
        return magnifiedSideRef.current ? 'focused' : 'focusable';
      },
      focus: () => {
        if (globalActiveTabStore.getActiveTabId() !== 'sftp' || magnifiedSideRef.current) return false;
        setMagnifiedSide(focusedSideRef.current);
        return true;
      },
      restore: () => {
        if (globalActiveTabStore.getActiveTabId() !== 'sftp' || !magnifiedSideRef.current) return false;
        setMagnifiedSide(null);
        return true;
      },
      toggle: () => {
        if (globalActiveTabStore.getActiveTabId() !== 'sftp') return false;
        setMagnifiedSide((current) => current ? null : focusedSideRef.current);
        return true;
      },
    };
    paneMagnificationRef.current = controller;
    return () => {
      if (paneMagnificationRef.current === controller) paneMagnificationRef.current = null;
    };
  }, [paneMagnificationRef]);

  // Handle pane focus when clicking on a pane container
  // Clear the opposite side's selection so file operations only affect the focused pane
  const handlePaneFocus = useCallback((side: SftpFocusedSide, targetTabId?: string) => {
    const prevSide = sftpFocusStore.getFocusedSide();
    sftpFocusStore.setFocusedSide(side);
    setMagnifiedSide((current) => current ? side : null);
    if (prevSide !== side) {
      if (targetTabId) {
        keepOnlyPaneSelections(sftpRef.current, { side, tabId: targetTabId });
      } else {
        // Focus side changed — clear other panes but keep the newly focused pane intact.
        keepOnlyActivePaneSelections(sftpRef.current, side);
      }
    }
  }, []);

  const handleToggleHiddenFiles = useCallback((side: "left" | "right", paneId: string) => {
    const sideTabs = side === "left" ? sftpRef.current.leftTabs : sftpRef.current.rightTabs;
    const pane = sideTabs.tabs.find((tab) => tab.id === paneId);
    if (!pane) return;

    sftpRef.current.setShowHiddenFiles(side, paneId, !pane.showHiddenFiles);
  }, []);

  // Sync activeTabId to external store (allows child components to subscribe without parent re-render)
  // Using useLayoutEffect to sync before paint
  useLayoutEffect(() => {
    activeTabStore.setActiveTabId("left", sftp.leftTabs.activeTabId);
  }, [sftp.leftTabs.activeTabId]);

  useLayoutEffect(() => {
    activeTabStore.setActiveTabId("right", sftp.rightTabs.activeTabId);
  }, [sftp.rightTabs.activeTabId]);

  // 渲染追踪 - 不追踪 activeTabId（现在通过 store 订阅）
  useRenderTracker("SftpViewInner", {
    isActive,
    hostsCount: hosts.length,
    leftTabsCount: sftp.leftTabs.tabs.length,
    rightTabsCount: sftp.rightTabs.tabs.length,
  });
  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();

  const getOpenerForFileRef = useRef(getOpenerForFile);
  getOpenerForFileRef.current = getOpenerForFile;

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
    loadingTextContent,
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
    getSftpIdForConnection: sftp.getSftpIdForConnection,
    listLocalFiles: listLocalDir,
    listDrives,
  });

  const visibleTransfers = useMemo(
    () => [...sftp.transfers].filter((t) => !t.parentTaskId).reverse().slice(0, 5),
    [sftp.transfers],
  );

  const getTransferTargetDirectory = useCallback(
    (task: TransferTask) => (task.isDirectory ? task.targetPath : getParentPath(task.targetPath)),
    [],
  );

  const findRemoteTransferTargetTab = useCallback((task: TransferTask) => {
    const state = sftpRef.current;
    for (const side of ["left", "right"] as const) {
      const tabs = side === "left" ? state.leftTabs.tabs : state.rightTabs.tabs;
      const pane = tabs.find((tab) => tab.connection?.id === task.targetConnectionId);
      if (pane?.connection && !pane.connection.isLocal) {
        return { side, tabId: pane.id };
      }
    }
    return null;
  }, []);

  const canRevealTransferTarget = useCallback(
    (task: TransferTask) => {
      if (task.status !== "completed") return false;
      if (!isConcreteTransferTargetPath(task)) return false;
      if (task.targetConnectionId === "local") {
        return true;
      }
      return !!findRemoteTransferTargetTab(task);
    },
    [findRemoteTransferTargetTab],
  );

  const handleRevealTransferTarget = useCallback(
    async (task: TransferTask) => {
      if (!isConcreteTransferTargetPath(task)) return;
      const targetDirectory = getTransferTargetDirectory(task);
      if (task.targetConnectionId === "local") {
        try {
          const result = await openPath(targetDirectory);
          if (result.success) return;
        } catch {
          // Show the localized error below.
        }
        toast.error(t("sftp.transfers.openTargetFolderError"), "SFTP");
        return;
      }

      const targetTab = findRemoteTransferTargetTab(task);
      if (!targetTab) return;
      await sftpRef.current.navigateTo(targetTab.side, targetDirectory, { force: true, tabId: targetTab.tabId });
    },
    [findRemoteTransferTargetTab, getTransferTargetDirectory, openPath, t],
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

  const containerStyle: React.CSSProperties = isActive
    ? {}
    : {
      visibility: "hidden",
      pointerEvents: "none",
      position: "absolute",
      zIndex: -1,
    };

  // Don't read activeTabId here - let SftpTabBar and SftpPaneWrapper subscribe to store
  // This prevents SftpViewInner from re-rendering on tab switch

  const {
    leftPanes,
    rightPanes,
    leftTabsInfo,
    rightTabsInfo,
    showHostPickerLeft,
    showHostPickerRight,
    hostSearchLeft,
    hostSearchRight,
    setShowHostPickerLeft,
    setShowHostPickerRight,
    setHostSearchLeft,
    setHostSearchRight,
    handleAddTabLeft,
    handleAddTabRight,
    handleCloseTabLeft,
    handleCloseTabRight,
    handleSelectTabLeft,
    handleSelectTabRight,
    handleReorderTabsLeft,
    handleReorderTabsRight,
    handleMoveTabFromLeftToRight,
    handleMoveTabFromRightToLeft,
    handleDuplicateTabLeft,
    handleDuplicateTabRight,
    handleHostSelectLeft,
    handleHostSelectRight,
  } = useSftpViewTabs({ sftp, sftpRef, hosts: effectiveHosts });

  const handleAddTabLeftWithFocus = useCallback(() => {
    const tabId = handleAddTabLeft();
    handlePaneFocus("left", tabId);
  }, [handleAddTabLeft, handlePaneFocus]);

  const handleAddTabRightWithFocus = useCallback(() => {
    const tabId = handleAddTabRight();
    handlePaneFocus("right", tabId);
  }, [handleAddTabRight, handlePaneFocus]);

  const handleSelectTabLeftWithFocus = useCallback((tabId: string) => {
    handleSelectTabLeft(tabId);
    handlePaneFocus("left", tabId);
  }, [handlePaneFocus, handleSelectTabLeft]);

  const handleSelectTabRightWithFocus = useCallback((tabId: string) => {
    handleSelectTabRight(tabId);
    handlePaneFocus("right", tabId);
  }, [handlePaneFocus, handleSelectTabRight]);

  const handleDuplicateTabLeftWithFocus = useCallback(
    async (...args: Parameters<typeof handleDuplicateTabLeft>) => {
      const tabId = await handleDuplicateTabLeft(...args);
      if (tabId) {
        handlePaneFocus("left", tabId);
      }
    },
    [handleDuplicateTabLeft, handlePaneFocus],
  );

  const handleDuplicateTabRightWithFocus = useCallback(
    async (...args: Parameters<typeof handleDuplicateTabRight>) => {
      const tabId = await handleDuplicateTabRight(...args);
      if (tabId) {
        handlePaneFocus("right", tabId);
      }
    },
    [handleDuplicateTabRight, handlePaneFocus],
  );

  return (
    <SftpContextProvider
      hosts={effectiveHosts}
      connectedHosts={connectedHosts}
      writableHosts={hostWriteSource}
      updateHosts={updateHosts}
      draggedFiles={draggedFiles}
      dragCallbacks={dragCallbacks}
      leftCallbacks={leftCallbacks}
      rightCallbacks={rightCallbacks}
    >
      <div
        ref={rootRef}
        className={cn(
          "absolute inset-0 min-h-0 flex flex-col bg-background",
          isActive ? "z-20" : "",
        )}
        style={containerStyle}
      >
        <div
          ref={splitSurfaceRef}
          className="relative flex-1 min-h-0 border-t border-border/70 overflow-hidden"
          data-section="sftp-main-split"
          data-magnified-side={magnifiedSide ?? undefined}
        >
          {magnifiedSide && (
            <div
              className="absolute inset-0 z-40 bg-background/55 backdrop-blur-[1px]"
              aria-hidden="true"
              data-section="pane-magnification-backdrop"
            />
          )}
          <div
            className="absolute min-w-0 border-r border-border/70 bg-background flex flex-col transition-[left,top,width,height] duration-150 ease-out"
            style={resolveTwoPaneMagnificationStyle('left', isWideSplit, magnifiedSide === 'left')}
            data-sftp-pane-side="left"
            inert={magnifiedSide === 'right' ? true : undefined}
            onClick={() => handlePaneFocus("left")}
            onFocusCapture={() => handlePaneFocus("left")}
          >
            {/* Focus indicator triangle */}
            {focusedSide === "left" && (
              <div
                className="absolute top-0 left-0 z-50 pointer-events-none"
                style={{
                  width: 0,
                  height: 0,
                  borderStyle: 'solid',
                  borderWidth: '12px 12px 0 0',
                  borderColor: 'hsl(var(--primary)) transparent transparent transparent',
                }}
              />
            )}
            {/* Left side tab bar - only show when there are tabs */}
            {leftTabsInfo.length > 0 && (
              <SftpTabBar
                tabs={leftTabsInfo}
                side="left"
                onSelectTab={handleSelectTabLeftWithFocus}
                onCloseTab={handleCloseTabLeft}
                onAddTab={handleAddTabLeftWithFocus}
                onReorderTabs={handleReorderTabsLeft}
                onMoveTabToOtherSide={handleMoveTabFromRightToLeft}
                onDuplicateTab={handleDuplicateTabLeftWithFocus}
              />
            )}
            <div className="relative flex-1 min-h-0">
              {leftPanes.map((pane, idx) => (
                <SftpPaneWrapper
                  key={pane.id}
                  side="left"
                  paneId={pane.id}
                  isFirstPane={idx === 0}
                >
                  <SftpPaneView
                    side="left"
                    pane={pane}
                    dialogActionScopeId={dialogActionScopeIdRef.current}
                    isPaneFocused={focusedSide === "left"}
                    sftpDefaultViewMode={sftpDefaultViewMode}
                    showHeader
                    showEmptyHeader={false}
                    onToggleShowHiddenFiles={() => handleToggleHiddenFiles("left", pane.id)}
                  />
                </SftpPaneWrapper>
              ))}
              {/* Loading overlay for left pane - shown when loading text content */}
              {loadingTextContent && textEditorTarget?.side === "left" && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-30">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 size={24} className="animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t("sftp.status.loading")}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div
            className="absolute min-w-0 bg-background flex flex-col transition-[left,top,width,height] duration-150 ease-out"
            style={resolveTwoPaneMagnificationStyle('right', isWideSplit, magnifiedSide === 'right')}
            data-sftp-pane-side="right"
            inert={magnifiedSide === 'left' ? true : undefined}
            onClick={() => handlePaneFocus("right")}
            onFocusCapture={() => handlePaneFocus("right")}
          >
            {/* Focus indicator triangle */}
            {focusedSide === "right" && (
              <div
                className="absolute top-0 left-0 z-50 pointer-events-none"
                style={{
                  width: 0,
                  height: 0,
                  borderStyle: 'solid',
                  borderWidth: '12px 12px 0 0',
                  borderColor: 'hsl(var(--primary)) transparent transparent transparent',
                }}
              />
            )}
            {/* Right side tab bar - only show when there are tabs */}
            {rightTabsInfo.length > 0 && (
              <SftpTabBar
                tabs={rightTabsInfo}
                side="right"
                onSelectTab={handleSelectTabRightWithFocus}
                onCloseTab={handleCloseTabRight}
                onAddTab={handleAddTabRightWithFocus}
                onReorderTabs={handleReorderTabsRight}
                onMoveTabToOtherSide={handleMoveTabFromLeftToRight}
                onDuplicateTab={handleDuplicateTabRightWithFocus}
              />
            )}
            <div className="relative flex-1 min-h-0">
              {rightPanes.map((pane, idx) => (
                <SftpPaneWrapper
                  key={pane.id}
                  side="right"
                  paneId={pane.id}
                  isFirstPane={idx === 0}
                >
                  <SftpPaneView
                    side="right"
                    pane={pane}
                    dialogActionScopeId={dialogActionScopeIdRef.current}
                    isPaneFocused={focusedSide === "right"}
                    sftpDefaultViewMode={sftpDefaultViewMode}
                    showHeader
                    showEmptyHeader={false}
                    onToggleShowHiddenFiles={() => handleToggleHiddenFiles("right", pane.id)}
                  />
                </SftpPaneWrapper>
              ))}
              {/* Loading overlay for right pane - shown when loading text content */}
              {loadingTextContent && textEditorTarget?.side === "right" && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-30">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 size={24} className="animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t("sftp.status.loading")}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          {magnifiedSide && showMagnificationHint && (
            <div
              className="pointer-events-none absolute bottom-4 right-4 z-[60] rounded border border-border/70 bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm animate-in fade-in duration-150"
              data-section="pane-magnification-hint"
            >
              {t('terminal.paneMagnification.hint')}: {t('terminal.layer.sftp')}
              {paneMagnificationShortcutLabel ? ` · ${paneMagnificationShortcutLabel} / Esc` : ' · Esc'}
            </div>
          )}
        </div>

        <SftpOverlays
          hosts={effectiveHosts}
          connectedHosts={connectedHosts}
          sftp={sftp}
          visibleTransfers={visibleTransfers}
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
          t={t}
        />
      </div>
    </SftpContextProvider>
  );
};

export const sftpViewAreEqual = (prev: SftpViewProps, next: SftpViewProps): boolean =>
  prev.hosts === next.hosts &&
  prev.writableHosts === next.writableHosts &&
  sftpPickerSessionsEqual(prev.sessions, next.sessions) &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.knownHosts === next.knownHosts &&
  prev.groupConfigs === next.groupConfigs &&
  prev.proxyProfiles === next.proxyProfiles &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.keyBindings === next.keyBindings &&
  prev.paneMagnificationRef === next.paneMagnificationRef &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  // Only these terminal connection settings affect SFTP connection
  // resolution today; compare them directly rather than the whole object
  // so unrelated terminal-setting changes don't tear the panel down.
  prev.terminalSettings?.verifyHostKeys === next.terminalSettings?.verifyHostKeys &&
  prev.terminalSettings?.keepaliveInterval === next.terminalSettings?.keepaliveInterval &&
  prev.terminalSettings?.keepaliveCountMax === next.terminalSettings?.keepaliveCountMax;

export const SftpView = memo(SftpViewInner, sftpViewAreEqual);
SftpView.displayName = "SftpView";
