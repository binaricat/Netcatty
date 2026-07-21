import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalSessionStarters,
  getMissingChainHostIds,
} from "./createTerminalSessionStarters";
import { createPromptLineBreakState } from "./promptLineBreak";
import { resolveStartupCommand } from "./terminalStartupCommands";
import { pasteTextIntoTerminal } from "./terminalUserPaste";
import { shouldSuppressHostStartupCommandOnReconnect } from "../restoredSessionGate";

const noop = () => undefined;
const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwAAAA";

const armSudoPrompt = (
  autofill: { armForCommand: (command: string) => void } | null,
  command = "sudo whoami",
): string => {
  autofill?.armForCommand(command);
  return "[sudo] password for alice: ";
};

const createTermStub = (overrides: Record<string, unknown> = {}) => ({
  cols: 120,
  rows: 32,
  write: (_data: string, callback?: () => void) => callback?.(),
  writeln: noop,
  scrollToBottom: noop,
  ...overrides,
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

test("startSSH forwards imported system agent authentication settings", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const terminalBackend = {
    backendAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "aws-sg",
      hostname: "1.1.1.1",
      username: "root",
      port: 2222,
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.deepEqual(
    capturedOptions && {
      useSshAgent: capturedOptions.useSshAgent,
      identityAgent: capturedOptions.identityAgent,
      identityFilePaths: capturedOptions.identityFilePaths,
      identitiesOnly: capturedOptions.identitiesOnly,
      addKeysToAgent: capturedOptions.addKeysToAgent,
      useKeychain: capturedOptions.useKeychain,
    },
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("startSSH tells the bridge to skip shell discovery for network devices", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const terminalBackend = {
    backendAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    isNetworkDevice: true,
    reuseConnectionFromSessionId: "source-session",
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(capturedOptions?.sourceSessionId, "source-session");
  assert.equal(capturedOptions?.skipShellPidDiscovery, true);
});

test("startSSH uses the system agent when a synced vault key cannot be decrypted", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const terminalBackend = {
    backendAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "ssh-session";
    },
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Agent host",
      hostname: "agent.example.test",
      username: "root",
      authMethod: "key",
      identityFileId: "key-1",
      useSshAgent: true,
    },
    keys: [{
      id: "key-1",
      label: "Synced key",
      type: "ED25519",
      publicKey: "ssh-ed25519 AAAASELECTED",
      privateKey: "enc:v1:djEwAAAA",
      source: "imported",
      category: "key",
      created: 1,
    }],
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(capturedOptions?.useSshAgent, true);
  assert.deepEqual(capturedOptions?.agentPublicKeys, ["ssh-ed25519 AAAASELECTED"]);
  assert.equal(capturedOptions?.privateKey, undefined);
});

for (const protocol of ["Mosh", "ET"] as const) {
  test(`${protocol} keeps certificate signing material when the system agent toggle is also enabled`, async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const terminalBackend = {
      backendAvailable: () => true,
      moshAvailable: () => true,
      etAvailable: () => true,
      startMoshSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "mosh-session";
      },
      startEtSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "et-session";
      },
      onSessionData: () => noop,
      onSessionExit: () => noop,
      writeToSession: noop,
      resizeSession: noop,
    };
    const ctx = createStarterContext({
      host: {
        id: "host-1",
        label: "Certificate host",
        hostname: "cert.example.test",
        username: "alice",
        authMethod: "certificate",
        identityFileId: "cert-key",
        useSshAgent: true,
      },
      keys: [{
        id: "cert-key",
        label: "Certificate key",
        type: "ED25519",
        category: "key",
        source: "imported",
        created: 1,
        privateKey: "PRIVATE KEY",
        certificate: "ssh-ed25519-cert-v01@openssh.com AAAATEST",
      }],
      terminalBackend,
    });

    const starters = createTerminalSessionStarters(ctx as never);
    if (protocol === "Mosh") await starters.startMosh(createTermStub() as never);
    else await starters.startEt(createTermStub() as never);

    assert.equal(capturedOptions?.privateKey, "PRIVATE KEY");
    assert.equal(capturedOptions?.certificate, "ssh-ed25519-cert-v01@openssh.com AAAATEST");
    assert.equal(capturedOptions?.useSshAgent, false);
  });
}

