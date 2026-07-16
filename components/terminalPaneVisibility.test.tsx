import assert from "node:assert/strict";
import test from "node:test";

import {
  getTerminalPaneRenderSnapshot,
  getTerminalPaneSnapshot,
  HIDDEN_TERMINAL_PANE_SNAPSHOT,
  parseTerminalPaneRenderSnapshot,
  resolveInactiveTerminalPaneStyle,
  resolveTerminalLayerSurfaceStyle,
  shouldMeasureTerminalLayerLayout,
  shouldUseTerminalPaneSplitLayout,
} from "./terminalPaneVisibility";
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
    "workspace|split|ws-split",
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

test("terminal pane render snapshot combines visibility and focus in one token", () => {
  const workspaceById = new Map<string, Workspace>([
    ["ws-split", createWorkspace("ws-split", ["s-1", "s-2"], { focusedSessionId: "s-1" })],
  ]);

  assert.equal(
    getTerminalPaneRenderSnapshot({
      activeTabId: "ws-split",
      sessionId: "s-1",
      sessionWorkspaceId: "ws-split",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    "workspace|split|ws-split|focused",
  );
  assert.equal(
    getTerminalPaneRenderSnapshot({
      activeTabId: "ws-split",
      sessionId: "s-2",
      sessionWorkspaceId: "ws-split",
      workspaceById,
      isTerminalLayerVisible: true,
    }),
    "workspace|split|ws-split|unfocused",
  );

  const parsed = parseTerminalPaneRenderSnapshot("workspace|split|ws-split|focused");
  assert.equal(parsed.paneState.isVisible, true);
  assert.equal(parsed.paneState.mode, "split");
  assert.equal(parsed.isFocusedPane, true);
});

test("hidden focus workspaces keep the focused pane full-size and other panes split", () => {
  const workspace = createWorkspace("ws-focus", ["f-1", "f-2"], {
    viewMode: "focus",
    focusedSessionId: "f-2",
  });

  assert.equal(shouldUseTerminalPaneSplitLayout({
    workspace,
    sessionId: "f-2",
    isVisible: false,
    hibernateHiddenTabs: false,
  }), false);
  assert.equal(shouldUseTerminalPaneSplitLayout({
    workspace,
    sessionId: "f-1",
    isVisible: false,
    hibernateHiddenTabs: false,
  }), true);
  assert.equal(shouldUseTerminalPaneSplitLayout({
    workspace,
    sessionId: "f-1",
    isVisible: false,
    hibernateHiddenTabs: true,
  }), false);
});

test("default and explicit split workspaces always use split layout geometry", () => {
  // Drag-to-split workspaces omit viewMode (undefined means tiled split).
  const defaultSplit: Workspace = {
    ...createWorkspace("ws-default", ["d-1", "d-2"], { focusedSessionId: "d-1" }),
    viewMode: undefined,
  };
  const explicitSplit = createWorkspace("ws-split", ["s-1", "s-2"], {
    viewMode: "split",
    focusedSessionId: "s-1",
  });

  for (const workspace of [defaultSplit, explicitSplit]) {
    assert.equal(shouldUseTerminalPaneSplitLayout({
      workspace,
      sessionId: workspace.focusedSessionId ?? "x",
      isVisible: true,
      hibernateHiddenTabs: false,
    }), true);
    assert.equal(shouldUseTerminalPaneSplitLayout({
      workspace,
      sessionId: "other",
      isVisible: false,
      hibernateHiddenTabs: false,
    }), true);
    assert.equal(shouldUseTerminalPaneSplitLayout({
      workspace,
      sessionId: "other",
      isVisible: false,
      hibernateHiddenTabs: true,
    }), true);
  }
});

test("hidden terminal layers measure once when their layout must stay active", () => {
  assert.equal(shouldMeasureTerminalLayerLayout({
    isTerminalLayerVisible: false,
    keepHiddenLayoutActive: true,
    workspaceArea: { width: 0, height: 0 },
  }), true);
  assert.equal(shouldMeasureTerminalLayerLayout({
    isTerminalLayerVisible: false,
    keepHiddenLayoutActive: true,
    workspaceArea: { width: 1200, height: 800 },
  }), false);
  assert.equal(shouldMeasureTerminalLayerLayout({
    isTerminalLayerVisible: false,
    keepHiddenLayoutActive: false,
    workspaceArea: { width: 0, height: 0 },
  }), false);
  assert.equal(shouldMeasureTerminalLayerLayout({
    isTerminalLayerVisible: true,
    keepHiddenLayoutActive: false,
    workspaceArea: { width: 0, height: 0 },
  }), true);
});

test("inactive terminal pane keeps rendering when hibernate is disabled", () => {
  const inactiveStyle = resolveInactiveTerminalPaneStyle(
    { left: "40px", top: 0, width: "640px", height: "480px" },
    { width: 1180, height: 720 },
    false,
  );

  assert.equal(inactiveStyle.left, "40px");
  assert.equal(inactiveStyle.top, 0);
  assert.equal(inactiveStyle.visibility, "visible");
  assert.equal(inactiveStyle.pointerEvents, "none");
  assert.equal(inactiveStyle.zIndex, 0);
  assert.equal(inactiveStyle.width, "640px");
  assert.equal(inactiveStyle.height, "480px");
});

test("inactive full-size panes keep their last visible dimensions without hibernate", () => {
  const inactiveStyle = resolveInactiveTerminalPaneStyle(
    { left: 0, top: 0, width: "100%", height: "100%" },
    { width: 1180, height: 720 },
    false,
    true,
  );

  assert.equal(inactiveStyle.visibility, "visible");
  assert.equal(inactiveStyle.width, "1180px");
  assert.equal(inactiveStyle.height, "720px");
});

test("inactive terminal pane is hidden only when hibernate is enabled", () => {
  const inactiveStyle = resolveInactiveTerminalPaneStyle(
    { left: 0, top: 0, width: "100%", height: "100%" },
    { width: 1180, height: 720 },
    true,
  );

  assert.equal(inactiveStyle.visibility, "hidden");
  assert.equal(inactiveStyle.pointerEvents, "none");
  assert.equal(inactiveStyle.zIndex, 0);
});

test("terminal layer stays rendered behind other app surfaces unless hibernate is enabled", () => {
  assert.deepEqual(resolveTerminalLayerSurfaceStyle(false, false), {
    visibility: "visible",
    pointerEvents: "none",
    zIndex: 0,
  });
  assert.deepEqual(resolveTerminalLayerSurfaceStyle(false, true), {
    visibility: "hidden",
    pointerEvents: "none",
    zIndex: 0,
  });
  assert.deepEqual(resolveTerminalLayerSurfaceStyle(true, true), {
    visibility: "visible",
    pointerEvents: "auto",
    zIndex: 10,
  });
});
