import { activeTabStore } from "../application/state/activeTabStore";
import type { Workspace } from "../types";

export const HIDDEN_TERMINAL_PANE_SNAPSHOT = "hidden";

export type TerminalPaneSnapshot =
  | typeof HIDDEN_TERMINAL_PANE_SNAPSHOT
  | `solo|${string}`
  | `workspace|split|${string}`
  | `workspace|focus|${string}|${string}`;

export type TerminalPaneFocusSnapshot = "na" | "focused" | "unfocused";

export type TerminalPaneHiddenSize = {
  width: number;
  height: number;
};

export type TerminalPaneStyle = {
  left?: string | number;
  top?: string | number;
  width?: string | number;
  height?: string | number;
  visibility?: string;
  pointerEvents?: string;
  zIndex?: number;
};

export function shouldUseTerminalPaneSplitLayout({
  workspace,
  sessionId,
  isVisible,
  hibernateHiddenTabs,
}: {
  workspace: Workspace | undefined;
  sessionId: string;
  isVisible: boolean;
  hibernateHiddenTabs: boolean;
}): boolean {
  if (!workspace) return false;
  if (workspace.viewMode === "split") return true;
  return !isVisible
    && !hibernateHiddenTabs
    && workspace.focusedSessionId !== sessionId;
}

export function shouldMeasureTerminalLayerLayout({
  isTerminalLayerVisible,
  hibernateHiddenTabs,
  workspaceArea,
}: {
  isTerminalLayerVisible: boolean;
  hibernateHiddenTabs: boolean;
  workspaceArea: TerminalPaneHiddenSize;
}): boolean {
  return isTerminalLayerVisible
    || (!hibernateHiddenTabs && (workspaceArea.width <= 0 || workspaceArea.height <= 0));
}

export function resolveInactiveTerminalPaneStyle<T extends TerminalPaneStyle>(
  layoutStyle: T,
  lastVisibleSize: TerminalPaneHiddenSize | null,
  hibernateHiddenTabs: boolean,
  preserveLastVisibleSize = false,
): T {
  return {
    ...layoutStyle,
    visibility: hibernateHiddenTabs ? "hidden" : "visible",
    pointerEvents: "none",
    zIndex: 0,
    ...((hibernateHiddenTabs || preserveLastVisibleSize) && lastVisibleSize
      ? {
        width: `${lastVisibleSize.width}px`,
        height: `${lastVisibleSize.height}px`,
      }
      : {}),
  };
}

export function resolveTerminalLayerSurfaceStyle(
  isActive: boolean,
  hibernateHiddenTabs: boolean,
): { visibility: "visible" | "hidden"; pointerEvents: "auto" | "none"; zIndex: number } {
  return {
    visibility: isActive || !hibernateHiddenTabs ? "visible" : "hidden",
    pointerEvents: isActive ? "auto" : "none",
    zIndex: isActive ? 10 : 0,
  };
}

interface GetTerminalPaneSnapshotOptions {
  activeTabId: string | null;
  sessionId: string;
  sessionWorkspaceId?: string;
  workspaceById: Map<string, Workspace>;
  isTerminalLayerVisible: boolean;
}

export function getTerminalPaneSnapshot({
  activeTabId,
  sessionId,
  sessionWorkspaceId,
  workspaceById,
  isTerminalLayerVisible,
}: GetTerminalPaneSnapshotOptions): TerminalPaneSnapshot {
  if (!isTerminalLayerVisible || !activeTabId) {
    return HIDDEN_TERMINAL_PANE_SNAPSHOT;
  }

  const activeWorkspace = workspaceById.get(activeTabId);
  if (activeWorkspace) {
    if (sessionWorkspaceId !== activeWorkspace.id) {
      return HIDDEN_TERMINAL_PANE_SNAPSHOT;
    }

    const focusedSessionId = activeWorkspace.focusedSessionId ?? "";
    if (activeWorkspace.viewMode === "focus") {
      return sessionId === focusedSessionId
        ? `workspace|focus|${activeWorkspace.id}|${focusedSessionId}`
        : HIDDEN_TERMINAL_PANE_SNAPSHOT;
    }

    return `workspace|split|${activeWorkspace.id}`;
  }

  return activeTabId === sessionId
    ? `solo|${sessionId}`
    : HIDDEN_TERMINAL_PANE_SNAPSHOT;
}

export function parseTerminalPaneSnapshot(snapshot: TerminalPaneSnapshot): {
  isVisible: boolean;
  mode: "hidden" | "solo" | "split" | "focus";
  workspaceId: string | null;
  focusedSessionId: string | null;
} {
  if (snapshot === HIDDEN_TERMINAL_PANE_SNAPSHOT) {
    return {
      isVisible: false,
      mode: "hidden",
      workspaceId: null,
      focusedSessionId: null,
    };
  }

  const parts = snapshot.split("|");
  if (parts[0] === "solo") {
    return {
      isVisible: true,
      mode: "solo",
      workspaceId: null,
      focusedSessionId: null,
    };
  }

  if (parts[1] === "focus") {
    return {
      isVisible: true,
      mode: "focus",
      workspaceId: parts[2] || null,
      focusedSessionId: parts[3] || null,
    };
  }

  return {
    isVisible: true,
    mode: "split",
    workspaceId: parts[2] || null,
    focusedSessionId: null,
  };
}

export function getTerminalPaneFocusSnapshot({
  activeTabId: activeTabIdOverride,
  sessionId,
  sessionWorkspaceId,
  workspaceById,
}: {
  activeTabId?: string | null;
  sessionId: string;
  sessionWorkspaceId?: string;
  workspaceById: Map<string, Workspace>;
}): TerminalPaneFocusSnapshot {
  const activeTabId = activeTabIdOverride ?? activeTabStore.getActiveTabId();
  if (!activeTabId) return "na";

  const activeWorkspace = workspaceById.get(activeTabId);
  if (!activeWorkspace || activeWorkspace.viewMode === "focus") return "na";
  if (sessionWorkspaceId !== activeWorkspace.id) return "na";

  return activeWorkspace.focusedSessionId === sessionId ? "focused" : "unfocused";
}

/** Combined visibility + focus snapshot for a single useSyncExternalStore subscription. */
export function getTerminalPaneRenderSnapshot(
  options: GetTerminalPaneSnapshotOptions,
): string {
  const pane = getTerminalPaneSnapshot(options);
  if (pane === HIDDEN_TERMINAL_PANE_SNAPSHOT) {
    return HIDDEN_TERMINAL_PANE_SNAPSHOT;
  }
  const focus = getTerminalPaneFocusSnapshot({
    activeTabId: options.activeTabId,
    sessionId: options.sessionId,
    sessionWorkspaceId: options.sessionWorkspaceId,
    workspaceById: options.workspaceById,
  });
  return `${pane}|${focus}`;
}

export function parseTerminalPaneRenderSnapshot(snapshot: string): {
  paneState: ReturnType<typeof parseTerminalPaneSnapshot>;
  isFocusedPane: boolean;
} {
  if (snapshot === HIDDEN_TERMINAL_PANE_SNAPSHOT) {
    return {
      paneState: parseTerminalPaneSnapshot(HIDDEN_TERMINAL_PANE_SNAPSHOT),
      isFocusedPane: false,
    };
  }

  const focusSep = snapshot.lastIndexOf("|");
  const focusToken = snapshot.slice(focusSep + 1);
  const paneSnapshot = snapshot.slice(0, focusSep) as TerminalPaneSnapshot;
  const paneState = parseTerminalPaneSnapshot(paneSnapshot);

  return {
    paneState,
    isFocusedPane: focusToken === "focused",
  };
}