for (const protocol of ["Mosh", "ET"] as const) {
  test(`${protocol} keeps an imported private key when agent filtering is unavailable`, async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const terminalBackend = {
      backendAvailable: () => true,
      moshAvailable: () => true,
      etAvailable: () => true,
      startMoshSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "mosh-session";
      },
      startEtSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "et-session";
      },
      onSessionData: () => noop,
      onSessionExit: () => noop,
      writeToSession: noop,
      resizeSession: noop,
    };
    const ctx = createStarterContext({
      host: {
        id: "host-1",
        label: "Imported key host",
        hostname: "key.example.test",
        username: "alice",
        authMethod: "key",
        identityFileId: "key-1",
        useSshAgent: true,
      },
      keys: [{
        id: "key-1",
        label: "Imported key",
        type: "ED25519",
        category: "key",
        source: "imported",
        created: 1,
        privateKey: "PRIVATE KEY",
        passphrase: "key-passphrase",
      }],
      terminalBackend,
    });

    const starters = createTerminalSessionStarters(ctx as never);
    if (protocol === "Mosh") await starters.startMosh(createTermStub() as never);
    else await starters.startEt(createTermStub() as never);

    assert.equal(capturedOptions?.useSshAgent, false);
    assert.equal(capturedOptions?.privateKey, "PRIVATE KEY");
    assert.equal(capturedOptions?.passphrase, "key-passphrase");
  });
}

for (const protocol of ["Mosh", "ET"] as const) {
  test(`${protocol} keeps automatic key discovery available with an unreadable saved password`, async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    let needsAuth = false;
    const terminalBackend = {
      backendAvailable: () => true,
      moshAvailable: () => true,
      etAvailable: () => true,
      startMoshSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "mosh-session";
      },
      startEtSession: async (options: Record<string, unknown>) => {
        capturedOptions = options;
        return "et-session";
      },
      onSessionData: () => noop,
      onSessionExit: () => noop,
      writeToSession: noop,
      resizeSession: noop,
    };
    const ctx = createStarterContext({
      host: {
        id: "host-1",
        label: "Automatic host",
        hostname: "auto.example.test",
        username: "alice",
        authMethod: "auto",
        password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      },
      terminalBackend,
      setNeedsAuth: (value: boolean) => { needsAuth = value; },
    });

    const starters = createTerminalSessionStarters(ctx as never);
    if (protocol === "Mosh") await starters.startMosh(createTermStub() as never);
    else await starters.startEt(createTermStub() as never);

    assert.equal(needsAuth, false);
    assert.equal(capturedOptions?.authMethod, "auto");
    assert.equal(capturedOptions?.password, undefined);
  });
}

test("ET keeps automatic jump discovery available with an unreadable saved password", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const terminalBackend = {
    backendAvailable: () => true,
    etAvailable: () => true,
    startEtSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "et-session";
    },
    onSessionData: () => noop,
    onSessionExit: () => noop,
    writeToSession: noop,
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      authMethod: "auto",
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "ops",
      authMethod: "auto",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
    }],
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startEt(createTermStub() as never);

  const jumpHosts = capturedOptions?.jumpHosts as Array<Record<string, unknown>> | undefined;
  assert.equal(jumpHosts?.[0]?.authMethod, "auto");
  assert.equal(jumpHosts?.[0]?.password, undefined);
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

test("startSSH resolves target proxy credentials from an identity", async () => {
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.deepEqual(capturedOptions?.proxy, {
    type: "http",
    host: "proxy.example.test",
    port: 3128,
    username: "proxy-user",
    password: "proxy-secret",
  });
});

test("startSSH resolves jump host proxy credentials from an identity", async () => {
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      sshTcpConnectTimeoutSeconds: 50,
      sshAuthReadyTimeoutSeconds: 240,
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jump",
      requiresMfa: true,
      sshTcpConnectTimeoutSeconds: 75,
      sshAuthReadyTimeoutSeconds: 360,
      proxyConfig: {
        type: "socks5",
        host: "jump-proxy.example.test",
        port: 1080,
        identityId: "identity-1",
      },
    }],
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  const jumpHosts = capturedOptions?.jumpHosts as Array<Record<string, unknown>>;
  assert.deepEqual(jumpHosts[0]?.proxy, {
    type: "socks5",
    host: "jump-proxy.example.test",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.equal(capturedOptions?.sshTcpConnectTimeoutMs, 50_000);
  assert.equal(capturedOptions?.sshAuthReadyTimeoutMs, 240_000);
  assert.equal(jumpHosts[0]?.requiresMfa, true);
  assert.equal(jumpHosts[0]?.sshTcpConnectTimeoutMs, 75_000);
  assert.equal(jumpHosts[0]?.sshAuthReadyTimeoutMs, 360_000);
});

