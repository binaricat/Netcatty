import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAndWriteSessionRestorePayload,
  createInitialRestoredSessionState,
  mergeSessionRestoreCwd,
  updateRestoredSessionStatusState,
  shouldPersistSessionRestoreState,
} from "./sessionRestoreState.ts";
import type { SessionRestorePayload } from "../../domain/sessionRestore.ts";

const payload: SessionRestorePayload = {
  version: 1,
  savedAt: 1,
  activeTabId: "ws-1",
  tabOrder: ["ws-1"],
  sessions: [{
    id: "s1",
    hostId: "host-s1",
    hostLabel: "Host s1",
    hostname: "s1.example.test",
    username: "root",
    status: "disconnected",
    workspaceId: "ws-1",
    restoreState: "restored-disconnected",
  }],
  workspaces: [{
    id: "ws-1",
    title: "Workspace",
    root: { id: "pane-1", type: "pane", sessionId: "s1" },
  }],
};

test("restored session state hydrates sessions, workspaces, tab order, and active tab", () => {
  const restored = createInitialRestoredSessionState({
    restoreEnabled: true,
    payload,
  });

  assert.equal(restored.sessions[0].status, "disconnected");
  assert.equal(restored.sessions[0].restoreState, "restored-disconnected");
  assert.equal(restored.workspaces[0].id, "ws-1");
  assert.deepEqual(restored.tabOrder, ["ws-1"]);
  assert.equal(restored.activeTabId, "ws-1");
});

test("restored session state is empty when restore is disabled", () => {
  const restored = createInitialRestoredSessionState({ restoreEnabled: false, payload });
  assert.deepEqual(restored.sessions, []);
  assert.deepEqual(restored.workspaces, []);
  assert.deepEqual(restored.tabOrder, []);
  assert.equal(restored.activeTabId, "vault");
});

test("mergeSessionRestoreCwd records latest cwd metadata without terminal data", () => {
  const next = mergeSessionRestoreCwd(payload, "s1", "/usr/local/src");
  assert.equal(next.sessions[0].lastCwd, "/usr/local/src");
  assert.equal("terminalData" in next.sessions[0], false);
});

test("mergeSessionRestoreCwd removes cwd when terminal reports null", () => {
  const next = mergeSessionRestoreCwd({
    ...payload,
    sessions: [{ ...payload.sessions[0], lastCwd: "/tmp" }],
  }, "s1", null);
  assert.equal(next.sessions[0].lastCwd, undefined);
});

test("updateRestoredSessionStatusState clears restore marker after reconnect starts", () => {
  const next = updateRestoredSessionStatusState(payload.sessions, "s1", "connecting");

  assert.equal(next[0].status, "connecting");
  assert.equal(next[0].restoreState, undefined);
});

test("updateRestoredSessionStatusState keeps restore marker for disconnected placeholders", () => {
  const next = updateRestoredSessionStatusState(payload.sessions, "s1", "disconnected");

  assert.equal(next[0].status, "disconnected");
  assert.equal(next[0].restoreState, "restored-disconnected");
});

test("shouldPersistSessionRestoreState skips transient empty startup state", () => {
  assert.equal(shouldPersistSessionRestoreState([], [], []), false);
  assert.equal(shouldPersistSessionRestoreState(payload.sessions, payload.workspaces, payload.tabOrder), true);
});

test("restored session state preserves lightweight workspace chrome only", () => {
  const restored = createInitialRestoredSessionState({
    restoreEnabled: true,
    payload: {
      ...payload,
      workspaces: [{
        ...payload.workspaces[0],
        viewMode: "focus",
        focusedSessionId: "s1",
        focusSessionOrder: ["s1"],
        broadcastEnabled: true,
        transientPanelState: { selected: "history" },
      } as never],
    },
  });

  assert.equal(restored.workspaces[0].viewMode, "focus");
  assert.equal(restored.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(restored.workspaces[0].focusSessionOrder, ["s1"]);
  assert.equal("transientPanelState" in restored.workspaces[0], false);
});

test("session restore flush writes through the same sanitized payload path", () => {
  const writes: SessionRestorePayload[] = [];
  const storage = {
    write: (next: SessionRestorePayload) => {
      writes.push(next);
      return true;
    },
    clear: () => {
      throw new Error("should not clear non-empty restore state");
    },
  };

  const wrote = buildAndWriteSessionRestorePayload({
    sessions: [{
      ...payload.sessions[0],
      status: "connected",
      terminalData: "do-not-store",
    } as never],
    workspaces: [{
      ...payload.workspaces[0],
      transientPanelState: { selected: "history" },
    } as never],
    tabOrder: ["ws-1"],
    activeTabId: "ws-1",
    now: 42,
    storage,
  });

  assert.equal(wrote, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessions[0].status, "disconnected");
  assert.equal("terminalData" in writes[0].sessions[0], false);
  assert.equal("transientPanelState" in writes[0].workspaces[0], false);
  assert.equal(writes[0].savedAt, 42);
});

test("session restore flush clears storage instead of writing when restore is disabled", () => {
  const writes: SessionRestorePayload[] = [];
  let clearCount = 0;
  const storage = {
    write: (next: SessionRestorePayload) => {
      writes.push(next);
      return true;
    },
    clear: () => {
      clearCount += 1;
    },
  };

  const wrote = buildAndWriteSessionRestorePayload({
    restoreEnabled: false,
    sessions: payload.sessions,
    workspaces: payload.workspaces,
    tabOrder: payload.tabOrder,
    activeTabId: payload.activeTabId,
    storage,
  });

  assert.equal(wrote, false);
  assert.equal(clearCount, 1);
  assert.equal(writes.length, 0);
});

test("session restore flush skips empty transient windows without clearing existing snapshots", () => {
  const writes: SessionRestorePayload[] = [];
  let clearCount = 0;
  const storage = {
    write: (next: SessionRestorePayload) => {
      writes.push(next);
      return true;
    },
    clear: () => {
      clearCount += 1;
    },
  };

  const wrote = buildAndWriteSessionRestorePayload({
    sessions: [],
    workspaces: [],
    tabOrder: [],
    activeTabId: "vault",
    storage,
  });

  assert.equal(wrote, false);
  assert.equal(clearCount, 0);
  assert.equal(writes.length, 0);
});

test("session restore flush clears stale snapshots when main window becomes empty after restorable state existed", () => {
  const writes: SessionRestorePayload[] = [];
  let clearCount = 0;
  const storage = {
    write: (next: SessionRestorePayload) => {
      writes.push(next);
      return true;
    },
    clear: () => {
      clearCount += 1;
    },
  };

  const wrote = buildAndWriteSessionRestorePayload({
    sessions: [],
    workspaces: [],
    tabOrder: [],
    activeTabId: "vault",
    clearOnEmpty: true,
    storage,
  });

  assert.equal(wrote, false);
  assert.equal(clearCount, 1);
  assert.equal(writes.length, 0);
});
