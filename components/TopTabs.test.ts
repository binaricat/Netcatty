import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
});

const {
  computeHostTreeTabGutter,
  resolveWorkspaceSessionTabDropTarget,
  shouldKeepHostTreeToggleSurface,
  shouldShowHostTreeToggle,
} = await import("./TopTabs.tsx");
const {
  WORKSPACE_SESSION_DRAG_TYPE,
  dataTransferHasType,
  getTopTabInsertionTarget,
  getWorkspaceSessionDragId,
  hasWorkspaceSessionDrag,
  isPointInsideRect,
} = await import("../application/state/terminalDragData.ts");
const {
  activateLogViewTab,
  createTopTabSessionDoubleClickHandler,
  formatSessionTopTabLabel,
  formatSessionTopTabTooltip,
  resolveSessionTabCodingCliIconState,
} = await import("./top-tabs/TopTabItems.tsx");
const { activeTabStore } = await import("../application/state/activeTabStore.ts");

test("host tree tab gutter fills the remaining sidebar width", () => {
  assert.equal(computeHostTreeTabGutter(280, 120), 160);
});

test("host tree tab gutter never goes negative", () => {
  assert.equal(computeHostTreeTabGutter(120, 280), 0);
});

test("host tree tab surface stays mounted when root pages are active", () => {
  assert.equal(shouldKeepHostTreeToggleSurface({
    enabled: true,
    activeWorkTabCount: 2,
  }), true);
});

test("host tree tab surface is hidden without work tabs", () => {
  assert.equal(shouldKeepHostTreeToggleSurface({
    enabled: true,
    activeWorkTabCount: 0,
  }), false);
});

test("disabling dynamic titles freezes a stored coding CLI icon and stops title fallback", () => {
  assert.deepEqual(
    resolveSessionTabCodingCliIconState({
      codingCliProviderId: "claude",
      dynamicTitle: "⠋ Reading files",
    }, undefined, "off"),
    {
      provider: {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        titleHints: ["claude code", "claude"],
        iconKey: "claude",
      },
      activityPhase: "idle",
    },
  );
  assert.equal(
    resolveSessionTabCodingCliIconState({
      dynamicTitle: "OpenAI Codex",
    }, undefined, "off"),
    null,
  );
  assert.equal(
    resolveSessionTabCodingCliIconState({
      startupCommand: "claude",
    }, undefined, "off")?.provider.id,
    "claude",
  );
  assert.equal(
    resolveSessionTabCodingCliIconState({
      dynamicTitle: "OpenAI Codex",
    }, undefined, "agent")?.provider.id,
    "codex",
  );
});

test("duplicate double-click behavior falls back to copying when unavailable", () => {
  const copiedSessionIds: string[] = [];
  const handleDoubleClick = createTopTabSessionDoubleClickHandler({
    behavior: "duplicate",
    onCopySession: (sessionId) => copiedSessionIds.push(sessionId),
    sessionId: "session-1",
  });

  handleDoubleClick({} as Parameters<typeof handleDoubleClick>[0]);

  assert.deepEqual(copiedSessionIds, ["session-1"]);
});

test("session top tab label only shows the host label for ssh sessions", () => {
  assert.equal(
    formatSessionTopTabLabel({
      hostLabel: "prod-web",
      hostname: "10.1.2.34",
      protocol: "ssh",
    }),
    "prod-web",
  );
});

test("session top tab label treats missing protocol as ssh", () => {
  assert.equal(
    formatSessionTopTabLabel({
      hostLabel: "prod-web",
      hostname: "10.1.2.34",
    }),
    "prod-web",
  );
  assert.equal(
    formatSessionTopTabTooltip({
      username: "root",
      hostname: "10.1.2.34",
      port: 22,
    }),
    "root@10.1.2.34:22",
  );
});

