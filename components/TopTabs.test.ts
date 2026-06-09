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

const { computeHostTreeTabGutter, shouldShowHostTreeToggle } = await import("./TopTabs.tsx");

test("host tree tab gutter fills the remaining sidebar width", () => {
  assert.equal(computeHostTreeTabGutter(280, 120), 160);
});

test("host tree tab gutter never goes negative", () => {
  assert.equal(computeHostTreeTabGutter(120, 280), 0);
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
    orderedTabs: ["session-1", "log-1"],
    sessionIds: new Set(["session-1"]),
    workspaceIds: new Set(),
  }), true);
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
