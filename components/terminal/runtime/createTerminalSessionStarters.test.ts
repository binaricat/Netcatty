import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalSessionStarters,
  getMissingChainHostIds,
} from "./createTerminalSessionStarters";
import { createPromptLineBreakState } from "./promptLineBreak";
import { resolveStartupCommand } from "./terminalStartupCommands";
import { pasteTextIntoTerminal } from "./terminalUserPaste";

const noop = () => undefined;
const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwAAAA";

const armSudoPrompt = (
  autofill: { armForCommand: (command: string) => void } | null,
  command = "sudo whoami",
): string => {
  autofill?.armForCommand(command);
  return "[sudo] password for alice: ";
};

const createTermStub = () => ({
  cols: 120,
  rows: 32,
  write: (_data: string, callback?: () => void) => callback?.(),
  writeln: noop,
  scrollToBottom: noop,
});

const createStarterContext = (overrides: Record<string, unknown> = {}) => ({
  onSudoHint: () => true,
  host: {
    id: "host-1",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
  },
  keys: [],
  identities: [],
  knownHosts: [],
  resolvedChainHosts: [],
  sessionId: "session-1",
  terminalSettings: {},
  sessionRef: { current: null },
  hasConnectedRef: { current: true },
  hasRunStartupCommandRef: { current: false },
  disposeDataRef: { current: null },
  disposeExitRef: { current: null },
  fitAddonRef: { current: null },
  serializeAddonRef: { current: null },
  pendingAuthRef: { current: null },
  promptLineBreakStateRef: { current: createPromptLineBreakState() },
  sudoAutofillRef: { current: null },
  updateStatus: noop,
  setStatus: noop,
  setError: noop,
  setNeedsAuth: noop,
  setAuthRetryMessage: noop,
  setAuthPassword: noop,
  setProgressLogs: noop,
  setProgressValue: noop,
  setChainProgress: noop,
  ...overrides,
});

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

test("startSSH forwards custom ProxyCommand to the SSH bridge", async () => {
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
      port: 2200,
      proxyConfig: {
        type: "command",
        host: "",
        port: 0,
        command: "cloudflared access ssh --hostname %h",
      },
    },
    keys: [],
    identities: [],
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
    write: (_data: string, callback?: () => void) => callback?.(),
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.deepEqual(capturedOptions?.proxy, {
    type: "command",
    host: "",
    port: 0,
    command: "cloudflared access ssh --hostname %h",
    username: undefined,
    password: undefined,
  });
});

test("startSSH sends key and password together in one connection for publickey+password MFA hosts", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  let startCalls = 0;
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      startCalls += 1;
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
      port: 22,
      authMethod: "key",
      identityFilePaths: ["/Users/me/.ssh/key"],
      password: "login-secret",
      savePassword: true,
    },
    keys: [],
    identities: [],
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
    write: (_data: string, callback?: () => void) => callback?.(),
    writeln: noop,
    scrollToBottom: noop,
  };

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.equal(startCalls, 1, "credentials must go in a single connection, not separate per-factor attempts");
  assert.equal(capturedOptions?.password, "login-secret");
  assert.deepEqual(capturedOptions?.identityFilePaths, ["/Users/me/.ssh/key"]);
});

test("startSSH forwards the saved sudo autofill password to the SSH bridge", async () => {
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
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      password: "login-secret",
    },
    terminalBackend,
    sudoAutofillPassword: "sudo-secret",
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(capturedOptions?.sudoAutofillPassword, "sudo-secret");
});

test("startSSH enables sudo autofill only with the host saved password", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
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
    writeToSession: (_id: string, data: string) => sent.push(data),
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      password: "saved-secret",
    },
    terminalBackend,
    sudoAutofillPassword: "saved-secret",
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  onData?.(armSudoPrompt(ctx.sudoAutofillRef.current));
  ctx.sudoAutofillRef.current?.confirmFill();

  assert.deepEqual(sent, ["saved-secret\n"]);
});

