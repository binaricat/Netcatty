import assert from "node:assert/strict";
import test from "node:test";

import { getTerminalPaneSnapshot, HIDDEN_TERMINAL_PANE_SNAPSHOT } from "./terminalPaneVisibility";
import type { Workspace } from "../types";

const createWorkspace = (
  id: string,
  sessionIds: string[],
  options: Partial<Pick<Workspace, "viewMode" | "focusedSessionId">> = {},
): Workspace => ({
  id,
  title: id,
  root: {
    id: `${id}-root`,
    type: "split",
    direction: "vertical",
    children: sessionIds.map((sessionId) => ({
      id: `${id}-${sessionId}`,
      type: "pane",
      sessionId,
    })),
  },
  viewMode: options.viewMode ?? "split",
  focusedSessionId: options.focusedSessionId,
});

test("terminal pane snapshot stays hidden for panes outside both workspace tabs", () => {
  const workspaceById = new Map<string, Workspace>([
    ["ws-a", createWorkspace("ws-a", ["a-1", "a-2"], { focusedSessionId: "a-1" })],
    ["ws-b", createWorkspace("ws-b", ["b-1", "b-2"], { focusedSessionId: "b-1" })],
    ["ws-c", createWorkspace("ws-c", ["c-1"])],
  ]);

  const before = getTerminalPaneSnapshot({
    activeTabId: "ws-a",
    sessionId: "c-1",
    sessionWorkspaceId: "ws-c",
    workspaceById,
    isTerminalLayerVisible: true,
  });
  const after = getTerminalPaneSnapshot({
    activeTabId: "ws-b",
    sessionId: "c-1",
    sessionWorkspaceId: "ws-c",
    workspaceById,
    isTerminalLayerVisible: true,
  });

  assert.equal(before, HIDDEN_TERMINAL_PANE_SNAPSHOT);
  assert.equal(after, before);
});

test("terminal pane snapshot distinguishes solo, split workspace, and focus workspace visibility", () => {
  const workspaceById = new Map<string, Workspace>([
    ["ws-split", createWorkspace("ws-split", ["s-1", "s-2"], { focusedSessionId: "s-1" })],
    ["ws-focus", createWorkspace("ws-focus", ["f-1", "f-2"], {
      viewMode: "focus",
      focusedSessionId: "f-2",
    })],
  ]);

  assert.equal(
    getTerminalPaneSnapshot({
      activeTabId: "solo-1",
      sessionId: "solo-1",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    "solo|solo-1",
  );
  assert.equal(
    getTerminalPaneSnapshot({
      activeTabId: "ws-split",
      sessionId: "s-2",
      sessionWorkspaceId: "ws-split",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    "workspace|split|ws-split|s-1",
  );
  assert.equal(
    getTerminalPaneSnapshot({
      activeTabId: "ws-focus",
      sessionId: "f-1",
      sessionWorkspaceId: "ws-focus",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    HIDDEN_TERMINAL_PANE_SNAPSHOT,
  );
  assert.equal(
    getTerminalPaneSnapshot({
      activeTabId: "ws-focus",
      sessionId: "f-2",
      sessionWorkspaceId: "ws-focus",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    "workspace|focus|ws-focus|f-2",
  );
});