test("session top tab label avoids duplicating the target address", () => {
  assert.equal(
    formatSessionTopTabLabel({
      hostLabel: "10.1.2.34",
      hostname: "10.1.2.34",
      protocol: "ssh",
    }),
    "10.1.2.34",
  );
});

test("session top tab tooltip includes username and port when present", () => {
  assert.equal(
    formatSessionTopTabTooltip({
      username: "root",
      hostname: "db.internal",
      port: 2222,
      protocol: "ssh",
    }),
    "root@db.internal:2222",
  );
});

test("session top tab helpers ignore local and mosh sessions", () => {
  assert.equal(
    formatSessionTopTabLabel({
      hostLabel: "Local shell",
      hostname: "127.0.0.1",
      protocol: "local",
    }),
    "Local shell",
  );
  assert.equal(
    formatSessionTopTabTooltip({
      username: "root",
      hostname: "10.1.2.34",
      port: 22,
      protocol: "ssh",
      moshEnabled: true,
    }),
    null,
  );
});

test("workspace session drag data is recognized with a dedicated drag type", () => {
  const data = new Map([
    [WORKSPACE_SESSION_DRAG_TYPE, "session-1"],
    ["session-id", "fallback-session"],
  ]);
  const transfer = {
    types: [WORKSPACE_SESSION_DRAG_TYPE, "text/plain"],
    getData: (format: string) => data.get(format) ?? "",
  };

  assert.equal(hasWorkspaceSessionDrag(transfer), true);
  assert.equal(getWorkspaceSessionDragId(transfer), "session-1");
});

test("workspace session drag id falls back to the legacy session id", () => {
  const transfer = {
    types: ["session-id"],
    getData: (format: string) => (format === "session-id" ? "session-2" : ""),
  };

  assert.equal(dataTransferHasType(transfer, "session-id"), true);
  assert.equal(hasWorkspaceSessionDrag(transfer), false);
  assert.equal(getWorkspaceSessionDragId(transfer), "session-2");
});

test("point-in-rect detects pointer release inside the top tab bar", () => {
  const rect = { left: 10, right: 110, top: 20, bottom: 60 };

  assert.equal(isPointInsideRect({ clientX: 10, clientY: 20 }, rect), true);
  assert.equal(isPointInsideRect({ clientX: 70, clientY: 40 }, rect), true);
  assert.equal(isPointInsideRect({ clientX: 111, clientY: 40 }, rect), false);
  assert.equal(isPointInsideRect({ clientX: 70, clientY: 61 }, rect), false);
});

test("top tab insertion target ignores fixed root tabs", () => {
  const makeTab = (id: string, type: string, left: number, right: number) => ({
    dataset: { tabId: id, tabType: type },
    getBoundingClientRect: () => ({ left, right, top: 20, bottom: 60, width: right - left, height: 40 }),
  });
  const root = {
    getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 80, width: 400, height: 80 }),
    querySelectorAll: () => [
      makeTab("vault", "root", 0, 80),
      makeTab("workspace-1", "workspace", 90, 210),
      makeTab("session-1", "session", 210, 330),
    ],
  } as unknown as HTMLElement;

  assert.deepEqual(getTopTabInsertionTarget({ clientX: 20, clientY: 40 }, root), {
    tabId: "workspace-1",
    position: "before",
  });
  assert.deepEqual(getTopTabInsertionTarget({ clientX: 180, clientY: 40 }, root), {
    tabId: "workspace-1",
    position: "after",
  });
  assert.deepEqual(getTopTabInsertionTarget({ clientX: 380, clientY: 40 }, root), {
    tabId: "session-1",
    position: "after",
  });
  assert.equal(getTopTabInsertionTarget({ clientX: 180, clientY: 120 }, root), null);
});

test("workspace session tab drop forwards the requested insertion target", () => {
  assert.deepEqual(resolveWorkspaceSessionTabDropTarget({
    targetTabId: "session-3",
    position: "after",
    draggedSessionId: "session-1",
    draggedWorkspaceId: "workspace-1",
    workspaces: [],
  }), {
    tabId: "session-3",
    position: "after",
    additionalTabIds: ["session-1", "session-3"],
  });
});

