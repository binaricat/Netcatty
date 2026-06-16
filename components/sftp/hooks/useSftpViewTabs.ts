import React, { useCallback, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { Host } from "../../../types";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { editorTabStore } from "../../../application/state/editorTabStore";
import type { EditorTab, EditorTabId } from "../../../application/state/editorTabStore";
import { releaseEditorTabSaveCoordinator, saveEditorTab } from "../../../application/state/editorTabSave";
import { promptUnsavedChanges } from "../../editor/UnsavedChangesDialog";
import {
  getSftpTabDuplicateRequest,
  type SftpTabDuplicateMode,
} from "../sftpTabDuplication";

interface UseSftpViewTabsParams {
  sftp: SftpStateApi;
  sftpRef: MutableRefObject<SftpStateApi>;
  hosts?: Host[];
}

interface UseSftpViewTabsResult {
  leftPanes: SftpStateApi["leftPane"][];
  rightPanes: SftpStateApi["rightPane"][];
  leftTabsInfo: { id: string; label: string; isLocal: boolean; hostId: string | null; canDuplicate: boolean }[];
  rightTabsInfo: { id: string; label: string; isLocal: boolean; hostId: string | null; canDuplicate: boolean }[];
  showHostPickerLeft: boolean;
  showHostPickerRight: boolean;
  hostSearchLeft: string;
  hostSearchRight: string;
  setShowHostPickerLeft: React.Dispatch<React.SetStateAction<boolean>>;
  setShowHostPickerRight: React.Dispatch<React.SetStateAction<boolean>>;
  setHostSearchLeft: React.Dispatch<React.SetStateAction<string>>;
  setHostSearchRight: React.Dispatch<React.SetStateAction<string>>;
  handleAddTabLeft: () => string;
  handleAddTabRight: () => string;
  handleCloseTabLeft: (tabId: string) => Promise<void>;
  handleCloseTabRight: (tabId: string) => Promise<void>;
  handleSelectTabLeft: (tabId: string) => void;
  handleSelectTabRight: (tabId: string) => void;
  handleReorderTabsLeft: (draggedId: string, targetId: string, position: "before" | "after") => void;
  handleReorderTabsRight: (draggedId: string, targetId: string, position: "before" | "after") => void;
  handleMoveTabFromLeftToRight: (tabId: string) => void;
  handleMoveTabFromRightToLeft: (tabId: string) => void;
  handleDuplicateTabLeft: (tabId: string, mode: SftpTabDuplicateMode) => Promise<string | null>;
  handleDuplicateTabRight: (tabId: string, mode: SftpTabDuplicateMode) => Promise<string | null>;
  handleHostSelectLeft: (host: Host | "local") => void;
  handleHostSelectRight: (host: Host | "local") => void;
}

export const useSftpViewTabs = ({ sftp, sftpRef, hosts = [] }: UseSftpViewTabsParams): UseSftpViewTabsResult => {
  const [showHostPickerLeft, setShowHostPickerLeft] = useState(false);
  const [showHostPickerRight, setShowHostPickerRight] = useState(false);
  const [hostSearchLeft, setHostSearchLeft] = useState("");
  const [hostSearchRight, setHostSearchRight] = useState("");
  const hostsRef = React.useRef(hosts);
  hostsRef.current = hosts;

  const handleAddTabLeft = useCallback(() => {
    const tabId = sftpRef.current.addTab("left");
    setShowHostPickerLeft(true);
    return tabId;
  }, [sftpRef]);

  const handleAddTabRight = useCallback(() => {
    const tabId = sftpRef.current.addTab("right");
    setShowHostPickerRight(true);
    return tabId;
  }, [sftpRef]);

  const confirmCloseEditorTabsByConnection = useCallback(async (connectionId: string): Promise<boolean> => {
    const choice = (tab: EditorTab) => promptUnsavedChanges(tab.fileName);
    const saveTab = async (id: EditorTabId) => {
      const ok = await saveEditorTab(id);
      const tab = editorTabStore.getTab(id);
      if (!ok || (tab && tab.content !== tab.baselineContent)) {
        throw new Error(tab?.saveError ?? "Save failed");
      }
    };
    return editorTabStore.confirmCloseBySession(
      connectionId,
      choice,
      saveTab,
      releaseEditorTabSaveCoordinator,
    );
  }, []);

  const handleCloseSftpTab = useCallback(async (side: "left" | "right", tabId: string) => {
    const sideTabs = side === "left" ? sftpRef.current.leftTabs : sftpRef.current.rightTabs;
    const pane = sideTabs.tabs.find((tab) => tab.id === tabId);
    const connectionId = pane?.connection?.id;
    if (connectionId) {
      const ok = await confirmCloseEditorTabsByConnection(connectionId);
      if (!ok) return;
    }
    sftpRef.current.closeTab(side, tabId);
  }, [confirmCloseEditorTabsByConnection, sftpRef]);

  const handleCloseTabLeft = useCallback((tabId: string) => (
    handleCloseSftpTab("left", tabId)
  ), [handleCloseSftpTab]);

  const handleCloseTabRight = useCallback((tabId: string) => (
    handleCloseSftpTab("right", tabId)
  ), [handleCloseSftpTab]);

  const handleSelectTabLeft = useCallback((tabId: string) => {
    sftpRef.current.selectTab("left", tabId);
  }, [sftpRef]);

  const handleSelectTabRight = useCallback((tabId: string) => {
    sftpRef.current.selectTab("right", tabId);
  }, [sftpRef]);

  const leftPanes = useMemo(
    () => (sftp.leftTabs.tabs.length > 0 ? sftp.leftTabs.tabs : [sftp.leftPane]),
    [sftp.leftTabs.tabs, sftp.leftPane],
  );
  const rightPanes = useMemo(
    () => (sftp.rightTabs.tabs.length > 0 ? sftp.rightTabs.tabs : [sftp.rightPane]),
    [sftp.rightTabs.tabs, sftp.rightPane],
  );

  const handleReorderTabsLeft = useCallback(
    (draggedId: string, targetId: string, position: "before" | "after") => {
      sftpRef.current.reorderTabs("left", draggedId, targetId, position);
    },
    [sftpRef],
  );

  const handleReorderTabsRight = useCallback(
    (draggedId: string, targetId: string, position: "before" | "after") => {
      sftpRef.current.reorderTabs("right", draggedId, targetId, position);
    },
    [sftpRef],
  );

  const handleMoveTabFromLeftToRight = useCallback((tabId: string) => {
    sftpRef.current.moveTabToOtherSide("left", tabId);
  }, [sftpRef]);

  const handleMoveTabFromRightToLeft = useCallback((tabId: string) => {
    sftpRef.current.moveTabToOtherSide("right", tabId);
  }, [sftpRef]);

  const handleDuplicateTab = useCallback(
    async (side: "left" | "right", tabId: string, mode: SftpTabDuplicateMode) => {
      const sideTabs = side === "left" ? sftpRef.current.leftTabs : sftpRef.current.rightTabs;
      const pane = sideTabs.tabs.find((tab) => tab.id === tabId);
      const request = getSftpTabDuplicateRequest(pane, mode);
      if (!request) return null;

      const host = request.kind === "local"
        ? "local"
        : hostsRef.current.find((item) => item.id === request.hostId);
      if (!host) return null;

      let duplicatedTabId: string | null = null;
      await sftpRef.current.connect(side, host, {
        forceNewTab: true,
        ignoreSharedCache: mode === "defaultPath",
        initialPath: request.path,
        onTabCreated: (createdTabId) => {
          duplicatedTabId = createdTabId;
        },
      });

      return duplicatedTabId;
    },
    [sftpRef],
  );

  const handleDuplicateTabLeft = useCallback(
    (tabId: string, mode: SftpTabDuplicateMode) => handleDuplicateTab("left", tabId, mode),
    [handleDuplicateTab],
  );

  const handleDuplicateTabRight = useCallback(
    (tabId: string, mode: SftpTabDuplicateMode) => handleDuplicateTab("right", tabId, mode),
    [handleDuplicateTab],
  );

  const handleHostSelectLeft = useCallback((host: Host | "local") => {
    sftpRef.current.connect("left", host);
    setShowHostPickerLeft(false);
  }, [sftpRef]);

  const handleHostSelectRight = useCallback((host: Host | "local") => {
    sftpRef.current.connect("right", host);
    setShowHostPickerRight(false);
  }, [sftpRef]);

  const leftTabsInfo = useMemo(
    () =>
      sftp.leftTabs.tabs.map((pane) => ({
        id: pane.id,
        label: pane.connection?.hostLabel || "New Tab",
        isLocal: pane.connection?.isLocal || false,
        hostId: pane.connection?.hostId || null,
        canDuplicate: pane.connection?.status === "connected",
      })),
    [sftp.leftTabs.tabs],
  );

  const rightTabsInfo = useMemo(
    () =>
      sftp.rightTabs.tabs.map((pane) => ({
        id: pane.id,
        label: pane.connection?.hostLabel || "New Tab",
        isLocal: pane.connection?.isLocal || false,
        hostId: pane.connection?.hostId || null,
        canDuplicate: pane.connection?.status === "connected",
      })),
    [sftp.rightTabs.tabs],
  );

  return {
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
  };
};