test("startSSH shows jump-host auth failures without opening target auth retry", async () => {
  let error = "";
  let needsAuth = false;
  let retryMessage: string | null = "previous retry";
  let status = "";
  const progressLogs: string[] = [];
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      const err = new Error('Jump host authentication failed for "Bastion": All configured authentication methods failed');
      (err as Error & { isJumpHostAuthError?: boolean }).isJumpHostAuthError = true;
      throw err;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Bastion",
      hostname: "bastion.example.test",
      username: "jump",
      password: "wrong-secret",
    }],
    setError: (message: string) => { error = message; },
    setNeedsAuth: (value: boolean) => { needsAuth = value; },
    setAuthRetryMessage: (message: string | null) => { retryMessage = message; },
    setStatus: (next: string) => { status = next; },
    updateStatus: (next: string) => { status = next; },
    setProgressLogs: (next: string[] | ((prev: string[]) => string[])) => {
      if (typeof next === "function") {
        progressLogs.splice(0, progressLogs.length, ...next(progressLogs));
      } else {
        progressLogs.splice(0, progressLogs.length, ...next);
      }
    },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(needsAuth, false);
  assert.equal(retryMessage, null);
  assert.equal(status, "disconnected");
  assert.match(error, /Jump host authentication failed for "Bastion"/);
  assert.equal(progressLogs.some((line) => /Authentication failed\. Please try again/.test(line)), false);
});

test("startSSH recognizes Electron-prefixed jump-host auth failures", async () => {
  let error = "";
  let needsAuth = false;
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      throw new Error(
        'Error invoking remote method "netcatty:start": Error: Jump host authentication failed for "Bastion": All configured authentication methods failed',
      );
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
    terminalBackend,
    setNeedsAuth: (value: boolean) => { needsAuth = value; },
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(needsAuth, false);
  assert.match(error, /Jump host authentication failed for "Bastion"/);
});

test("startSSH does not open auth retry for socket errors mentioning auth in hostnames", async () => {
  let error = "";
  let needsAuth = false;
  let retryMessage: string | null = "previous retry";
  let status = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      const err = new Error("Connection reset by auth-bastion.example.com");
      throw err;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Auth Bastion",
      hostname: "auth-bastion.example.com",
      username: "jump",
      password: "secret",
    }],
    setError: (message: string) => { error = message; },
    setNeedsAuth: (value: boolean) => { needsAuth = value; },
    setAuthRetryMessage: (message: string | null) => { retryMessage = message; },
    setStatus: (next: string) => { status = next; },
    updateStatus: (next: string) => { status = next; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(needsAuth, false);
  assert.equal(retryMessage, null);
  assert.equal(status, "disconnected");
  assert.equal(error, "Connection reset by auth-bastion.example.com");
});

test("startSSH does not open auth retry for non-login permission denied errors", async () => {
  let needsAuth = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      throw new Error("Permission denied opening channel to auth-bastion.example.com");
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
    terminalBackend,
    setNeedsAuth: (value: boolean) => { needsAuth = value; },
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(needsAuth, false);
  assert.equal(error, "Permission denied opening channel to auth-bastion.example.com");
});

test("startSSH rejects missing saved proxy profiles before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyProfileId: "missing-proxy",
    },
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Saved proxy for host "Target" is missing/);
});

test("startSSH rejects missing saved proxy profiles on jump hosts before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jump",
      proxyProfileId: "missing-proxy",
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Saved proxy for jump host "Jump" is missing/);
});

test("startSSH rejects missing proxy identities before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "missing-identity",
      },
    },
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy identity/);
  assert.match(error, /Target/);
});

test("startSSH rejects incomplete proxy identities before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      created: 1,
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy identity/);
  assert.match(error, /incomplete/);
});

test("startSSH rejects proxy identities with blank usernames even when passwords are encrypted", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: " ",
      authMethod: "password",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      created: 1,
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy identity/);
  assert.match(error, /incomplete/);
});

test("startSSH rejects target proxy identity passwords that cannot be decrypted", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      created: 1,
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy credentials cannot be decrypted/);
});

test("startSSH rejects missing jump host proxy identities before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jump",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "missing-identity",
      },
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy identity/);
  assert.match(error, /Jump/);
});

test("startSSH rejects incomplete jump host proxy identities before connecting", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      created: 1,
    }],
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jump",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /Proxy identity/);
  assert.match(error, /incomplete/);
  assert.match(error, /Jump/);
});

