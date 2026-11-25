import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TerminalSession } from "../types";

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
  getHostTreeTabGutterStyle,
  resolveWorkspaceSessionTabDropTarget,
  shouldKeepHostTreeToggleSurface,
  shouldShowHostTreeToggle,
} = await import("./TopTabs.tsx");
const { TERMINAL_HOST_TREE_WIDTH_TRANSITION } = await import("../application/state/terminalHostTreeAnimation.ts");
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
  createTopTabCopyDoubleClickHandler,
  createTopTabSessionDoubleClickHandler,
  formatSessionTopTabLabel,
  formatSessionTopTabTooltip,
  resolveSessionTabCodingCliIconState,
  resolveWorkspaceTopTabLabel,
} = await import("./top-tabs/TopTabItems.tsx");
const { activeTabStore } = await import("../application/state/activeTabStore.ts");
const {
  publishSessionPromptHost,
  sessionPresentationStore,
} = await import("../application/state/sessionPresentationStore.ts");

const topTabSession = (
  id: string,
  hostId: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  id,
  hostId,
  hostLabel: "jump",
  username: "root",
  hostname: "jump",
  status: "connected",
  ...overrides,
});

test("host tree tab gutter fills the remaining sidebar width", () => {
  assert.equal(computeHostTreeTabGutter(280, 120), 160);
});

test("host tree tab gutter style animates only when host tree transitions and yields to exit class", () => {
  assert.deepEqual(getHostTreeTabGutterStyle(120, false, true), {
    width: 120,
    transition: TERMINAL_HOST_TREE_WIDTH_TRANSITION,
  });
  assert.deepEqual(getHostTreeTabGutterStyle(120, false, false), {
    width: 120,
    transition: "none",
  });
  assert.deepEqual(getHostTreeTabGutterStyle(0, true, false), {
    width: 0,
  });
});

test("workspace tabs resolve generated labels from live prompt hosts", () => {
  const sessions = [
    topTabSession("s1", "h1", { customName: "", promptHostname: "" }),
    topTabSession("s2", "h2", { customName: "", promptHostname: "" }),
  ];
  const workspace = {
    title: "jump/jump",
    autoTitle: false,
    generatedTitle: true,
    focusedSessionId: "s1",
  };

  publishSessionPromptHost("s1", "target-a");
  publishSessionPromptHost("s2", "target-b");
  assert.equal(
    resolveWorkspaceTopTabLabel(workspace, sessions),
    "target-a/target-b",
  );

  sessionPresentationStore.clearSession("s1");
  sessionPresentationStore.clearSession("s2");
});

test("workspace tabs keep explicit names ahead of live prompt hosts", () => {
  const sessions = [
    topTabSession("s1", "h1", { customName: "", promptHostname: "" }),
  ];
  publishSessionPromptHost("s1", "target-a");
  assert.equal(
    resolveWorkspaceTopTabLabel({
      title: "My Workspace",
      autoTitle: false,
      generatedTitle: false,
      focusedSessionId: "s1",
    }, sessions),
    "My Workspace",
  );
  sessionPresentationStore.clearSession("s1");
});

test("host tree tab gutter never goes negative", () => {
  assert.equal(computeHostTreeTabGutter(120, 280), 0);
});

test("top tab native exclusions stay bounded to the stationary scroll viewport", () => {
  const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");
  const topTabItemsSource = readFileSync(new URL("./top-tabs/TopTabItems.tsx", import.meta.url), "utf8");

  const viewport = topTabsSource.match(/<div\s+ref=\{tabsContainerRef\}[\s\S]*?onClick=/);
  assert.ok(viewport, "expected the tab scroll viewport");
  assert.match(viewport[0], /className="[^"]*\btop-tab-scroll-viewport\b[^"]*"/);
  assert.match(viewport[0], /className="[^"]*\bmin-w-0\b[^"]*"/);
  assert.doesNotMatch(viewport[0], /className="[^"]*\bflex-1\b[^"]*"/);
  assert.match(viewport[0], /className="[^"]*\boverflow-x-auto\b[^"]*\bapp-no-drag\b[^"]*"/);
  assert.doesNotMatch(viewport[0], /\bapp-drag\b/);
  // Inline no-drag keeps the viewport excluded despite the scoped CSS reset.
  assert.match(viewport[0], /style=\{\{[^}]*\.\.\.noDragRegionStyle\s*\}\}/);
  assert.match(topTabsSource, /const noDragRegionStyle = \{ WebkitAppRegion: 'no-drag' \}/);

  const scrollContent = topTabsSource.slice(topTabsSource.indexOf(viewport[0]));
  const viewportEnd = scrollContent.indexOf("</div>");
  assert.match(scrollContent.slice(0, viewportEnd), /\{renderOrderedTabs\(\)\}/);
  assert.doesNotMatch(scrollContent.slice(0, viewportEnd), /min-w-\[20px\]/);
  assert.match(scrollContent.slice(viewportEnd), /^<\/div>\s*\{\/\*[^}]*\*\/\}\s*<div className="flex-1 app-drag" style=\{dragRegionStyle\} \/>\s*<div className="min-w-\[20px\] h-7 app-drag flex-shrink-0 self-end" style=\{dragRegionStyle\} \/>/);

  const regionReset = indexCss.match(/\.top-tab-scroll-viewport,\s*\.top-tab-scroll-viewport \*\s*\{([^}]+)\}/);
  assert.ok(regionReset, "expected a native region reset for the viewport and every descendant");
  assert.match(regionReset[1], /-webkit-app-region:\s*none;/);
  assert.match(regionReset[1], /(?:^|[;\s])app-region:\s*none;/);
  assert.ok(indexCss.indexOf(regionReset[0]) > indexCss.indexOf(".app-no-drag * {"));
  assert.match(topTabItemsSource, /netcatty-tab[^\n]*\bapp-no-drag\b/);
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

test("workspace double-click honors Do nothing and retains copying for enabled modes", () => {
  for (const behavior of ["disabled", "copy", "duplicate"] as const) {
    const copiedWorkspaces: string[] = [];
    const handler = createTopTabCopyDoubleClickHandler(
      (id) => copiedWorkspaces.push(id), "workspace-1", behavior,
    );
    handler({} as Parameters<typeof handler>[0]);
    assert.deepEqual(copiedWorkspaces, behavior === "disabled" ? [] : ["workspace-1"]);
  }

  const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");
  assert.match(topTabsSource, /<WorkspaceTopTab\b[^>]*tabDoubleClickBehavior=\{tabDoubleClickBehavior\}/);
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

test("TopTabs narrows active-tab subscription via useShowHostTreeToggle", () => {
  const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(topTabsSource, /\buseActiveTabId\b/);
  assert.match(topTabsSource, /const showHostTreeToggle = useShowHostTreeToggle\(/);
});