test("startSSH does not use unsaved retry passwords for sudo autofill", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
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
    writeToSession: (_id: string, data: string) => sent.push(data),
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
    },
    pendingAuthRef: {
      current: {
        authMethod: "password",
        username: "alice",
        password: "temporary-secret",
        savedToHost: false,
      },
    },
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  ctx.sudoAutofillRef.current?.armForCommand("sudo whoami");
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});

test("startSSH uses pending saved auth for sudo autofill on the first saved connection", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
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
    writeToSession: (_id: string, data: string) => sent.push(data),
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
    },
    pendingAuthRef: {
      current: {
        authMethod: "password",
        username: "alice",
        password: "pending-secret",
        savedToHost: true,
      },
    },
    terminalBackend,
    sudoAutofillPasswordRef: { current: "stale-secret" },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  ctx.sudoAutofillRef.current?.armForCommand("sudo whoami");
  onData?.("[sudo] password for alice: ");
  ctx.sudoAutofillRef.current?.confirmFill();

  assert.deepEqual(sent, ["pending-secret\n"]);
});

test("startSSH does not use merged group default passwords for sudo autofill", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
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
    writeToSession: (_id: string, data: string) => sent.push(data),
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      password: "group-default-secret",
    },
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  ctx.sudoAutofillRef.current?.armForCommand("sudo whoami");
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});

test("startSSH uses the provided sudo autofill password", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
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
    writeToSession: (_id: string, data: string) => sent.push(data),
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
    },
    terminalBackend,
    sudoAutofillPassword: "host-secret",
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  onData?.(armSudoPrompt(ctx.sudoAutofillRef.current));
  ctx.sudoAutofillRef.current?.confirmFill();

  assert.deepEqual(sent, ["host-secret\n"]);
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

test("local session runs startup command after attaching", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const attached: string[] = [];

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
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
    resizeSession: noop,
  };

  const ctx = createStarterContext({
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: "docker logs -f --tail 200 abc123",
    promptLineBreakStateRef: undefined,
    onSessionAttached: (id: string) => attached.push(id),
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(attached, ["local-session"]);
  assert.deepEqual(sessionWrites, [{
    id: "local-session",
    data: "docker logs -f --tail 200 abc123\r",
    automated: true,
  }]);
});

test("ssh snippet startup command restores terminal mode after attaching", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];

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
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
    resizeSession: noop,
  };

  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "CentOS",
      hostname: "centos.example.test",
      username: "alice",
      protocol: "ssh",
      os: "linux",
      distro: "centos",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: "bash <(curl -sSL https://linuxmirrors.cn/docker.sh)",
    protectStartupCommandTerminalMode: true,
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sessionWrites.length, 1);
  assert.equal(sessionWrites[0].id, "ssh-session");
  assert.equal(sessionWrites[0].automated, true);
  assert.match(sessionWrites[0].data, /mkdir -m 700 \/tmp\/\.netcatty-/);
  assert.match(sessionWrites[0].data, /stty -g > stty/);
  assert.equal(sessionWrites[0].data.endsWith("\r"), true);
});

test("startup command suppression is consumed only when scheduling", () => {
  const suppressHostStartupCommandRef = { current: true };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      startupCommand: "echo host-startup",
    },
    startupCommand: undefined,
    suppressHostStartupCommandRef,
  });

  assert.equal(resolveStartupCommand(ctx as never), undefined);
  assert.equal(suppressHostStartupCommandRef.current, true);
  assert.equal(
    resolveStartupCommand(ctx as never, { consumeSuppressHostStartupCommand: true }),
    undefined,
  );
  assert.equal(suppressHostStartupCommandRef.current, false);
  assert.equal(resolveStartupCommand(ctx as never), "echo host-startup");
});

test("restored local reconnect does not fall back to host startup command", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];

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
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
    resizeSession: noop,
  };

  const ctx = createStarterContext({
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
      startupCommand: "echo host-startup",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: undefined,
    suppressHostStartupCommandRef: { current: true },
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, []);
});

