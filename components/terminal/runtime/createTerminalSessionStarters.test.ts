import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalSessionStarters,
  getMissingChainHostIds,
} from "./createTerminalSessionStarters";
import { createPromptLineBreakState } from "./promptLineBreak";
import { pasteTextIntoTerminal } from "./terminalUserPaste";

const noop = () => undefined;
const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwAAAA";

test("getMissingChainHostIds reports unresolved jump hosts", () => {
  assert.deepEqual(
    getMissingChainHostIds(
      {
        id: "host-1",
        label: "Example",
        hostname: "example.test",
        username: "alice",
        hostChain: { hostIds: ["jump-1", "jump-2"] },
      } as never,
      [{ id: "jump-1" }] as never,
    ),
    ["jump-2"],
  );
});
test("startSerial captures direct connected banner in terminal log data", async () => {
  const capturedLogData: string[] = [];
  const writtenData: string[] = [];

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
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
      id: "serial-host",
      label: "Serial",
      hostname: "COM3",
      username: "",
      protocol: "serial",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {},
    terminalBackend,
    serialConfig: {
      path: "COM3",
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    },
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
    onTerminalLogData: (data: string) => capturedLogData.push(data),
  };

  const term = {
    cols: 120,
    rows: 32,
    write: (data: string, callback?: () => void) => {
      writtenData.push(data);
      callback?.();
    },
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startSerial(term as never);

  const banner = "[Connected to COM3 at 9600 baud]";
  assert.deepEqual(writtenData, [`${banner}\r\n`]);
  assert.deepEqual(capturedLogData, [`${banner}\r\n`]);
});

test("local session captures paste cleanup writes in terminal log data", async () => {
  const capturedLogData: string[] = [];
  const writes: string[] = [];
  let onData: ((data: string) => void) | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: (_id: string, cb: (data: string) => void) => {
      onData = cb;
      return noop;
    },
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
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
    onTerminalLogData: (data: string) => capturedLogData.push(data),
  };

  const term = {
    cols: 20,
    rows: 4,
    paste: noop,
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      callback?.();
    },
    writeln: noop,
    scrollToBottom: noop,
  };

  const longPaste = Array.from({ length: 20 }, (_, index) => `line ${index} with enough content`).join("\n");
  pasteTextIntoTerminal(term, longPaste, { scrollOnPaste: false });
  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.notEqual(onData, null);
  onData?.("\x1b[7mline 3 with enough content\x1b[27m");

  assert.deepEqual(writes, ["line 3 with enough content", "\x1b[K"]);
  assert.deepEqual(capturedLogData, ["line 3 with enough content", "\x1b[K"]);
});

test("session data waits for prior terminal writes before evaluating prompt line breaks", async () => {
  const writes: string[] = [];
  const writeCallbacks: Array<() => void> = [];
  let onData: ((data: string) => void) | null = null;
  let cursorX = 0;
  let lineText = "";

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: (_id: string, cb: (data: string) => void) => {
      onData = cb;
      return noop;
    },
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };

  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "$ ";
  promptState.pendingCommand = true;

  const ctx = {
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: { forcePromptNewLine: true },
    terminalBackend,
    promptLineBreakStateRef: { current: promptState },
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
    get buffer() {
      return {
        active: {
          get cursorX() {
            return cursorX;
          },
          cursorY: 0,
          baseY: 0,
          getLine(line: number) {
            if (line !== 0) return undefined;
            return {
              isWrapped: false,
              translateToString() {
                return lineText;
              },
            };
          },
        },
      };
    },
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      if (callback) writeCallbacks.push(callback);
    },
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.notEqual(onData, null);
  onData?.("hello");
  onData?.("$ ");

  assert.deepEqual(writes, ["hello"]);

  cursorX = 5;
  lineText = "hello";
  writeCallbacks.shift()?.();

  assert.deepEqual(writes, ["hello", "\r\n$ "]);
});

