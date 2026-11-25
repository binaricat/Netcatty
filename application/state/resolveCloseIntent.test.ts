import test from "node:test";
import assert from "node:assert/strict";

import { resolveCloseIntent } from "./resolveCloseIntent.ts";

const baseWorkspace = { id: "w1", focusedSessionId: "s1" };
const baseSession = { id: "s1" };

test("non-workspace tab → closeSingleTab with session id", () => {
  const r = resolveCloseIntent({
    activeTabId: "s1",
    workspace: null,
    sessionForTab: baseSession,
  });
  assert.deepEqual(r, { kind: "closeSingleTab", sessionId: "s1" });
});

test("vault/sftp tab → noop", () => {
  const r = resolveCloseIntent({
    activeTabId: "vault",
    workspace: null,
    sessionForTab: null,
  });
  assert.deepEqual(r, { kind: "noop" });
});

test("workspace tab closes the whole workspace even with a focused session", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: baseWorkspace,
    sessionForTab: null,
  });
  assert.deepEqual(r, { kind: "closeWorkspace", workspaceId: "w1" });
});

test("workspace with no focused session → closeWorkspace", () => {
  const r = resolveCloseIntent({
    activeTabId: "w1",
    workspace: { id: "w1", focusedSessionId: undefined },
    sessionForTab: null,
  });
  assert.deepEqual(r, { kind: "closeWorkspace", workspaceId: "w1" });
});
