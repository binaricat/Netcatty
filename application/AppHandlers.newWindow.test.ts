import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../domain/models";
import { copySessionToNewWindowWithCurrentShellImpl, moveSessionToNewWindowImpl } from "./app/AppHandlers";

const sourceSession = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: "session-1",
  hostId: "host-1",
  hostLabel: "Prod SSH",
  hostname: "prod.example.com",
  username: "deploy",
  status: "connected",
  protocol: "ssh",
  port: 22,
  ...overrides,
});

test("copySessionToNewWindowWithCurrentShellImpl asks Electron to open a peer window for the selected session", async () => {
  const openedPayloads: unknown[] = [];

  await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({
          openSessionInNewWindow: async (payload: unknown) => {
            openedPayloads.push(payload);
            return { success: true };
          },
        }),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [sourceSession()],
      terminalSettings: { localShell: "system-default" },
    }),
    "session-1",
  );

  assert.equal(openedPayloads.length, 1);
  assert.deepEqual(openedPayloads[0], {
    title: "Prod SSH",
    sourceSession: sourceSession(),
    localShellType: "zsh",
  });
});

test("copySessionToNewWindowWithCurrentShellImpl preserves local start directory in the source session", async () => {
  const openedPayloads: unknown[] = [];
  const localSession = sourceSession({
    hostLabel: "Local Terminal",
    hostname: "localhost",
    protocol: "local",
    localStartDir: "/Users/alice/project with spaces ",
  });

  await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({
          openSessionInNewWindow: async (payload: unknown) => {
            openedPayloads.push(payload);
            return { success: true };
          },
        }),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [localSession],
      terminalSettings: { localShell: "system-default" },
    }),
    "session-1",
  );

  assert.equal(openedPayloads.length, 1);
  assert.deepEqual(openedPayloads[0], {
    title: "Local Terminal",
    sourceSession: localSession,
    localShellType: "zsh",
  });
});

test("copySessionToNewWindowWithCurrentShellImpl does nothing when the source session is gone", async () => {
  let called = false;

  await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({
          openSessionInNewWindow: async () => {
            called = true;
            return { success: true };
          },
        }),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [],
      terminalSettings: { localShell: "system-default" },
    }),
    "missing-session",
  );

  assert.equal(called, false);
});

test("copySessionToNewWindowWithCurrentShellImpl shows an error when Electron cannot open the window", async () => {
  const errors: string[] = [];

  const result = await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({
          openSessionInNewWindow: async () => ({ success: false }),
        }),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [sourceSession()],
      terminalSettings: { localShell: "system-default" },
      t: (key: string) => key === "tabs.copyTabToNewWindowFailed" ? "Could not open" : key,
      toast: {
        error: (message: string) => errors.push(message),
      },
    }),
    "session-1",
  );

  assert.equal(result, false);
  assert.deepEqual(errors, ["Could not open"]);
});

test("copySessionToNewWindowWithCurrentShellImpl shows an error when the bridge is unavailable", async () => {
  const errors: string[] = [];

  const result = await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({}),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [sourceSession()],
      terminalSettings: { localShell: "system-default" },
      t: (key: string) => key === "tabs.copyTabToNewWindowFailed" ? "Could not open" : key,
      toast: {
        error: (message: string) => errors.push(message),
      },
    }),
    "session-1",
  );

  assert.equal(result, false);
  assert.deepEqual(errors, ["Could not open"]);
});

test("copySessionToNewWindowWithCurrentShellImpl shows an error when the bridge throws", async () => {
  const errors: string[] = [];

  const result = await copySessionToNewWindowWithCurrentShellImpl(
    () => ({
      classifyLocalShellType: () => "zsh",
      discoveredShells: [],
      netcattyBridge: {
        get: () => ({
          openSessionInNewWindow: async () => {
            throw new Error("boom");
          },
        }),
      },
      resolveShellSetting: () => ({ command: "/bin/zsh" }),
      sessions: [sourceSession()],
      terminalSettings: { localShell: "system-default" },
      t: (key: string) => key === "tabs.copyTabToNewWindowFailed" ? "Could not open" : key,
      toast: {
        error: (message: string) => errors.push(message),
      },
    }),
    "session-1",
  );

  assert.equal(result, false);
  assert.deepEqual(errors, ["Could not open"]);
});

