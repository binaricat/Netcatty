import test from "node:test";
import assert from "node:assert/strict";

import { resolveCloseIntent } from "./resolveCloseIntent.ts";

const baseWorkspace = {
  id: "w1",
  focusedSessionId: "s1",
};

const baseSession = { id: "s1" };

test("non-workspace tab → closeSingleTab with session id", () => {
  const result = resolveCloseIntent({
    activeTabId: "s1",
    workspace: null,
    sessionForTab: baseSession,
    activeSidePanelTab: null,
    focusIsInsideTerminal: true,
  });
  assert.deepEqual(result, { kind: "closeSingleTab", sessionId: "s1" });
});

test("non-workspace session tab + sidebar open → closeSidePanel (sidebar beats session close)", () => {
  const r = resolveCloseIntent({
    activeTabId: "s1",
    workspace: null,
    sessionForTab: { id: "s1" },
    activeSidePanelTab: "ai",
    focusIsInsideTerminal: true, // focus IS in terminal, but sidebar wins
  });
  assert.deepEqual(r, { kind: "closeSidePanel" });
});

test("vault/sftp tab → noop", () => {
  const r = resolveCloseIntent({
    activeTabId: "vault",
    workspace: null,
    sessionForTab: null,
    activeSidePanelTab: null,
    focusIsInsideTerminal: false,
  });
  assert.deepEqual(r, { kind: "noop" });
});

test("workspace + focus in terminal + sidebar open → closeSidePanel wins (sidebar beats focus)", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: baseWorkspace,
    sessionForTab: null,
    activeSidePanelTab: "ai",
    focusIsInsideTerminal: true,
  });
  assert.deepEqual(r, { kind: "closeSidePanel" });
});

test("workspace + focus NOT in terminal + sidebar open → closeSidePanel", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: baseWorkspace,
    sessionForTab: null,
    activeSidePanelTab: "sftp",
    focusIsInsideTerminal: false,
  });
  assert.deepEqual(r, { kind: "closeSidePanel" });
});

test("workspace + sidebar closed + focus in terminal → closeTerminal", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: baseWorkspace,
    sessionForTab: null,
    activeSidePanelTab: null,
    focusIsInsideTerminal: true,
  });
  assert.deepEqual(r, { kind: "closeTerminal", sessionId: "s1" });
});

test("workspace + sidebar closed + focus NOT in terminal → closeWorkspace", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: baseWorkspace,
    sessionForTab: null,
    activeSidePanelTab: null,
    focusIsInsideTerminal: false,
  });
  assert.deepEqual(r, { kind: "closeWorkspace", workspaceId: "w1" });
});

test("workspace with no focused session + sidebar closed → closeWorkspace", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: { id: "w1", focusedSessionId: undefined },
    sessionForTab: null,
    activeSidePanelTab: null,
    focusIsInsideTerminal: true, // even if flag true, no focused id → cannot closeTerminal
  });
  assert.deepEqual(r, { kind: "closeWorkspace", workspaceId: "w1" });
});

test("workspace with no focused session + sidebar open → closeSidePanel", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: { id: "w1", focusedSessionId: undefined },
    sessionForTab: null,
    activeSidePanelTab: "ai",
    focusIsInsideTerminal: false,
  });
  assert.deepEqual(r, { kind: "closeSidePanel" });
});
