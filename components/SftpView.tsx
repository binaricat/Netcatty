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

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useIsSftpActive } from "../application/state/activeTabStore";
import { useSftpState } from "../application/state/useSftpState";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { HotkeyScheme, KeyBinding } from "../domain/models";
import { logger } from "../lib/logger";
import { useRenderTracker } from "../lib/useRenderTracker";
import { cn } from "../lib/utils";
import { useInstantThemeSwitch } from "../lib/useInstantThemeSwitch";
import { Host, Identity, SSHKey } from "../types";
import { resolveGroupDefaults, applyGroupDefaults } from "../domain/groupConfig";
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
import { sftpFocusStore, SftpFocusedSide, useSftpFocusedSide } from "./sftp/hooks/useSftpFocusedPane";
import { keepOnlyActivePaneSelections, keepOnlyPaneSelections } from "./sftp/hooks/selectionScope";


// Wrapper component that subscribes to activeTabId for CSS visibility
// This isolates the activeTabId subscription - only this component re-renders on tab switch
// Uses visibility:hidden pattern from App.tsx for smooth tab switching
// Main SftpView component
interface SftpViewProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  groupConfigs?: import('../domain/models').GroupConfig[];
  updateHosts: (hosts: Host[]) => void;
  sftpDefaultViewMode: "list" | "tree";
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (enabled: boolean) => void;
}

const SftpViewInner: React.FC<SftpViewProps> = ({
  hosts,
  keys,
  identities,
  groupConfigs = [],
  updateHosts,
  sftpDefaultViewMode,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
}) => {
  const { t } = useI18n();
  const isActive = useIsSftpActive();
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogActionScopeIdRef = useRef("sftp-main-view");

  useInstantThemeSwitch(rootRef);

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

  const sftpOptions = useMemo(() => ({
    ...fileWatchHandlers,
    useCompressedUpload: sftpUseCompressedUpload,
    defaultShowHiddenFiles: sftpShowHiddenFiles,
  }), [fileWatchHandlers, sftpUseCompressedUpload, sftpShowHiddenFiles]);

  // Pre-resolve group defaults so SFTP connections inherit group config
  const effectiveHosts = useMemo(() =>
    hosts.map(h => {
      if (!h.group) return h;
      const defaults = resolveGroupDefaults(h.group, groupConfigs);
      return applyGroupDefaults(h, defaults);
    }),
    [hosts, groupConfigs],
  );

  const sftp = useSftpState(effectiveHosts, keys, identities, sftpOptions);

  // Get backend helpers for file downloads and local filesystem writes.
  const {
    showSaveDialog,
    selectDirectory,
    startStreamTransfer,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    listLocalDir,
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
    return registerEditorSftpWriterScoped((connectionId, expectedHostId, filePath, content, encoding) =>
      sftpRef.current.writeTextFileByConnection(connectionId, expectedHostId, filePath, content, encoding),
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

  // Handle pane focus when clicking on a pane container
  // Clear the opposite side's selection so file operations only affect the focused pane
  const handlePaneFocus = useCallback((side: SftpFocusedSide, targetTabId?: string) => {
    const prevSide = sftpFocusStore.getFocusedSide();
    sftpFocusStore.setFocusedSide(side);
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
    startStreamTransfer,
    getSftpIdForConnection: sftp.getSftpIdForConnection,
    listLocalFiles: listLocalDir,
  });

  const visibleTransfers = useMemo(
    () => [...sftp.transfers].filter((t) => !t.parentTaskId).reverse().slice(0, 5),
    [sftp.transfers],
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
    handleHostSelectLeft,
    handleHostSelectRight,
  } = useSftpViewTabs({ sftp, sftpRef });

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
        ref={rootRef}
        className={cn(
          "absolute inset-0 min-h-0 flex flex-col",
          isActive ? "z-20" : "",
        )}
        style={containerStyle}
      >
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0 border-t border-border/70">
          <div
            className="relative border-r border-border/70 flex flex-col"
            onClick={() => handlePaneFocus("left")}
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
            className="relative flex flex-col"
            onClick={() => handlePaneFocus("right")}
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
        </div>

        <SftpOverlays
          hosts={hosts}
          sftp={sftp}
          visibleTransfers={visibleTransfers}
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

const sftpViewAreEqual = (prev: SftpViewProps, next: SftpViewProps): boolean =>
  prev.hosts === next.hosts &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.groupConfigs === next.groupConfigs &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.keyBindings === next.keyBindings &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap;

export const SftpView = memo(SftpViewInner, sftpViewAreEqual);
SftpView.displayName = "SftpView";
