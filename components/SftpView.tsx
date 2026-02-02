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

import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useIsSftpActive } from "../application/state/activeTabStore";
import { useSftpState } from "../application/state/useSftpState";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { useSettingsState } from "../application/state/useSettingsState";
import { logger } from "../lib/logger";
import { useRenderTracker } from "../lib/useRenderTracker";
import { cn } from "../lib/utils";
import { Host, Identity, SSHKey } from "../types";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
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
import { sftpFocusStore, SftpFocusedSide } from "./sftp/hooks/useSftpFocusedPane";

// Wrapper component that subscribes to activeTabId for CSS visibility
// This isolates the activeTabId subscription - only this component re-renders on tab switch
// Uses visibility:hidden pattern from App.tsx for smooth tab switching
// Main SftpView component
interface SftpViewProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
}

const SftpViewInner: React.FC<SftpViewProps> = ({ hosts, keys, identities }) => {
  const { t } = useI18n();
  const isActive = useIsSftpActive();
  const { sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles, hotkeyScheme, keyBindings } = useSettingsState();

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

  const sftp = useSftpState(hosts, keys, identities, fileWatchHandlers);

  // Get stream transfer functions for optimized downloads
  const { showSaveDialog, startStreamTransfer } = useSftpBackend();

  // Store sftp in a ref so callbacks can access the latest instance
  // without needing to re-create when sftp changes
  const sftpRef = useRef(sftp);
  sftpRef.current = sftp;

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
    isActive,
  });

  // Handle pane focus when clicking on a pane container
  const handlePaneFocus = useCallback((side: SftpFocusedSide) => {
    sftpFocusStore.setFocusedSide(side);
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

  const visibleTransfers = useMemo(
    () => sftp.transfers.slice(-5),
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

  return (
    <SftpContextProvider
      hosts={hosts}
      draggedFiles={draggedFiles}
      dragCallbacks={dragCallbacks}
      leftCallbacks={leftCallbacks}
      rightCallbacks={rightCallbacks}
      showHiddenFiles={sftpShowHiddenFiles}
    >
      <div
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
            {/* Left side tab bar - only show when there are tabs */}
            {leftTabsInfo.length > 0 && (
              <SftpTabBar
                tabs={leftTabsInfo}
                side="left"
                onSelectTab={handleSelectTabLeft}
                onCloseTab={handleCloseTabLeft}
                onAddTab={handleAddTabLeft}
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
                    showHeader
                    showEmptyHeader={false}
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
            {/* Right side tab bar - only show when there are tabs */}
            {rightTabsInfo.length > 0 && (
              <SftpTabBar
                tabs={rightTabsInfo}
                side="right"
                onSelectTab={handleSelectTabRight}
                onCloseTab={handleCloseTabRight}
                onAddTab={handleAddTabRight}
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
                    showHeader
                    showEmptyHeader={false}
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
          showFileOpenerDialog={showFileOpenerDialog}
          setShowFileOpenerDialog={setShowFileOpenerDialog}
          fileOpenerTarget={fileOpenerTarget}
          setFileOpenerTarget={setFileOpenerTarget}
          handleFileOpenerSelect={handleFileOpenerSelect}
          handleSelectSystemApp={handleSelectSystemApp}
          t={t}
        />
      </div>
    </SftpContextProvider>
  );
};

const sftpViewAreEqual = (prev: SftpViewProps, next: SftpViewProps): boolean =>
  prev.hosts === next.hosts && prev.keys === next.keys && prev.identities === next.identities;

export const SftpView = memo(SftpViewInner, sftpViewAreEqual);
SftpView.displayName = "SftpView";
