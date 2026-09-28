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

test("terminal layer memo ignores activeWorkspace-only tab flips (live store owns them)", () => {
  const prevWorkspace = workspace();
  const nextWorkspace = cloneWorkspace(prevWorkspace);
  nextWorkspace.root = {
    ...nextWorkspace.root,
    type: "split",
    sizes: [2, 1],
  };

  // activeWorkspace is read from sidePanelLiveStore in WorkspaceSection; ctx
  // equality must not force a full layer rebuild solely because the active
  // workspace object identity/root changed on a tab switch.
  assert.equal(
    terminalLayerWorkspaceCtxEqual(
      { activeWorkspace: prevWorkspace },
      { activeWorkspace: nextWorkspace },
    ),
    true,
  );
  assert.equal(
    terminalLayerViewCtxEqual(
      { activeWorkspace: prevWorkspace },
      { activeWorkspace: nextWorkspace },
    ),
    true,
  );
});

test("terminal layer memo re-renders when active resizers change", () => {
  const base = {
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
  };
  const next = {
    activeResizers: [
      {
        id: "split-1-0",
        splitId: "split-1",
        index: 0,
        direction: "vertical",
        rect: { x: 40, y: 0, w: 4, h: 100 },
        splitArea: { w: 200, h: 100 },
      },
    ],
  };
  assert.equal(terminalLayerWorkspaceCtxEqual(base, next), false);
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

test("terminal layer side panel remeasures when the compose bar opens", () => {
  const closed = { isComposeBarOpen: false };
  assert.equal(
    terminalLayerSidePanelStableCtxEqual(closed, { isComposeBarOpen: true }),
    false,
  );
});

test("terminal layer side panel stable ctx re-renders when SFTP-relevant session fields change", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    sidePanelOpenTabs: new Map([["workspace-1", "sftp"]]),
    sessions: [{ id: "s1", hostId: "h1", protocol: "ssh", status: "connecting" }],
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      {
        ...baseCtx,
        sessions: [{ id: "s1", hostId: "h1", protocol: "ssh", status: "connected" }],
      },
    ),
    false,
  );
});

test("terminal layer side panel stable ctx ignores session title-only updates", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    sidePanelOpenTabs: new Map([["workspace-1", "sftp"]]),
    sessions: [{
      id: "s1",
      hostId: "h1",
      protocol: "ssh",
      status: "connected",
      dynamicTitle: "old",
    }],
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      {
        ...baseCtx,
        sessions: [{
          id: "s1",
          hostId: "h1",
          protocol: "ssh",
          status: "connected",
          dynamicTitle: "new title from OSC",
        }],
      },
    ),
    true,
  );
});

test("terminal layer side panel stable ctx re-renders when session tab ownership changes", () => {
  const baseCtx = {
    sessions: [{ id: "s1", hostId: "h1", protocol: "local", status: "connected", workspaceId: "ws-1" }],
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      {
        ...baseCtx,
        sessions: [{ id: "s1", hostId: "h1", protocol: "local", status: "connected", workspaceId: "ws-2" }],
      },
    ),
    false,
  );
});

test("terminal layer side panel stable ctx tracks session hosts and workspaces", () => {
  const baseCtx = {
    sessionHostsMap: new Map([["s1", { protocol: "ssh" }]]),
    workspaceById: new Map([["ws-1", workspace()]]),
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(baseCtx, {
      ...baseCtx,
      sessionHostsMap: new Map([["s1", { protocol: "local" }]]),
    }),
    false,
  );
  // Focus-only workspace identity changes must not bust stable side-panel equal
  // (System/SFTP follow focus via sidePanelLiveStore).
  assert.equal(
    terminalLayerSidePanelStableCtxEqual(baseCtx, {
      ...baseCtx,
      workspaceById: new Map([["ws-1", workspace({ focusedSessionId: "session-2" })]]),
    }),
    true,
  );
  assert.equal(
    terminalLayerSidePanelStableCtxEqual(baseCtx, {
      ...baseCtx,
      workspaceById: new Map([["ws-1", workspace({ title: "Renamed" })]]),
    }),
    false,
  );
});

test("terminal layer side panel stable ctx re-renders when session transport flags change", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    sidePanelOpenTabs: new Map([["workspace-1", "sftp"]]),
    sessions: [{ id: "s1", hostId: "h1", protocol: "ssh", status: "connected" }],
  };

  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      {
        ...baseCtx,
        sessions: [{
          id: "s1",
          hostId: "h1",
          protocol: "ssh",
          status: "connected",
          moshEnabled: true,
        }],
      },
    ),
    false,
  );
});

test("terminal layer side panel live equal still tracks cwd; view ignores live cwd", () => {
  const baseCtx = {
    mountedSftpTabIds: ["workspace-1"],
    activeTerminalCwd: "/home/user",
    sftpFollowTerminalCwd: true,
  };

  // Live equal still sees cwd (for diagnostic / full side-panel equal helpers).
  assert.equal(
    terminalLayerSidePanelCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    false,
  );
  // View equal uses stable keys only — cwd flows through sidePanelLiveStore.
  assert.equal(
    terminalLayerViewCtxEqual(
      baseCtx,
      { ...baseCtx, activeTerminalCwd: "/home/user/project" },
    ),
    true,
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

test("terminal layer side panel stable ctx re-renders when knownHosts change", () => {
  const baseCtx = {
    knownHosts: [{ id: "kh-1", hostname: "a.example", port: 22 }],
  };
  assert.equal(
    terminalLayerSidePanelStableCtxEqual(
      baseCtx,
      { ...baseCtx, knownHosts: [{ id: "kh-2", hostname: "b.example", port: 22 }] },
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

test("terminal layer focus sidebar re-renders when host-append handler changes", () => {
  const baseCtx = {
    isFocusMode: true,
    activeWorkspace: workspace(),
    focusedSessionId: "session-1",
    resolvedPreviewTheme: {},
    sessionHostsMap: new Map(),
    sessions: [],
    terminalSettings: { dynamicTabTitleMode: "agent" },
    onAppendHostToWorkspace: undefined as
      | ((workspaceId: string, hostId: string) => void)
      | undefined,
  };

  assert.equal(
    terminalLayerFocusSidebarPropsEqual(
      baseCtx,
      { ...baseCtx, onAppendHostToWorkspace: () => {} },
    ),
    false,
  );
});
