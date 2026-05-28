import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalSessionStarters,
  splitStartupCommandLines,
  normalizeStartupCommandDelay,
} from "./createTerminalSessionStarters";

const noop = () => undefined;
const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwAAAA";

test("startTelnet rejects missing saved proxy profiles", async () => {
  let started = false;
  let error = "";

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => {
      started = true;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
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
      telnetPort: 2323,
      proxyProfileId: "missing-proxy",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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
    setError: (message: string) => { error = message; },
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);

  assert.equal(started, false);
  assert.match(error, /Saved proxy/);
});

test("startTelnet passes saved telnet credentials without falling back after explicit clears", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
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
      username: "ssh-user",
      password: "ssh-password",
      telnetUsername: "",
      telnetPassword: "telnet-password",
      telnetPort: 2323,
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.username, "");
  assert.equal(capturedOptions.password, "telnet-password");
  assert.equal(capturedOptions.port, 2323);
});

test("startTelnet preserves an explicitly cleared telnet password", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
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
      username: "ssh-user",
      password: "ssh-password",
      telnetUsername: "telnet-user",
      telnetPassword: "",
      telnetPort: 2323,
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.username, "telnet-user");
  assert.equal(capturedOptions.password, "");
});

test("startTelnet rejects unreadable saved telnet passwords before connecting", async () => {
  let started = false;
  let error = "";
  let needsAuth = true;
  let retryMessage: string | null = "previous";
  let status = "";
  const writes: string[] = [];

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => {
      started = true;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
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
      username: "ssh-user",
      password: "ssh-password",
      telnetUsername: "telnet-user",
      telnetPassword: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      telnetPort: 2323,
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
    terminalBackend,
    sessionRef: { current: null },
    hasConnectedRef: { current: false },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    updateStatus: (next: string) => { status = next; },
    setStatus: noop,
    setError: (message: string) => { error = message; },
    setNeedsAuth: (value: boolean) => { needsAuth = value; },
    setAuthRetryMessage: (message: string | null) => { retryMessage = message; },
    setAuthPassword: noop,
    setProgressLogs: noop,
    setProgressValue: noop,
    setChainProgress: noop,
  };

  const term = {
    cols: 120,
    rows: 32,
    write: (data: string) => { writes.push(data); },
    writeln: (data: string) => { writes.push(data); },
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);

  assert.equal(started, false);
  assert.equal(needsAuth, false);
  assert.equal(retryMessage, null);
  assert.equal(status, "disconnected");
  assert.match(error, /Saved credentials cannot be decrypted/);
  assert.match(writes.join("\n"), /Saved credentials cannot be decrypted/);
});

test("startTelnet waits for auto-login before running the startup command", async () => {
  const writtenCommands: string[] = [];
  const executedCommands: string[] = [];
  let capturedOptions: Record<string, unknown> | null = null;
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;
  let disposedAutoLoginCancelListener = false;
  let resolveCommand: (() => void) | null = null;
  const commandWritten = new Promise<void>((resolve) => {
    resolveCommand = resolve;
  });

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onTelnetAutoLoginComplete: (sessionId: string, cb: (evt: { sessionId: string }) => void) => {
      assert.equal(sessionId, "session-1");
      autoLoginComplete = cb;
      return noop;
    },
    onTelnetAutoLoginCancelled: () => () => {
      disposedAutoLoginCancelListener = true;
    },
    onChainProgress: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
      resolveCommand?.();
    },
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      username: "ssh-user",
      telnetUsername: "telnet-user",
      telnetPassword: "",
      telnetPort: 2323,
      startupCommand: "show version",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  };

  const term = {
    cols: 120,
    rows: 32,
    write: noop,
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);
  assert.ok(capturedOptions);
  assert.ok(autoLoginComplete);

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(writtenCommands, []);
  assert.deepEqual(executedCommands, []);

  autoLoginComplete({ sessionId: "session-1" });

  await Promise.race([
    commandWritten,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for startup command")), 1000)),
  ]);

  assert.deepEqual(writtenCommands, ["show version\r"]);
  assert.deepEqual(executedCommands, ["show version"]);
  assert.equal(disposedAutoLoginCancelListener, true);
});

test("startTelnet runs a multi-line startup command in sequence", async () => {
  const writtenCommands: string[] = [];
  const executedCommands: string[] = [];
  let capturedOptions: Record<string, unknown> | null = null;
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;
  let disposedAutoLoginCancelListener = false;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onTelnetAutoLoginComplete: (sessionId: string, cb: (evt: { sessionId: string }) => void) => {
      assert.equal(sessionId, "session-1");
      autoLoginComplete = cb;
      return noop;
    },
    onTelnetAutoLoginCancelled: () => () => {
      disposedAutoLoginCancelListener = true;
    },
    onChainProgress: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      username: "ssh-user",
      telnetUsername: "telnet-user",
      telnetPassword: "",
      telnetPort: 2323,
      startupCommand: "first cmd\nsecond cmd",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: { startupCommandDelayMs: 20 },
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
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  };

  const term = {
    cols: 120,
    rows: 32,
    write: noop,
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);
  assert.ok(capturedOptions);
  assert.ok(autoLoginComplete);

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(writtenCommands, []);
  assert.deepEqual(executedCommands, []);

  autoLoginComplete({ sessionId: "session-1" });

  // Wait long enough for both lines (delay before first + delay between).
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(writtenCommands, ["first cmd\r", "second cmd\r"]);
  assert.deepEqual(executedCommands, ["first cmd", "second cmd"]);
  assert.equal(disposedAutoLoginCancelListener, true);
});

