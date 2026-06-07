import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalSessionStarters } from "./createTerminalSessionStarters";

const noop = () => undefined;

const armSudoPrompt = (
  autofill: { armForCommand: (command: string) => void } | null,
): string => {
  autofill?.armForCommand("sudo whoami");
  return "[sudo] password for alice: ";
};

const makeBackend = (
  onStartEt: (options: Record<string, unknown>) => void = noop,
) => ({
  backendAvailable: () => true,
  telnetAvailable: () => true,
  moshAvailable: () => true,
  etAvailable: () => true,
  localAvailable: () => true,
  serialAvailable: () => true,
  execAvailable: () => true,
  startSSHSession: async () => "ssh-session",
  startTelnetSession: async () => "telnet-session",
  startMoshSession: async () => "mosh-session",
  startEtSession: async (options: Record<string, unknown>) => {
    onStartEt(options);
    return "et-session";
  },
  startLocalSession: async () => "local-session",
  startSerialSession: async () => "serial-session",
  execCommand: async () => ({}),
  onSessionData: () => noop,
  onSessionExit: () => noop,
  onChainProgress: () => noop,
  writeToSession: noop,
  resizeSession: noop,
});

const makeCtx = (
  host: Record<string, unknown>,
  resolvedChainHosts: Array<Record<string, unknown>>,
  terminalBackend: ReturnType<typeof makeBackend>,
  sinks: { setError?: (m: string) => void } = {},
) => ({
  host: {
    id: "host-1",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    etEnabled: true,
    ...host,
  },
  keys: [],
  resolvedChainHosts,
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
  setError: sinks.setError ?? noop,
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

test("startEt enables sudo autofill with the host saved password", async () => {
  let onData: ((data: string) => void) | null = null;
  const sent: string[] = [];
  const backend = {
    ...makeBackend(),
    onSessionData: (_id: string, cb: (data: string) => void) => {
      onData = cb;
      return noop;
    },
    writeToSession: (_id: string, data: string) => sent.push(data),
  };
  const sudoAutofillRef = { current: null };
  const ctx = {
    ...makeCtx({
      password: "saved-secret",
    }, [], backend),
    sudoAutofillRef,
    sudoAutofillPassword: "saved-secret",
    onSudoHint: () => true,
  };

  await createTerminalSessionStarters(ctx as never).startEt(term as never);
  onData?.(armSudoPrompt(sudoAutofillRef.current));
  sudoAutofillRef.current?.confirmFill();

  assert.deepEqual(sent, ["saved-secret\n"]);
});

test("startEt fails loudly when a configured jump host cannot be resolved", async () => {
  let started = false;
  let error = "";
  const backend = makeBackend(() => { started = true; });
  // hostChain references jump-1, but resolvedChainHosts is empty (missing).
  const ctx = makeCtx(
    { hostChain: { hostIds: ["jump-1"] } },
    [],
    backend,
    { setError: (m) => { error = m; } },
  );

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  // Must NOT silently fall back to a direct connection.
  assert.equal(started, false);
  assert.match(error, /jump host is missing/i);
  assert.match(error, /jump-1/);
});

test("startEt rejects a configured chain with more than one jump host even if under-resolved", async () => {
  let started = false;
  let error = "";
  const backend = makeBackend(() => { started = true; });
  // Two configured hops but only one resolved — a resolved-length check alone
  // would wrongly let this through.
  const ctx = makeCtx(
    { hostChain: { hostIds: ["jump-1", "jump-2"] } },
    [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jumper",
    }],
    backend,
    { setError: (m) => { error = m; } },
  );

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  assert.equal(started, false);
  assert.match(error, /at most one jump host/i);
});

test("startEt connects with a single resolved jump host", async () => {
  let captured: Record<string, unknown> | null = null;
  let error = "";
  const backend = makeBackend((options) => { captured = options; });
  const ctx = makeCtx(
    { hostChain: { hostIds: ["jump-1"] } },
    [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jumper",
      // key auth with no saved key reference → local identity file fallback
      authMethod: "key",
      identityFilePaths: ["/Users/alice/.ssh/jump_ed25519"],
    }],
    backend,
    { setError: (m) => { error = m; } },
  );

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  assert.equal(error, "");
  assert.ok(captured);
  const jumpHosts = captured.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts.length, 1);
  assert.equal(jumpHosts[0]?.hostname, "jump.example.test");
  // Local identity file fallback is forwarded for the hop.
  assert.deepEqual(jumpHosts[0]?.identityFilePaths, ["/Users/alice/.ssh/jump_ed25519"]);
});

test("startEt forwards a jump host's custom ET port", async () => {
  let captured: Record<string, unknown> | null = null;
  const backend = makeBackend((options) => { captured = options; });
  const ctx = makeCtx(
    { hostChain: { hostIds: ["jump-1"] } },
    [{
      id: "jump-1",
      label: "Jump",
      hostname: "jump.example.test",
      username: "jumper",
      etPort: 9022,
    }],
    backend,
  );

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  const jumpHosts = (captured as Record<string, unknown>).jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.etPort, 9022);
});

test("startEt forwards a jump host reference key path as an identity file", async () => {
  let captured: Record<string, unknown> | null = null;
  const backend = makeBackend((options) => { captured = options; });
  const ctx = {
    ...makeCtx(
      { hostChain: { hostIds: ["jump-1"] } },
      [{
        id: "jump-1",
        label: "Jump",
        hostname: "jump.example.test",
        username: "jumper",
        authMethod: "key",
        identityFileId: "ref-key",
      }],
      backend,
    ),
    keys: [{
      id: "ref-key",
      label: "Reference key",
      source: "reference",
      filePath: "/Users/alice/.ssh/jump_reference_ed25519",
      // reference keys carry no inline privateKey material
    }],
  };

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  const jumpHosts = (captured as Record<string, unknown>).jumpHosts as Array<Record<string, unknown>>;
  // privateKey must be omitted for a reference key, and the on-disk path
  // forwarded as an IdentityFile instead of being dropped.
  assert.equal(jumpHosts[0]?.privateKey, undefined);
  assert.deepEqual(jumpHosts[0]?.identityFilePaths, ["/Users/alice/.ssh/jump_reference_ed25519"]);
});

test("startEt connects directly when no jump host is configured", async () => {
  let captured: Record<string, unknown> | null = null;
  let error = "";
  const backend = makeBackend((options) => { captured = options; });
  const ctx = makeCtx({}, [], backend, { setError: (m) => { error = m; } });

  await createTerminalSessionStarters(ctx as never).startEt(term as never);

  assert.equal(error, "");
  assert.ok(captured);
  assert.equal(captured.jumpHosts, undefined);
});
