import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalSessionStarters } from "./createTerminalSessionStarters";

const noop = () => undefined;

test("startMosh does not pass legacy configured mosh client paths to the backend", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "mosh-session";
    },
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      username: "alice",
      port: 2200,
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {
      terminalEmulationType: "xterm-256color",
      moshClientPath: "/usr/local/bin/mosh-client",
    },
    terminalBackend,
    sessionRef: { current: null },
    hasConnectedRef: { current: false },
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
  };

  const term = {
    cols: 120,
    rows: 32,
    write: noop,
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startMosh(term as never);

  assert.ok(capturedOptions);
  assert.equal("moshClientPath" in capturedOptions, false);
  assert.equal(capturedOptions.hostname, "example.test");
  assert.equal(capturedOptions.port, 2200);
});
