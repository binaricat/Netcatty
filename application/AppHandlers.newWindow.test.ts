import test from "node:test";
import assert from "node:assert/strict";

import type { TerminalSession } from "../domain/models";
import { copySessionToNewWindowWithCurrentShellImpl } from "./app/AppHandlers";

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