test("workspace session tab drop targets the remaining terminal when its workspace dissolves", () => {
  assert.deepEqual(resolveWorkspaceSessionTabDropTarget({
    targetTabId: "workspace-1",
    position: "before",
    draggedSessionId: "session-1",
    draggedWorkspaceId: "workspace-1",
    workspaces: [{
      id: "workspace-1",
      title: "Workspace",
      focusedSessionId: "session-1",
      root: {
        id: "split-1",
        type: "split",
        direction: "horizontal",
        children: [
          { id: "pane-1", type: "pane", sessionId: "session-1" },
          { id: "pane-2", type: "pane", sessionId: "session-2" },
        ],
        sizes: [1, 1],
      },
    }],
  }), {
    tabId: "session-2",
    position: "before",
    additionalTabIds: ["session-1", "session-2"],
  });
});

test("workspace session tab-bar blank drop inserts after the last work tab", () => {
  const makeTab = (id: string, type: string, left: number, right: number) => ({
    dataset: { tabId: id, tabType: type },
    getBoundingClientRect: () => ({ left, right, top: 20, bottom: 60, width: right - left, height: 40 }),
  });
  const root = {
    getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 80, width: 500, height: 80 }),
    querySelectorAll: () => [
      makeTab("vault", "root", 0, 80),
      makeTab("workspace-1", "workspace", 90, 210),
      makeTab("session-3", "session", 210, 330),
    ],
  } as unknown as HTMLElement;
  const insertionTarget = getTopTabInsertionTarget({ clientX: 460, clientY: 40 }, root);

  assert.deepEqual(insertionTarget, { tabId: "session-3", position: "after" });
  assert.deepEqual(resolveWorkspaceSessionTabDropTarget({
    targetTabId: insertionTarget!.tabId,
    position: insertionTarget!.position,
    draggedSessionId: "session-1",
    draggedWorkspaceId: "workspace-1",
    workspaces: [],
  }), {
    tabId: "session-3",
    position: "after",
    additionalTabIds: ["session-1", "session-3"],
  });
});

test("host tree toggle is shown for an active editor tab", () => {
  assert.equal(shouldShowHostTreeToggle({
    enabled: true,
    activeTabId: "editor:file-1",
    orderedTabs: ["session-1", "editor:file-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), true);
});

test("host tree toggle is shown for log tabs", () => {
  assert.equal(shouldShowHostTreeToggle({
    enabled: true,
    activeTabId: "log-1",
    logViewIds: new Set(["log-1"]),
    orderedTabs: ["session-1", "log-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), true);
});

test("host tree toggle is shown for log tabs before tab ordering catches up", () => {
  assert.equal(shouldShowHostTreeToggle({
    enabled: true,
    activeTabId: "log-1",
    logViewIds: new Set(["log-1"]),
    orderedTabs: [],
    sessionIds: new Set(),
    workspaceIds: new Set(),
  }), true);
});

test("clicking a log tab activates the shared work-tab surface", () => {
  activeTabStore.setActiveTabId("vault");

  activateLogViewTab("log-1");

  assert.equal(activeTabStore.getActiveTabId(), "log-1");
});

test("host tree toggle is hidden when host sidebar is disabled", () => {
  assert.equal(shouldShowHostTreeToggle({
    enabled: false,
    activeTabId: "session-1",
    orderedTabs: ["session-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), false);
});

test("host tree toggle is hidden on root pages", () => {
  assert.equal(shouldShowHostTreeToggle({
    enabled: true,
    activeTabId: "vault",
    orderedTabs: ["session-1", "editor:file-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), false);
  assert.equal(shouldShowHostTreeToggle({
    enabled: true,
    activeTabId: "sftp",
    orderedTabs: ["session-1", "editor:file-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), false);
});
