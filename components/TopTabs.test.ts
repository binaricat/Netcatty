import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  createSessionTopTabDoubleClickHandler,
  formatSessionTopTabLabel,
  formatSessionTopTabTooltip,
  stopCloseButtonDoubleClickPropagation,
} = await import("./top-tabs/TopTabItems.tsx");
const { activeTabStore } = await import("../application/state/activeTabStore.ts");
const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");
const topTabsQuickControlsSource = readFileSync(new URL("./TopTabsQuickControls.tsx", import.meta.url), "utf8");
const syncStatusButtonSource = readFileSync(new URL("./SyncStatusButton.tsx", import.meta.url), "utf8");
const switchSource = readFileSync(new URL("./ui/switch.tsx", import.meta.url), "utf8");
const appViewSource = readFileSync(new URL("../application/app/AppView.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const externalMcpToggleSource = readFileSync(new URL("../application/state/useExternalMcpToggleState.ts", import.meta.url), "utf8");
const zhTwAiSource = readFileSync(new URL("../application/i18n/locales/zh-TW/ai.ts", import.meta.url), "utf8");
const topTabItemsSource = readFileSync(new URL("./top-tabs/TopTabItems.tsx", import.meta.url), "utf8");
const terminalViewSource = readFileSync(new URL("./terminal/TerminalView.tsx", import.meta.url), "utf8");

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

test("host tree tab layout transitions match the sidebar timing", () => {
  const hostTreeCss = [
    ".top-tab-root-label",
    ".top-tab-host-tree-toggle-slot",
  ].map((selector) => {
    const start = indexCss.indexOf(selector);
    assert.notEqual(start, -1);
    const end = indexCss.indexOf("}", start);
    return indexCss.slice(start, end);
  }).join("\n");
  const gutterStart = indexCss.indexOf(".top-tab-host-tree-gutter");
  assert.notEqual(gutterStart, -1);
  const gutterEnd = indexCss.indexOf("}", gutterStart);
  const gutterCss = indexCss.slice(gutterStart, gutterEnd);

  assert.match(hostTreeCss, /width 220ms cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
  assert.match(hostTreeCss, /max-width 220ms cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
  assert.doesNotMatch(hostTreeCss, /transition:\s*none/);
  assert.doesNotMatch(hostTreeCss, /280ms/);
  assert.doesNotMatch(gutterCss, /transition/);
  assert.match(indexCss, /\.top-tab-host-tree-gutter-exit[\s\S]*transition: width 220ms/);
});

test("host tree toggle appears with opacity only and no bounce animation", () => {
  assert.doesNotMatch(indexCss, /top-tab-host-tree-toggle-pop/);
  assert.doesNotMatch(indexCss, /@keyframes\s+pop-in/);

  const start = indexCss.indexOf(".top-tab-host-tree-toggle-slot");
  assert.notEqual(start, -1);
  const end = indexCss.indexOf("}", start);
  const toggleSlotCss = indexCss.slice(start, end);

  assert.match(toggleSlotCss, /opacity 220ms ease/);
  assert.doesNotMatch(toggleSlotCss, /transform/);
  assert.doesNotMatch(toggleSlotCss, /scale/);
});

test("host tree toggle exposes a custom CSS hook", () => {
  assert.match(topTabsSource, /data-section="top-tabs-host-tree-toggle"/);
});

test("quick switcher plus button exposes a custom CSS hook", () => {
  assert.match(topTabsSource, /data-section="top-tabs-quick-switcher-toggle"/);
});

test("top tabs keep cloud sync separate from quick controls", () => {
  assert.match(topTabsSource, /SyncStatusButton/);
  assert.match(topTabsSource, /TopTabsQuickControls/);
  assert.match(topTabsSource, /onOpenSettings=\{onOpenSettings\}/);
  assert.match(topTabsSource, /onSyncNow=\{onSyncNow\}/);
  assert.match(topTabsSource, /theme=\{theme\}/);
  assert.match(topTabsSource, /onToggleTheme=\{onToggleTheme\}/);
  assert.match(topTabsSource, /externalMcpEnabled=\{externalMcpEnabled\}/);
  assert.match(topTabsSource, /windowOpacity=\{windowOpacity\}/);
  assert.match(topTabsSource, /showExternalMcpToggle=\{showExternalMcpToggle\}/);
  assert.doesNotMatch(topTabsSource, /WindowOpacityButton/);
  assert.doesNotMatch(topTabsSource, /onClick=\{onToggleTheme\}/);
  const syncButtonUsage = topTabsSource.match(/<SyncStatusButton[\s\S]*?\/>/);
  assert.ok(syncButtonUsage, 'expected a SyncStatusButton usage');
  assert.doesNotMatch(syncButtonUsage[0], /externalMcpEnabled=/);
  assert.doesNotMatch(syncButtonUsage[0], /windowOpacity=/);
  assert.doesNotMatch(syncButtonUsage[0], /onToggleTheme=/);
  const quickControlsUsage = topTabsSource.match(/<TopTabsQuickControls[\s\S]*?\/>/);
  assert.ok(quickControlsUsage, 'expected a TopTabsQuickControls usage');
  assert.match(quickControlsUsage[0], /showExternalMcpToggle=\{showExternalMcpToggle\}/);
  assert.match(quickControlsUsage[0], /externalMcpEnabled=\{externalMcpEnabled\}/);
});

test("quick controls panel hosts External MCP, opacity, and theme", () => {
  assert.match(topTabsQuickControlsSource, /data-section="top-tabs-quick-controls"/);
  assert.match(topTabsQuickControlsSource, /topTabs\.controlPanel/);
  assert.doesNotMatch(topTabsQuickControlsSource, /topTabs\.controlPanel\.description/);
  assert.match(topTabsQuickControlsSource, /externalMcpEnabled/);
  assert.match(topTabsQuickControlsSource, /onToggleExternalMcp/);
  assert.match(topTabsQuickControlsSource, /windowOpacity/);
  assert.match(topTabsQuickControlsSource, /setWindowOpacity/);
  assert.match(topTabsQuickControlsSource, /onToggleTheme/);
  assert.match(topTabsQuickControlsSource, /<Plug size=\{14\}/);
  assert.match(topTabsQuickControlsSource, /OPACITY_PRESETS/);
  assert.match(topTabsQuickControlsSource, /isOpacityExpanded/);
  assert.match(topTabsQuickControlsSource, /isPresetActive/);
  assert.match(topTabsQuickControlsSource, /type="range"/);
  assert.match(topTabsQuickControlsSource, /aria-labelledby=\{externalMcpLabelId\}/);
  assert.doesNotMatch(topTabsQuickControlsSource, /onOpenAutoFocus/);
  assert.match(topTabsQuickControlsSource, /mt-1 border-t border-border\/60 pt-1/);
  assert.doesNotMatch(topTabsQuickControlsSource, /useCloudSync/);
  assert.doesNotMatch(topTabsQuickControlsSource, /border border-border\/60 bg-background\/70/);
  assert.doesNotMatch(syncStatusButtonSource, /topTabs\.controlPanel/);
  assert.doesNotMatch(syncStatusButtonSource, /externalMcpEnabled/);
  assert.match(switchSource, /aria-label=\{ariaLabel\}/);
  assert.match(switchSource, /role="switch"/);
});

test("External MCP top bar labels exist in Traditional Chinese", () => {
  assert.match(zhTwAiSource, /'topTabs\.externalMcp\.enable':/);
  assert.match(zhTwAiSource, /'topTabs\.externalMcp\.disable':/);
  assert.match(zhTwAiSource, /'topTabs\.controlPanel':/);
  assert.match(zhTwAiSource, /'topTabs\.controlPanel\.externalMcp':/);
});

test("AppView hides External MCP toggle in peer session windows", () => {
  assert.match(appViewSource, /hash\.startsWith\('#\/session-window'\)/);
  assert.match(appViewSource, /showExternalMcpToggle=\{!isPeerSessionWindow\}/);
});

test("External MCP top-bar status sync waits for App startup reconcile", () => {
  assert.match(appSource, /await syncExternalMcpStartupState\(netcattyBridge\.get\(\)\)/);
  assert.match(appSource, /markExternalMcpStartupReady\(\)/);
  assert.ok(
    appSource.indexOf("await syncExternalMcpStartupState(netcattyBridge.get())")
      < appSource.indexOf("markExternalMcpStartupReady()"),
    "startup ready must be marked only after await syncExternalMcpStartupState",
  );
  assert.match(externalMcpToggleSource, /shouldWaitForExternalMcpStartupReady/);
  assert.match(externalMcpToggleSource, /waitForExternalMcpStartupReady\(/);
  assert.match(externalMcpToggleSource, /!status\.enabled && !status\.error/);
  assert.match(externalMcpToggleSource, /if \(isPeerSessionWindow \|\| !enabled\) return;/);
});

test("SessionTabIcon checks custom host icon appearance before distro logos", () => {
  assert.match(topTabItemsSource, /resolveHostIconAppearance\(host\)/);
  assert.ok(
    topTabItemsSource.indexOf("resolveHostIconAppearance(host)") < topTabItemsSource.indexOf("getEffectiveHostDistro(host)"),
    "custom host icon should be checked before distro fallback",
  );
});

test("session top tabs copy the session on double click through the existing copy handler", () => {
  const copiedSessionIds: string[] = [];
  const handleDoubleClick = createSessionTopTabDoubleClickHandler(
    (sessionId) => copiedSessionIds.push(sessionId),
    "session-1",
  );

  handleDoubleClick({} as Parameters<typeof handleDoubleClick>[0]);

  assert.deepEqual(copiedSessionIds, ["session-1"]);
  assert.match(topTabItemsSource, /onDoubleClick=\{handleDoubleClick\}/);
});

test("session close button double click stays on the close button", () => {
  let stopPropagationCount = 0;

  stopCloseButtonDoubleClickPropagation({
    stopPropagation: () => {
      stopPropagationCount += 1;
    },
  });

  assert.equal(stopPropagationCount, 1);
  assert.match(topTabItemsSource, /onDoubleClick=\{stopCloseButtonDoubleClickPropagation\}/);
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

test("terminal top bar hides server stats before they crowd the host title", () => {
  assert.match(indexCss, /\.terminal-topbar\s*\{[\s\S]*container-type: inline-size/);
  assert.match(indexCss, /@container \(max-width: 760px\) \{[\s\S]*\.terminal-server-stats\s*\{[\s\S]*display: none/);
  assert.match(terminalViewSource, /terminal-topbar/);
  assert.match(terminalViewSource, /terminal-title-cluster/);
  assert.match(terminalViewSource, /onPointerDown=\{onDetachPointerDown\}/);
});

test("workspace session drag no longer uses a full tab-bar drop zone", () => {
  assert.doesNotMatch(topTabsSource, /top-tabs-workspace-detach-drop-zone/);
});

test("host tree chrome enters after theme switch settles so root labels can animate", () => {
  assert.match(topTabsSource, /hostTreeChromeReady/);
  assert.match(topTabsSource, /scheduleAfterInstantThemeSwitch\(\(\) => \{\s*cancelHostTreeChromeReadyRef\.current = null;\s*setHostTreeChromeReady\(true\);/);
  assert.match(topTabsSource, /scheduleChromeLayoutAnimation\(\(\) => \{\s*cancelRootTabsCompactRef\.current = null;\s*setRootTabsCompact\(true\);/);
  assert.match(topTabsSource, /compact=\{rootTabsCompact\}/);
  assert.match(topTabsSource, /data-visible=\{effectiveShowHostTreeToggle \? 'true' : 'false'\}/);
});

test("host tree chrome exits before root labels expand back on vault", () => {
  assert.match(topTabsSource, /cancelChromeExitRef/);
  assert.match(topTabsSource, /hostTreeGutterExiting/);
  assert.match(topTabsSource, /setRootTabsCompact\(false\)/);
  assert.match(topTabsSource, /top-tab-host-tree-gutter-exit/);
  assert.match(topTabsSource, /effectiveShowHostTreeToggle = hostTreeChromeReady/);
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