test("prompt line break display insertion does not mutate captured session log data", async () => {
  const writes: string[] = [];
  const capturedLogData: string[] = [];
  const writeCallbacks: Array<() => void> = [];
  let onData: ((data: string) => void) | null = null;
  let cursorX = 0;
  let lineText = "";

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: (_id: string, cb: (data: string) => void) => {
      onData = cb;
      return noop;
    },
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };

  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "$ ";
  promptState.pendingCommand = true;

  const ctx = {
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: { forcePromptNewLine: true },
    terminalBackend,
    promptLineBreakStateRef: { current: promptState },
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
    onTerminalLogData: (data: string) => capturedLogData.push(data),
  };

  const term = {
    get buffer() {
      return {
        active: {
          get cursorX() {
            return cursorX;
          },
          cursorY: 0,
          baseY: 0,
          getLine(line: number) {
            if (line !== 0) return undefined;
            return {
              isWrapped: false,
              translateToString() {
                return lineText;
              },
            };
          },
        },
      };
    },
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      if (callback) writeCallbacks.push(callback);
    },
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.notEqual(onData, null);
  onData?.("hello");
  onData?.("$ ");

  cursorX = 5;
  lineText = "hello";
  writeCallbacks.shift()?.();

  assert.deepEqual(writes, ["hello", "\r\n$ "]);
  assert.deepEqual(capturedLogData, ["hello", "$ "]);
});

test("local session exit text waits for pending terminal output writes", async () => {
  const writes: string[] = [];
  const writeCallbacks: Array<() => void> = [];
  let onData: ((data: string) => void) | null = null;
  let onExit: ((evt: { reason?: "closed" }) => void) | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => "ssh-session",
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: (_id: string, cb: (data: string) => void) => {
      onData = cb;
      return noop;
    },
    onSessionExit: (_id: string, cb: (evt: { reason?: "closed" }) => void) => {
      onExit = cb;
      return noop;
    },
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };

  const ctx = {
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
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
    cols: 20,
    rows: 4,
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      if (callback) writeCallbacks.push(callback);
    },
    writeln: (data: string) => {
      writes.push(`${data}\r\n`);
    },
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startLocal(term as never);

  assert.notEqual(onData, null);
  assert.notEqual(onExit, null);
  onData?.("partial output");
  onExit?.({ reason: "closed" });

  assert.deepEqual(writes, ["partial output"]);

  writeCallbacks.shift()?.();

  assert.deepEqual(writes, ["partial output", "\r\n[session closed]\r\n"]);
});

test("startSSH allows jump hosts that use reference key files with unavailable saved passphrases", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  let error = "";

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
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
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
      port: 2200,
    },
    keys: [{
      id: "jump-key",
      label: "Jump key",
      source: "reference",
      privateKey: "",
      filePath: "/Users/alice/.ssh/id_ed25519",
      passphrase: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
    }],
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jumper",
      authMethod: "key",
      identityFileId: "jump-key",
    }],
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.equal(error, "");
  assert.ok(capturedOptions);
  const jumpHosts = capturedOptions.jumpHosts as Array<Record<string, unknown>>;
  assert.deepEqual(jumpHosts[0]?.identityFilePaths, ["/Users/alice/.ssh/id_ed25519"]);
  assert.equal(jumpHosts[0]?.privateKey, undefined);
  assert.equal(jumpHosts[0]?.passphrase, undefined);
});

test("startSSH omits identity file paths when password auth is selected", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
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
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      authMethod: "password",
      password: "secret",
      identityFilePaths: ["/Users/alice/.ssh/id_ed25519"],
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.password, "secret");
  assert.equal(capturedOptions.identityFilePaths, undefined);
});

test("startSSH passes known host records to the SSH bridge", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const knownHosts = [{
    id: "kh-1",
    hostname: "target.example.test",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: "SHA256:trusted-key",
    discoveredAt: 1,
  }];

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
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
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      authMethod: "password",
      password: "secret",
    },
    keys: [],
    knownHosts,
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.knownHosts, knownHosts);
});

test("startSSH omits jump host identity file paths when password auth is selected", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
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
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    keys: [],
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jumper",
      authMethod: "password",
      password: "secret",
      identityFilePaths: ["/Users/alice/.ssh/jump_ed25519"],
    }],
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.ok(capturedOptions);
  const jumpHosts = capturedOptions.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.password, "secret");
  assert.equal(jumpHosts[0]?.identityFilePaths, undefined);
});

test("startSSH tries local identity file paths before saved passwords for key auth", async () => {
  let capturedOptions: Record<string, unknown> | null = null;

  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
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
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      authMethod: "key",
      password: "saved-password",
      identityFilePaths: ["/Users/alice/.ssh/id_ed25519"],
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.password, undefined);
  assert.deepEqual(capturedOptions.identityFilePaths, ["/Users/alice/.ssh/id_ed25519"]);
});
