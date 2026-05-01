import React, { useCallback, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { Host } from "../../../types";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { editorTabStore } from "../../../application/state/editorTabStore";
import type { EditorTab, EditorTabId } from "../../../application/state/editorTabStore";
import { releaseEditorTabSaveCoordinator, saveEditorTab } from "../../../application/state/editorTabSave";
import { promptUnsavedChanges } from "../../editor/UnsavedChangesDialog";

interface UseSftpViewTabsParams {
  sftp: SftpStateApi;
  sftpRef: MutableRefObject<SftpStateApi>;
}

interface UseSftpViewTabsResult {
  leftPanes: SftpStateApi["leftPane"][];
  rightPanes: SftpStateApi["rightPane"][];
  leftTabsInfo: { id: string; label: string; isLocal: boolean; hostId: string | null }[];
  rightTabsInfo: { id: string; label: string; isLocal: boolean; hostId: string | null }[];
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
  handleHostSelectLeft: (host: Host | "local") => void;
  handleHostSelectRight: (host: Host | "local") => void;
}

export const useSftpViewTabs = ({ sftp, sftpRef }: UseSftpViewTabsParams): UseSftpViewTabsResult => {
  const [showHostPickerLeft, setShowHostPickerLeft] = useState(false);
  const [showHostPickerRight, setShowHostPickerRight] = useState(false);
  const [hostSearchLeft, setHostSearchLeft] = useState("");
  const [hostSearchRight, setHostSearchRight] = useState("");

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
    handleHostSelectLeft,
    handleHostSelectRight,
  };
};