test("startSSH rejects jump host proxy identity passwords that cannot be decrypted", async () => {
  let started = false;
  let error = "";
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      started = true;
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
    terminalBackend,
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      hostChain: { hostIds: ["jump-1"] },
    },
    identities: [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
      created: 1,
    }],
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jump",
      proxyConfig: {
        type: "http",
        host: "proxy.example.test",
        port: 3128,
        identityId: "identity-1",
      },
    }],
    setError: (message: string) => { error = message; },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(started, false);
  assert.match(error, /cannot be decrypted/);
  assert.match(error, /Jump/);
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

test("startSSH resets the TCP dial timeout state before password fallback", async () => {
  let chainProgressListener: (
    sessionId: string,
    hop: number,
    total: number,
    label: string,
    status: string,
    error?: string,
  ) => void = noop;
  let startCalls = 0;
  const startOptions: Record<string, unknown>[] = [];
  const tcpDialState: boolean[] = [];
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async (options: Record<string, unknown>) => {
      startCalls += 1;
      startOptions.push(options);
      if (startCalls === 1) {
        chainProgressListener("session-1", 1, 1, "target.example.test", "tcp-connected");
        throw new Error("Authentication failed");
      }
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: (listener: typeof chainProgressListener) => {
      chainProgressListener = listener;
      return noop;
    },
    writeToSession: noop,
    resizeSession: noop,
  };
  const ctx = createStarterContext({
    host: {
      id: "host-1",
      label: "Target",
      hostname: "target.example.test",
      username: "alice",
      port: 22,
      authMethod: "key",
      identityFileId: "key-1",
      password: "login-secret",
      useSshAgent: true,
    },
    keys: [{
      id: "key-1",
      name: "Key",
      privateKey: "plain-private-key",
      publicKey: "",
      source: "embedded",
    }],
    terminalBackend,
    setIsConnectionPastTcpDial: (value: boolean) => {
      tcpDialState.push(value);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.equal(startCalls, 2);
  assert.equal(startOptions[0]?.useSshAgent, false);
  assert.equal(startOptions[1]?.useSshAgent, false);
  assert.deepEqual(tcpDialState, [false, false, true, false]);
});

test("startSSH resets the TCP dial timeout state when a jump host starts forwarding", async () => {
  let chainProgressListener: (
    sessionId: string,
    hop: number,
    total: number,
    label: string,
    status: string,
    error?: string,
  ) => void = noop;
  const tcpDialState: boolean[] = [];
  const terminalBackend = {
    backendAvailable: () => true,
    telnetAvailable: () => true,
    moshAvailable: () => true,
    localAvailable: () => true,
    serialAvailable: () => true,
    execAvailable: () => true,
    startSSHSession: async () => {
      chainProgressListener("session-1", 1, 2, "bastion.example.test", "tcp-connected");
      chainProgressListener("session-1", 1, 2, "bastion.example.test", "forwarding");
      chainProgressListener("session-1", 2, 2, "target.example.test", "tcp-connected");
      return "ssh-session";
    },
    startTelnetSession: async () => "telnet-session",
    startMoshSession: async () => "mosh-session",
    startLocalSession: async () => "local-session",
    startSerialSession: async () => "serial-session",
    execCommand: async () => ({}),
    onSessionData: () => noop,
    onSessionExit: () => noop,
    onChainProgress: (listener: typeof chainProgressListener) => {
      chainProgressListener = listener;
      return noop;
    },
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
      hostChain: { hostIds: ["jump-1"] },
    },
    resolvedChainHosts: [{
      id: "jump-1",
      label: "Bastion",
      hostname: "bastion.example.test",
      username: "alice",
      password: "jump-secret",
    }],
    terminalBackend,
    setIsConnectionPastTcpDial: (value: boolean) => {
      tcpDialState.push(value);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);

  assert.deepEqual(tcpDialState, [false, false, true, false, true]);
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
    terminalSettings: {
      verifyHostKeys: false,
    },
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

test("local session sends multi-line startup snippets in one write by default", async () => {
  const attached: string[] = [];
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
    startupCommand: 'sudo apt install gconf2-common -y\necho "123456"',
    promptLineBreakStateRef: undefined,
    onSessionAttached: (id: string) => attached.push(id),
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(attached, ["local-session"]);
  assert.deepEqual(sessionWrites, [{
    id: "local-session",
    data: 'sudo apt install gconf2-common -y\necho "123456"\r',
    automated: true,
  }]);
});

test("local session wraps multi-line startup paste when bracketed paste is active", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
    startupCommand: "sudo apt install gconf2-common -y\necho done",
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub({
    modes: { bracketedPasteMode: true },
  }) as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, [{
    id: "local-session",
    data: "\x1b[200~sudo apt install gconf2-common -y\necho done\x1b[201~\r",
    automated: true,
  }]);
});

test("local session respects disabled bracketed paste for startup paste", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
    startupCommand: "first\nsecond",
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub({
    modes: { bracketedPasteMode: true },
    options: { ignoreBracketedPasteMode: true },
  }) as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, [{
    id: "local-session",
    data: "first\nsecond\r",
    automated: true,
  }]);
});

test("local session can send multi-line startup snippets line by line", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
    startupCommand: "first cmd\nsecond cmd",
    multiLineRunMode: "lineDelay",
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sessionWrites, [{ id: "local-session", data: "first cmd\r", automated: true }]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sessionWrites, [
    { id: "local-session", data: "first cmd\r", automated: true },
    { id: "local-session", data: "second cmd\r", automated: true },
  ]);
});

