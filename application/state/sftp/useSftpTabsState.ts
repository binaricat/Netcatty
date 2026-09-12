import React, { useCallback, useMemo, useRef, useState } from "react";
import { createEmptyPane, EMPTY_LEFT_PANE_ID, EMPTY_RIGHT_PANE_ID, SftpPane, SftpSideTabs } from "./types";
import { logger } from "../../../lib/logger";

interface SftpTabsState {
  leftTabs: SftpSideTabs;
  rightTabs: SftpSideTabs;
  leftTabsRef: React.MutableRefObject<SftpSideTabs>;
  rightTabsRef: React.MutableRefObject<SftpSideTabs>;
  setLeftTabs: React.Dispatch<React.SetStateAction<SftpSideTabs>>;
  setRightTabs: React.Dispatch<React.SetStateAction<SftpSideTabs>>;
  leftPane: SftpPane;
  rightPane: SftpPane;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => void;
  updateActiveTab: (side: "left" | "right", updater: (pane: SftpPane) => SftpPane) => void;
  clearSelectionsExcept: (target: { side: "left" | "right"; tabId: string } | null) => void;
  setTabShowHiddenFiles: (side: "left" | "right", tabId: string, showHiddenFiles: boolean) => void;
  addTab: (side: "left" | "right") => string;
  closeTab: (side: "left" | "right", tabId: string) => void;
  selectTab: (side: "left" | "right", tabId: string) => void;
  reorderTabs: (
    side: "left" | "right",
    draggedId: string,
    targetId: string,
    position: "before" | "after",
  ) => void;
  moveTabToOtherSide: (fromSide: "left" | "right", tabId: string) => void;
  getTabsInfo: (side: "left" | "right") => Array<{
    id: string;
    label: string;
    isLocal: boolean;
    hostId: string | null;
  }>;
  getActiveTabId: (side: "left" | "right") => string | null;
}

const EMPTY_SELECTION = new Set<string>();

export function removeSftpTabFromState(prev: SftpSideTabs, tabId: string): SftpSideTabs {
  const tabIndex = prev.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex === -1) return prev;

  let activeTabId: string | null = null;
  if (prev.tabs.length > 1) {
    if (prev.activeTabId === tabId) {
      const nextIndex = tabIndex < prev.tabs.length - 1 ? tabIndex + 1 : tabIndex - 1;
      activeTabId = prev.tabs[nextIndex]?.id ?? null;
    } else {
      activeTabId = prev.activeTabId;
    }
  }

  return {
    tabs: prev.tabs.filter((tab) => tab.id !== tabId),
    activeTabId,
  };
}

export function closeSftpTabStateImmediately(params: {
  tabsRef: { current: SftpSideTabs };
  tabId: string;
  setTabs: (updater: (prev: SftpSideTabs) => SftpSideTabs) => void;
}): void {
  params.tabsRef.current = removeSftpTabFromState(params.tabsRef.current, params.tabId);
  params.setTabs((prev) => {
    const next = removeSftpTabFromState(prev, params.tabId);
    params.tabsRef.current = next;
    return next;
  });
}

