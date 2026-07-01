import test from "node:test";
import assert from "node:assert/strict";

import type { Workspace } from "../../types";
import {
  terminalLayerFocusSidebarPropsEqual,
  terminalLayerSidePanelCtxEqual,
  terminalLayerSidePanelStableCtxEqual,
  terminalLayerViewCtxEqual,
  terminalLayerWorkspaceCtxEqual,
} from "./terminalLayerViewMemo.ts";

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "workspace-1",
  title: "Workspace",
  viewMode: "split",
  focusedSessionId: "session-1",
  focusSessionOrder: ["session-1", "session-2"],
  root: {
    id: "split-1",
    type: "split",
    direction: "vertical",
    sizes: [1, 1],
    children: [
      { id: "pane-1", type: "pane", sessionId: "session-1" },
      { id: "pane-2", type: "pane", sessionId: "session-2" },
    ],
  },
  ...overrides,
});

const cloneWorkspace = (value: Workspace): Workspace => JSON.parse(JSON.stringify(value));

test("terminal layer memo skips equivalent active workspace objects", () => {
  const prevWorkspace = workspace();
  const nextWorkspace = cloneWorkspace(prevWorkspace);
  const baseCtx = {
    activeWorkspace: prevWorkspace,
    activeResizers: [
      {
        id: "split-1-0",
        splitId: "split-1",
        index: 0,
        direction: "vertical",
        rect: { x: 10, y: 0, w: 4, h: 100 },
        splitArea: { w: 200, h: 100 },
      },
    ],
    draggingSessionId: null,
    workspaceRectsById: new Map([
      [
        "workspace-1",
        {
          "session-1": { x: 0, y: 0, w: 100, h: 100 },
          "session-2": { x: 100, y: 0, w: 100, h: 100 },
        },
      ],
    ]),
  };

  assert.equal(
    terminalLayerWorkspaceCtxEqual(
      baseCtx,
      { ...baseCtx, activeWorkspace: nextWorkspace },
    ),
    true,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      baseCtx,
      { ...baseCtx, activeWorkspace: nextWorkspace },
    ),
    true,
  );
});

test("terminal layer memo re-renders when active workspace root changes", () => {
  const prevWorkspace = workspace();
  const nextWorkspace = cloneWorkspace(prevWorkspace);
  nextWorkspace.root = {
    ...nextWorkspace.root,
    type: "split",
    sizes: [2, 1],
  };

  assert.equal(
    terminalLayerWorkspaceCtxEqual(
      { activeWorkspace: prevWorkspace },
      { activeWorkspace: nextWorkspace },
    ),
    false,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      { activeWorkspace: prevWorkspace },
      { activeWorkspace: nextWorkspace },
    ),
    false,
  );
});

test("terminal layer side panel stable ctx ignores linked terminal cwd changes", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    sidePanelOpenTabs: new Map([["workspace-1", "sftp"]]),
    activeTerminalCwd: "/home/user",
    sftpFollowTerminalCwd: true,
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    true,
  );
  assert.equal(
    terminalLayerSidePanelCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    false,
  );
});

test("terminal layer side panel re-renders when linked terminal cwd changes", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    activeTerminalCwd: "/home/user",
    sftpFollowTerminalCwd: true,
  };

  assert.equal(
    terminalLayerSidePanelCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    false,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    false,
  );
});

test("terminal layer side panel re-renders when follow terminal cwd setting changes", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    activeTerminalCwd: "/home/user",
    sftpFollowTerminalCwd: false,
  };

  assert.equal(
    terminalLayerSidePanelCtxEqual(
      baseCtx,
      { ...baseCtx, sftpFollowTerminalCwd: true },
    ),
    false,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      baseCtx,
      { ...baseCtx, sftpFollowTerminalCwd: true },
    ),
    false,
  );
});

test("terminal layer side panel re-renders when vault note open callback changes", () => {
  const baseCtx = {
    mountedAiTabIds: ["workspace-1"],
    onOpenVaultNoteFromChat: () => {},
  };

  assert.equal(
    terminalLayerSidePanelCtxEqual(
      baseCtx,
      { ...baseCtx, onOpenVaultNoteFromChat: () => {} },
    ),
    false,
  );
});

test("terminal layer focus sidebar re-renders when dynamic tab title mode changes", () => {
  const baseCtx = {
    isFocusMode: true,
    activeWorkspace: workspace(),
    focusedSessionId: "session-1",
    resolvedPreviewTheme: {},
    sessionHostsMap: new Map(),
    sessions: [],
    terminalSettings: { dynamicTabTitleMode: "agent" },
  };

  assert.equal(
    terminalLayerFocusSidebarPropsEqual(
      baseCtx,
      { ...baseCtx, terminalSettings: { dynamicTabTitleMode: "off" } },
    ),
    false,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      baseCtx,
      { ...baseCtx, terminalSettings: { dynamicTabTitleMode: "off" } },
    ),
    false,
  );
});