test("local session sends host startup commands in one write by default", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
      startupCommand: "enter prompt\nrun command",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: undefined,
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sessionWrites, [{
    id: "local-session",
    data: "enter prompt\nrun command\r",
    automated: true,
  }]);
});

test("local session can send host startup commands line by line", async () => {
  const sessionWrites: Array<{ id: string; data: string; automated?: boolean }> = [];
  const terminalBackend = {
    localAvailable: () => true,
    startLocalSession: async () => "local-session",
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
      startupCommand: "first host cmd\nsecond host cmd",
      startupCommandRunMode: "lineDelay",
    },
    terminalSettings: { startupCommandDelayMs: 0 },
    terminalBackend,
    startupCommand: undefined,
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sessionWrites, [{ id: "local-session", data: "first host cmd\r", automated: true }]);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, [
    { id: "local-session", data: "first host cmd\r", automated: true },
    { id: "local-session", data: "second host cmd\r", automated: true },
  ]);
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

test("restored local reconnect runs the host startup command while automatic retry suppresses it", async () => {
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
    suppressHostStartupCommandRef: {
      current: shouldSuppressHostStartupCommandOnReconnect("restored"),
    },
    promptLineBreakStateRef: undefined,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, [
    { id: "local-session", data: "echo host-startup\r", automated: true },
  ]);

  sessionWrites.length = 0;
  const automaticReconnectCtx = createStarterContext({
    ...ctx,
    sessionRef: { current: null },
    hasRunStartupCommandRef: { current: false },
    suppressHostStartupCommandRef: {
      current: shouldSuppressHostStartupCommandOnReconnect("automatic"),
    },
  });

  await createTerminalSessionStarters(automaticReconnectCtx as never).startLocal(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sessionWrites, []);
});

test("local session start uses per-session directory before global default", async () => {
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
    startMoshSession: async () => "mosh-session",
    startLocalSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "local-session";
    },
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
      id: "local-host",
      label: "Local",
      hostname: "local",
      username: "",
      protocol: "local",
      localStartDir: "/Users/alice/project",
    },
    terminalSettings: { localStartDir: "/Users/alice/default" },
    terminalBackend,
  });

  await createTerminalSessionStarters(ctx as never).startLocal(createTermStub() as never);

  assert.equal(capturedOptions?.cwd, "/Users/alice/project");
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
  const restoredCwds: string[] = [];

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
    onRestoreCwdIntentConsumed: (cwd: string) => {
      restoredCwds.push(cwd);
    },
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSSH(createTermStub() as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(restoreCwdIntentRef.current, null);
  assert.deepEqual(restoredCwds, ["/srv/app dir"]);
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

test("startSSH forwards per-host SSH settings to the native bridge", async () => {
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
      requiresMfa: true,
      sshTcpConnectTimeoutSeconds: 45,
      sshAuthReadyTimeoutSeconds: 300,
    },
    keys: [],
    knownHosts: [],
    resolvedChainHosts: [],
    sessionId: "session-1",
    terminalBackend,
    sshDebugLogEnabled: true,
    terminalSettings: {
      keepaliveInterval: 30,
      keepaliveCountMax: 10,
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
  assert.equal(capturedOptions?.requiresMfa, true);
  assert.equal(capturedOptions?.sshTcpConnectTimeoutMs, 45_000);
  assert.equal(capturedOptions?.sshAuthReadyTimeoutMs, 300_000);
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
      useSshAgent: true,
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
    terminalSettings: {
      verifyHostKeys: false,
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

  await createTerminalSessionStarters(ctx as never).startSSH(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.knownHosts, knownHosts);
  assert.equal(capturedOptions.verifyHostKeys, false);
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
      useSshAgent: true,
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