export const useSftpTabsState = ({
  defaultShowHiddenFiles = false,
}: {
  defaultShowHiddenFiles?: boolean;
} = {}): SftpTabsState => {
  const [leftTabs, setLeftTabs] = useState<SftpSideTabs>({
    tabs: [],
    activeTabId: null,
  });
  const [rightTabs, setRightTabs] = useState<SftpSideTabs>({
    tabs: [],
    activeTabId: null,
  });

  const leftTabsRef = useRef(leftTabs);
  const rightTabsRef = useRef(rightTabs);
  const defaultShowHiddenFilesRef = useRef(defaultShowHiddenFiles);
  leftTabsRef.current = leftTabs;
  rightTabsRef.current = rightTabs;
  defaultShowHiddenFilesRef.current = defaultShowHiddenFiles;

  const getActivePane = useCallback((side: "left" | "right"): SftpPane | null => {
    const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
    if (!sideTabs.activeTabId) return null;
    return sideTabs.tabs.find((t) => t.id === sideTabs.activeTabId) || null;
  }, []);

  const leftPane = useMemo(() => {
    const pane = leftTabs.activeTabId
      ? leftTabs.tabs.find((t) => t.id === leftTabs.activeTabId)
      : null;
    return pane || createEmptyPane(EMPTY_LEFT_PANE_ID, defaultShowHiddenFilesRef.current);
  }, [leftTabs]);

  const rightPane = useMemo(() => {
    const pane = rightTabs.activeTabId
      ? rightTabs.tabs.find((t) => t.id === rightTabs.activeTabId)
      : null;
    return pane || createEmptyPane(EMPTY_RIGHT_PANE_ID, defaultShowHiddenFilesRef.current);
  }, [rightTabs]);

  const updateTab = useCallback(
    (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => {
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      setTabs((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === tabId ? updater(t) : t)),
      }));
    },
    [],
  );

  const updateActiveTab = useCallback(
    (side: "left" | "right", updater: (pane: SftpPane) => SftpPane) => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      if (!sideTabs.activeTabId) return;
      updateTab(side, sideTabs.activeTabId, updater);
    },
    [updateTab],
  );

  const clearSelectionsExcept = useCallback(
    (target: { side: "left" | "right"; tabId: string } | null) => {
      const clearSideSelections = (
        prev: SftpSideTabs,
        side: "left" | "right",
      ): SftpSideTabs => {
        let changed = false;
        const tabs = prev.tabs.map((tab) => {
          const shouldKeepSelection =
            target?.side === side && target.tabId === tab.id;
          if (shouldKeepSelection || tab.selectedFiles.size === 0) {
            return tab;
          }
          changed = true;
          return { ...tab, selectedFiles: EMPTY_SELECTION };
        });
        return changed ? { ...prev, tabs } : prev;
      };

      setLeftTabs((prev) => clearSideSelections(prev, "left"));
      setRightTabs((prev) => clearSideSelections(prev, "right"));
    },
    [],
  );

  const setTabShowHiddenFiles = useCallback(
    (side: "left" | "right", tabId: string, showHiddenFiles: boolean) => {
      updateTab(side, tabId, (prev) => {
        if (prev.showHiddenFiles === showHiddenFiles) {
          return prev;
        }
        return {
          ...prev,
          showHiddenFiles,
        };
      });
    },
    [updateTab],
  );

  const addTab = useCallback(
    (side: "left" | "right") => {
      const newPane = createEmptyPane(undefined, defaultShowHiddenFilesRef.current);
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      setTabs((prev) => ({
        tabs: [...prev.tabs, newPane],
        activeTabId: newPane.id,
      }));
      return newPane.id;
    },
    [],
  );

  const closeTab = useCallback(
    (side: "left" | "right", tabId: string) => {
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      const tabsRef = side === "left" ? leftTabsRef : rightTabsRef;
      // Make the removal visible to in-flight SFTP work immediately, before
      // React commits the state update, so a late connection cannot register
      // itself to a tab the user has already closed.
      closeSftpTabStateImmediately({
        tabsRef,
        tabId,
        setTabs,
      });
    },
    [],
  );

  const selectTab = useCallback(
    (side: "left" | "right", tabId: string) => {
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      setTabs((prev) => ({
        ...prev,
        activeTabId: tabId,
      }));
    },
    [],
  );

  const reorderTabs = useCallback(
    (
      side: "left" | "right",
      draggedId: string,
      targetId: string,
      position: "before" | "after",
    ) => {
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;
      setTabs((prev) => {
        const tabs = [...prev.tabs];
        const draggedIndex = tabs.findIndex((t) => t.id === draggedId);
        const targetIndex = tabs.findIndex((t) => t.id === targetId);

        if (draggedIndex === -1 || targetIndex === -1) return prev;

        const [draggedTab] = tabs.splice(draggedIndex, 1);
        const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
        const adjustedIndex = draggedIndex < targetIndex ? insertIndex - 1 : insertIndex;
        tabs.splice(adjustedIndex, 0, draggedTab);

        return { ...prev, tabs };
      });
    },
    [],
  );

  const moveTabToOtherSide = useCallback(
    (fromSide: "left" | "right", tabId: string) => {
      const sourceTabs = fromSide === "left" ? leftTabsRef.current : rightTabsRef.current;
      const setSourceTabs = fromSide === "left" ? setLeftTabs : setRightTabs;
      const setTargetTabs = fromSide === "left" ? setRightTabs : setLeftTabs;

      const tabToMove = sourceTabs.tabs.find((t) => t.id === tabId);
      if (!tabToMove) return;

      logger.info("[SFTP] Moving tab to other side", {
        fromSide,
        toSide: fromSide === "left" ? "right" : "left",
        tabId,
        hostLabel: tabToMove.connection?.hostLabel,
      });

      setSourceTabs((prev) => {
        const newTabs = prev.tabs.filter((t) => t.id !== tabId);
        let newActiveTabId: string | null = null;
        if (newTabs.length > 0) {
          if (prev.activeTabId === tabId) {
            newActiveTabId = newTabs[0].id;
          } else {
            newActiveTabId = prev.activeTabId;
          }
        }
        return { tabs: newTabs, activeTabId: newActiveTabId };
      });

      setTargetTabs((prev) => ({
        tabs: [...prev.tabs, tabToMove],
        activeTabId: tabToMove.id,
      }));
    },
    [],
  );

  const DEFAULT_TAB_LABEL = "New Tab";

  const getTabsInfo = useCallback(
    (side: "left" | "right") => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      return sideTabs.tabs.map((pane) => ({
        id: pane.id,
        label: pane.connection?.hostLabel || DEFAULT_TAB_LABEL,
        isLocal: pane.connection?.isLocal || false,
        hostId: pane.connection?.hostId || null,
      }));
    },
    [],
  );

  const getActiveTabId = useCallback(
    (side: "left" | "right") => {
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      return sideTabs.activeTabId;
    },
    [],
  );

  return {
    leftTabs,
    rightTabs,
    leftTabsRef,
    rightTabsRef,
    setLeftTabs,
    setRightTabs,
    leftPane,
    rightPane,
    getActivePane,
    updateTab,
    updateActiveTab,
    clearSelectionsExcept,
    setTabShowHiddenFiles,
    addTab,
    closeTab,
    selectTab,
    reorderTabs,
    moveTabToOtherSide,
    getTabsInfo,
    getActiveTabId,
  };
};