test("local session restores cwd before startup command after attaching", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const executedCommands: string[] = [];
  const progressLogs: string[] = [];

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
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
    resizeSession: noop,
  };

  const restoreCwdIntentRef = {
    current: { cwd: "/srv/app dir", command: "cd -- '/srv/app dir'" },
  };
  const ctx = createStarterContext({
    host: {
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: "pwd",
    promptLineBreakStateRef: undefined,
    restoreCwdIntentRef,
    setProgressLogs: (updater: (prev: string[]) => string[]) => {
      progressLogs.splice(0, progressLogs.length, ...updater(progressLogs));
    },
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(restoreCwdIntentRef.current, null);
  assert.deepEqual(sessionWrites, [
    { id: "local-session", data: "cd -- '/srv/app dir'\r", automated: true },
    { id: "local-session", data: "pwd\r", automated: true },
  ]);
  assert.deepEqual(executedCommands, ["pwd"]);
  assert.deepEqual(progressLogs, ["Restoring working directory: /srv/app dir"]);
});

test("ssh session restores cwd before startup command after attaching", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const executedCommands: string[] = [];
  const progressLogs: string[] = [];

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
    writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
      sessionWrites.push({ id, data, automated: options?.automated });
    },
    resizeSession: noop,
  };

  const restoreCwdIntentRef = {
    current: { cwd: "/srv/app dir", command: "cd -- '/srv/app dir'" },
  };
  const ctx = createStarterContext({
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: "pwd",
    promptLineBreakStateRef: undefined,
    restoreCwdIntentRef,
    setProgressLogs: (updater: (prev: string[]) => string[]) => {
      progressLogs.splice(0, progressLogs.length, ...updater(progressLogs));
    },
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(restoreCwdIntentRef.current, null);
  assert.deepEqual(sessionWrites, [
    { id: "ssh-session", data: "cd -- '/srv/app dir'\r", automated: true },
    { id: "ssh-session", data: "pwd\r", automated: true },
  ]);
  assert.deepEqual(executedCommands, ["pwd"]);
  assert.deepEqual(progressLogs, ["Restoring working directory: /srv/app dir"]);
});

test("local session resets terminal timestamp state when reusing a terminal", async () => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let onData: ((data: string) => void) | null = null;
  let cursorLine = 0;

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
      showLineTimestamps: true,
    },
    keys: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalSettings: {
      showLineTimestamps: true,
      scrollOnOutput: false,
      forcePromptNewLine: false,
    },
    terminalBackend,
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
  };

  const term = {
    cols: 20,
    rows: 4,
    buffer: { active: { type: "normal" } },
    write: (data: string, callback?: () => void) => {
      writes.push(data);
      for (const char of data) {
        if (char === "\n") {
          cursorLine += 1;
        }
      }
      callback?.();
    },
    registerMarker: (offset: number) => {
      const line = cursorLine + offset;
      markerLines.push(line);
      const marker = {
        line,
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
          disposedMarkerLines.push(line);
        },
      };
      return marker;
    },
    writeln: noop,
    scrollToBottom: noop,
  };

  const starters = createTerminalSessionStarters(ctx as never);
  await starters.startLocal(term as never);
  onData?.("unfinished");
  await starters.startLocal(term as never);
  onData?.("fresh");

  assert.equal(writes.length, 2);
  assert.equal(writes[0], "unfinished");
  assert.equal(writes[1], "fresh");
  assert.deepEqual(markerLines, [0, 0]);
  assert.deepEqual(disposedMarkerLines, [0]);
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

test("startSSH forwards the SSH debug logging setting to the native bridge", async () => {
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
      port: 22,
      password: "pw",
    },
    keys: [],
    knownHosts: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalBackend,
    sshDebugLogEnabled: true,
    terminalSettings: { keepaliveInterval: 30, keepaliveCountMax: 10 },
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
    onSessionAttached: noop,
  };

  const term = {
    cols: 120,
    rows: 32,
    write: (_data: string, cb?: () => void) => cb?.(),
    loadAddon: noop,
  };
  await createTerminalSessionStarters(ctx as unknown as TerminalSessionStartersContext).startSSH(term);

  assert.equal(capturedOptions?.sshDebugLogEnabled, true);
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

test("startSSH sends local identity file paths with saved passwords for key auth", async () => {
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
  assert.equal(capturedOptions.password, "saved-password");
  assert.deepEqual(capturedOptions.identityFilePaths, ["/Users/alice/.ssh/id_ed25519"]);
});