const moveCtx = (openTerminalPopup: ((payload: Record<string, unknown>) => Promise<unknown>) | undefined) => {
  const calls: unknown[][] = [];
  const errors: string[] = [];
  const getCtx = () => ({
    netcattyBridge: { get: () => (openTerminalPopup ? { openTerminalPopup } : {}) },
    sessions: [sourceSession({ id: "other" }), sourceSession()],
    setActiveTabId: (id: string) => calls.push(["active", id]),
    setSessionPoppedOut: (id: string, poppedOut: boolean) => calls.push(["poppedOut", id, poppedOut]),
    t: (key: string) => key,
    toast: { error: (message: string) => errors.push(message) },
  });
  return { calls, errors, getCtx };
};

test("moveSessionToNewWindowImpl hides the tab and attaches a popup to the same live session", async () => {
  const payloads: Record<string, unknown>[] = [];
  const { calls, errors, getCtx } = moveCtx(async (payload) => {
    payloads.push(payload);
    return { success: true };
  });

  assert.equal(await moveSessionToNewWindowImpl(getCtx, "session-1"), true);
  assert.deepEqual(calls, [["poppedOut", "session-1", true], ["active", "other"]]);
  assert.equal(payloads[0].attachSessionId, "session-1");
  assert.equal(payloads[0].moveSession, true);
  assert.deepEqual(errors, []);
});

test("moveSessionToNewWindowImpl leaves the tab untouched when the popup fails to attach", async () => {
  const { calls, errors, getCtx } = moveCtx(async () => ({ success: false, error: "boom" }));

  assert.equal(await moveSessionToNewWindowImpl(getCtx, "session-1"), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, ["boom"]);
});

test("moveSessionToNewWindowImpl waits for popup attachment before hiding the tab", async () => {
  let resolveOpen: ((value: unknown) => void) | null = null;
  const { calls, getCtx } = moveCtx(
    () => new Promise((resolve) => { resolveOpen = resolve; }),
  );

  const pending = moveSessionToNewWindowImpl(getCtx, "session-1");
  await Promise.resolve();
  assert.deepEqual(calls, []);

  resolveOpen?.({ success: true });
  assert.equal(await pending, true);
  assert.deepEqual(calls, [["poppedOut", "session-1", true], ["active", "other"]]);
});

test("moveSessionToNewWindowImpl ignores tabs without a live backend", async () => {
  const { calls, getCtx } = moveCtx(async () => ({ success: true }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({ ...ctx, sessions: [sourceSession({ status: "disconnected" })] }),
    "session-1",
  );
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test("moveSessionToNewWindowImpl ignores plugin-backed sessions", async () => {
  const { calls, getCtx } = moveCtx(async () => ({ success: true }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({ ...ctx, sessions: [sourceSession({ protocol: "plugin:com.acme.db" })] }),
    "session-1",
  );
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test("moveSessionToNewWindowImpl ignores workspace panes", async () => {
  const { calls, getCtx } = moveCtx(async () => ({ success: true }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({ ...ctx, sessions: [sourceSession({ workspaceId: "ws-1" })] }),
    "session-1",
  );
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test("moveSessionToNewWindowImpl preserves active tab focus when moving an inactive tab", async () => {
  const { calls, errors, getCtx } = moveCtx(async () => ({ success: true }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({
      ...ctx,
      getActiveTabId: () => "ws-1",
      getOrderedTabs: () => ["ws-1", "session-1"],
    }),
    "session-1",
  );
  assert.equal(result, true);
  assert.deepEqual(calls, [["poppedOut", "session-1", true]]);
  assert.deepEqual(errors, []);
});

test("moveSessionToNewWindowImpl does not steal focus when moving an inactive tab fails", async () => {
  const { calls, errors, getCtx } = moveCtx(async () => ({ success: false, error: "nope" }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({
      ...ctx,
      getActiveTabId: () => "editor:1",
      getOrderedTabs: () => ["editor:1", "session-1"],
    }),
    "session-1",
  );
  assert.equal(result, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, ["nope"]);
});

test("moveSessionToNewWindowImpl selects the adjacent ordered visible tab when moving the active tab", async () => {
  const { calls, getCtx } = moveCtx(async () => ({ success: true }));
  const ctx = getCtx();
  const result = await moveSessionToNewWindowImpl(
    () => ({
      ...ctx,
      sessions: [sourceSession()],
      getActiveTabId: () => "session-1",
      getOrderedTabs: () => ["ws-1", "session-1", "editor:1"],
    }),
    "session-1",
  );
  assert.equal(result, true);
  assert.deepEqual(calls, [["poppedOut", "session-1", true], ["active", "ws-1"]]);
});
