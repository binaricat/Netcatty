import type { Workspace } from "../types";

export const HIDDEN_TERMINAL_PANE_SNAPSHOT = "hidden";

export type TerminalPaneSnapshot =
  | typeof HIDDEN_TERMINAL_PANE_SNAPSHOT
  | `solo|${string}`
  | `workspace|split|${string}|${string}`
  | `workspace|focus|${string}|${string}`;

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

    return `workspace|split|${activeWorkspace.id}|${focusedSessionId}`;
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

  return {
    isVisible: true,
    mode: parts[1] === "focus" ? "focus" : "split",
    workspaceId: parts[2] || null,
    focusedSessionId: parts[3] || null,
  };
}
