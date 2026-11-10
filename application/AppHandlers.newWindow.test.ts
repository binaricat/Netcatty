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

const moveCtx = (openTerminalPopup: ((payload: any) => Promise<unknown>) | undefined) => {
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
  const payloads: any[] = [];
  const { calls, errors, getCtx } = moveCtx(async (payload) => {
    payloads.push(payload);
    return { success: true };
  });

  assert.equal(await moveSessionToNewWindowImpl(getCtx, "session-1"), true);
  assert.deepEqual(calls, [["poppedOut", "session-1", true], ["active", "other"]]);
  assert.equal(payloads[0].attachSessionId, "session-1");
  assert.deepEqual(errors, []);
});

test("moveSessionToNewWindowImpl restores the tab when the popup fails to open", async () => {
  const { calls, errors, getCtx } = moveCtx(async () => ({ success: false, error: "boom" }));

  assert.equal(await moveSessionToNewWindowImpl(getCtx, "session-1"), false);
  assert.deepEqual(calls.slice(-2), [["poppedOut", "session-1", false], ["active", "session-1"]]);
  assert.deepEqual(errors, ["boom"]);
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