test("startTelnet cancels pending startup command when user takes over", async () => {
  const writtenCommands: string[] = [];
  let capturedOptions: Record<string, unknown> | null = null;
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;
  let autoLoginCancelled: ((evt: { sessionId: string }) => void) | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onTelnetAutoLoginComplete: (_sessionId: string, cb: (evt: { sessionId: string }) => void) => {
      autoLoginComplete = cb;
      return noop;
    },
    onTelnetAutoLoginCancelled: (_sessionId: string, cb: (evt: { sessionId: string }) => void) => {
      autoLoginCancelled = cb;
      return noop;
    },
    onChainProgress: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      telnetUsername: "telnet-user",
      telnetPassword: "secret",
      startupCommand: "show version",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);
  assert.ok(capturedOptions);
  assert.ok(autoLoginComplete);
  assert.ok(autoLoginCancelled);

  autoLoginComplete({ sessionId: "session-1" });
  autoLoginCancelled({ sessionId: "session-1" });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(writtenCommands, []);
});

test("startTelnet does not run startup command if auto-login never completes", async () => {
  const writtenCommands: string[] = [];
  const executedCommands: string[] = [];
  let capturedOptions: Record<string, unknown> | null = null;
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;
  let disposedAutoLoginListener = false;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onTelnetAutoLoginComplete: (_sessionId: string, cb: (evt: { sessionId: string }) => void) => {
      autoLoginComplete = cb;
      return () => {
        disposedAutoLoginListener = true;
      };
    },
    onChainProgress: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      username: "ssh-user",
      telnetUsername: "telnet-user",
      telnetPassword: "",
      telnetPort: 2323,
      startupCommand: "show version",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  };

  const term = {
    cols: 120,
    rows: 32,
    write: noop,
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);
  assert.ok(capturedOptions);
  assert.ok(autoLoginComplete);

  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(writtenCommands, []);
  assert.deepEqual(executedCommands, []);

  ctx.disposeExitRef.current?.();
  assert.equal(disposedAutoLoginListener, true);
});

test("startTelnet does not run startup command during manual login", async () => {
  const writtenCommands: string[] = [];
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "host-1",
      label: "Example",
      hostname: "example.test",
      username: undefined,
      password: undefined,
      telnetUsername: undefined,
      telnetPassword: undefined,
      port: 2222,
      startupCommand: "show version",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.port, 23);
  assert.deepEqual(writtenCommands, []);
});

test("startTelnet rejects configured proxies instead of connecting directly", async () => {
  let started = false;
  let error = "";

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => {
      started = true;
      return "telnet-session";
    },
    startMoshSession: async () => "mosh-session",
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
      telnetPort: 2323,
      proxyProfileId: "proxy-1",
      proxyConfig: { type: "http", host: "proxy.example.com", port: 3128 },
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
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
    setError: (message: string) => { error = message; },
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

  await createTerminalSessionStarters(ctx as never).startTelnet(term as never);

  assert.equal(started, false);
  assert.match(error, /Telnet does not support proxy/);
});

test("splitStartupCommandLines drops blank lines but keeps content verbatim", () => {
  assert.deepEqual(splitStartupCommandLines("sudo -i\nalias dc=\"docker compose\""), [
    "sudo -i",
    'alias dc="docker compose"',
  ]);
  // Single-line content is preserved verbatim (leading/trailing spaces kept).
  assert.deepEqual(splitStartupCommandLines("  cd /app  "), ["  cd /app  "]);
  assert.deepEqual(splitStartupCommandLines("a\n\n  \nb"), ["a", "b"]);
  assert.deepEqual(splitStartupCommandLines("echo hi\r\nwhoami"), ["echo hi", "whoami"]);
  assert.deepEqual(splitStartupCommandLines(""), []);
  assert.deepEqual(splitStartupCommandLines("   "), []);
});

test("normalizeStartupCommandDelay defaults and clamps", () => {
  assert.equal(normalizeStartupCommandDelay(undefined), 600);
  assert.equal(normalizeStartupCommandDelay(Number.NaN), 600);
  assert.equal(normalizeStartupCommandDelay(0), 0);
  assert.equal(normalizeStartupCommandDelay(1500), 1500);
  assert.equal(normalizeStartupCommandDelay(-50), 0);
  assert.equal(normalizeStartupCommandDelay(999999), 10000);
});
