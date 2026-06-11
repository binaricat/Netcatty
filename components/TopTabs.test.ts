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
  shouldKeepHostTreeToggleSurface,
  shouldShowHostTreeToggle,
} = await import("./TopTabs.tsx");
const { activateLogViewTab } = await import("./top-tabs/TopTabItems.tsx");
const { activeTabStore } = await import("../application/state/activeTabStore.ts");
const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");

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
