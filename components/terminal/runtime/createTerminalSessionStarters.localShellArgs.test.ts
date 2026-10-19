import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalSessionStarters } from "./createTerminalSessionStarters";

const noop = () => undefined;

const makeCtx = (
  host: Record<string, unknown>,
  startLocalSession: (options: Record<string, unknown>) => Promise<string>,
) => ({
  host: {
    id: "host-1",
    label: "Local Shell",
    hostname: "localhost",
    username: "",
    protocol: "local",
    ...host,
  },
  keys: [],
  identities: [],
  resolvedChainHosts: [],
  sessionId: "session-1",
  terminalSettings: {},
  terminalBackend: {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    etAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startLocalSession,
    onSessionData: () => noop,
    onSessionExit: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  },
  sessionRef: { current: null },
  hasConnectedRef: { current: true },
  hasRunStartupCommandRef: { current: false },
  disposeDataRef: { current: null },
  disposeExitRef: { current: null },
  fitAddonRef: { current: null },
  serializeAddonRef: { current: null },
  pendingAuthRef: { current: null },
  updateStatus: noop,
  setStatus: noop,
  setError: noop,
  setNeedsAuth: noop,
  setAuthRetryMessage: noop,
  setAuthPassword: noop,
  setProgressLogs: noop,
  setProgressValue: noop,
  setChainProgress: noop,
});

const term = {
  cols: 120,
  rows: 32,
  write: noop,
  writeln: noop,
  scrollToBottom: noop,
};

test("startLocal omits an empty no-args snapshot so backend defaults apply", async () => {
  // Vault local hosts snapshot absent args as [] to keep launch-time no-args
  // semantics for clone/popup relaunch, but the snapshot must not be passed to
  // the bridge: an empty array is truthy and would suppress the bridge's
  // discovered-shell args and getLocalShellArgs fallbacks (login flags,
  // PowerShell -NoLogo).
  let started: Record<string, unknown> | null = null;
  const ctx = makeCtx(
    { localShell: "fish", localShellArgs: [] },
    async (options) => {
      started = options;
      return "local-session";
    },
  );

  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.ok(started);
  assert.equal((started as { shell?: string }).shell, "fish");
  assert.equal((started as { shellArgs?: string[] }).shellArgs, undefined);
});

test("startLocal passes explicit local shell args through", async () => {
  let started: Record<string, unknown> | null = null;
  const ctx = makeCtx(
    { localShell: "bash", localShellArgs: ["--login", "-i"] },
    async (options) => {
      started = options;
      return "local-session";
    },
  );

  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.ok(started);
  assert.equal((started as { shell?: string }).shell, "bash");
  assert.deepEqual((started as { shellArgs?: string[] }).shellArgs, ["--login", "-i"]);
});
