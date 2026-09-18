import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalSessionStarters } from "./createTerminalSessionStarters";

const noop = () => undefined;
const ENCRYPTED_CREDENTIAL_PLACEHOLDER = "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==";

const buildBackend = (overrides: Partial<Record<string, unknown>> = {}) => ({
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
  ...overrides,
});

const buildCtx = (backend: unknown, extra: Record<string, unknown> = {}) => ({
  host: {
    id: "serial-1",
    label: "Serial: ttyUSB0",
    hostname: "/dev/ttyUSB0",
    protocol: "serial",
    charset: "UTF-8",
  },
  keys: [],
  identities: [],
  sessionId: "session-1",
  serialConfig: {
    path: "/dev/ttyUSB0",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
  },
  terminalSettings: {},
  terminalBackend: backend,
  sessionRef: { current: null },
  hasConnectedRef: { current: false },
  hasRunStartupCommandRef: { current: false },
  disposeDataRef: { current: null },
  disposeExitRef: { current: null },
  fitAddonRef: { current: null },
  serializeAddonRef: { current: null },
  pendingAuthRef: { current: null },
  bootEpochRef: { current: 0 },
  updateStatus: noop,
  setStatus: noop,
  setError: noop,
  setNeedsAuth: noop,
  setAuthRetryMessage: noop,
  setAuthPassword: noop,
  setProgressLogs: noop,
  setProgressValue: noop,
  ...extra,
});

const term = {
  cols: 120,
  rows: 32,
  write: noop,
  writeln: noop,
  scrollToBottom: noop,
};

test("startSerial passes saved host credentials for auto-login", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const backend = buildBackend({
    startSerialSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "serial-session";
    },
  });

  await createTerminalSessionStarters(buildCtx(backend, {
    host: {
      id: "serial-1",
      label: "Serial: ttyUSB0",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      username: "admin",
      password: "secret",
    },
  }) as never).startSerial(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.username, "admin");
  assert.equal(capturedOptions.password, "secret");
});

test("startSerial omits credentials when none are saved", async () => {
  let capturedOptions: Record<string, unknown> | null = null;
  const backend = buildBackend({
    startSerialSession: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return "serial-session";
    },
  });

  await createTerminalSessionStarters(buildCtx(backend) as never).startSerial(term as never);

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.username, undefined);
  assert.equal("password" in capturedOptions, false);
});

test("startSerial rejects an undecryptable saved password instead of partial auto-login", async () => {
  let started = false;
  const errors: (string | null)[] = [];
  const backend = buildBackend({
    startSerialSession: async () => {
      started = true;
      return "serial-session";
    },
  });

  await createTerminalSessionStarters(buildCtx(backend, {
    host: {
      id: "serial-1",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      username: "admin",
      password: ENCRYPTED_CREDENTIAL_PLACEHOLDER,
    },
    setError: (message: string | null) => errors.push(message),
  }) as never).startSerial(term as never);

  // A saved username paired with an undecryptable password must not start a
  // partial auto-login; ask the user to re-enter the credential instead.
  assert.equal(started, false);
  assert.ok(errors[0]);
});

test("startSerial waits for auto-login before running the startup command", async () => {
  const writtenCommands: string[] = [];
  const executedCommands: string[] = [];
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;
  let resolveCommand: (() => void) | null = null;
  const commandWritten = new Promise<void>((resolve) => {
    resolveCommand = resolve;
  });

  const backend = buildBackend({
    startSerialSession: async () => "serial-session",
    onTelnetAutoLoginComplete: (
      _sessionId: string,
      cb: (evt: { sessionId: string }) => void,
    ) => {
      autoLoginComplete = cb;
      return noop;
    },
    onTelnetAutoLoginCancelled: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
      resolveCommand?.();
    },
  });

  const ctx = buildCtx(backend, {
    host: {
      id: "serial-1",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      username: "admin",
      password: "secret",
      startupCommand: "show version",
    },
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSerial(term as never);
  assert.ok(autoLoginComplete);

  // The startup command must not fire on the default 600ms delay while the
  // main-process auto-login is still answering prompts.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(writtenCommands, []);
  assert.deepEqual(executedCommands, []);

  autoLoginComplete?.({ sessionId: "session-1" });

  await Promise.race([
    commandWritten,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for startup command")), 1000),
    ),
  ]);
  assert.deepEqual(writtenCommands, ["show version\r"]);
  assert.deepEqual(executedCommands, ["show version"]);
});

test("startSerial schedules the startup command when auto-login completes before attach", async () => {
  const writtenCommands: string[] = [];
  const executedCommands: string[] = [];
  let autoLoginComplete: ((evt: { sessionId: string }) => void) | null = null;

  const backend = buildBackend({
    startSerialSession: async () => {
      // The login exchange completes before the startSerialSession promise
      // resolves, so the completion event fires while the session is still
      // unattached. The startup command must be scheduled after attach, not
      // dropped against the unset session ref.
      autoLoginComplete?.({ sessionId: "session-1" });
      return "serial-session";
    },
    onTelnetAutoLoginComplete: (
      _sessionId: string,
      cb: (evt: { sessionId: string }) => void,
    ) => {
      autoLoginComplete = cb;
      return noop;
    },
    onTelnetAutoLoginCancelled: () => noop,
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
  });

  const ctx = buildCtx(backend, {
    host: {
      id: "serial-1",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      username: "admin",
      password: "secret",
      startupCommand: "show version",
    },
    onCommandExecuted: (command: string) => {
      executedCommands.push(command);
    },
  });

  await createTerminalSessionStarters(ctx as never).startSerial(term as never);

  await Promise.race([
    new Promise<void>((resolve) => {
      const tick = () => {
        if (writtenCommands.length > 0) {
          resolve();
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for startup command")), 2000),
    ),
  ]);
  assert.deepEqual(writtenCommands, ["show version\r"]);
  assert.deepEqual(executedCommands, ["show version"]);
});

test("startSerial runs the startup command without waiting when no credentials are saved", async () => {
  const writtenCommands: string[] = [];
  const backend = buildBackend({
    startSerialSession: async () => "serial-session",
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
  });

  const ctx = buildCtx(backend, {
    host: {
      id: "serial-1",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      startupCommand: "show version",
    },
  });

  await createTerminalSessionStarters(ctx as never).startSerial(term as never);

  await Promise.race([
    new Promise<void>((resolve) => {
      const tick = () => {
        if (writtenCommands.length > 0) {
          resolve();
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for startup command")), 2000),
    ),
  ]);
  assert.deepEqual(writtenCommands, ["show version\r"]);
});

test("startSerial does not arm the fallback when auto-login is cancelled before attach", async () => {
  const writtenCommands: string[] = [];
  let autoLoginCancelled: ((evt: { sessionId: string }) => void) | null = null;

  const backend = buildBackend({
    startSerialSession: async () => {
      // A stalled exchange (e.g. only a username is saved and the device moves
      // on to a Password prompt the detector cannot answer) cancels auto-login
      // before the startSerialSession promise resolves.
      autoLoginCancelled?.({ sessionId: "session-1" });
      return "serial-session";
    },
    onTelnetAutoLoginComplete: () => noop,
    onTelnetAutoLoginCancelled: (
      _sessionId: string,
      cb: (evt: { sessionId: string }) => void,
    ) => {
      autoLoginCancelled = cb;
      return noop;
    },
    writeToSession: (_sessionId: string, data: string) => {
      writtenCommands.push(data);
    },
  });

  const ctx = buildCtx(backend, {
    host: {
      id: "serial-1",
      hostname: "/dev/ttyUSB0",
      protocol: "serial",
      username: "admin",
      startupCommand: "show version",
    },
  });

  await createTerminalSessionStarters(ctx as never).startSerial(term as never);
  assert.ok(autoLoginCancelled);

  // The 65s quiet-device fallback must not be armed after the cancellation,
  // or it would type the startup command into the pending password prompt.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(writtenCommands, []);
});

for (const runMode of ['paste', 'lineDelay', 'noAutoRun']) {
  test(`serial reconnect discards the previous delayed startup command (${runMode})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const writes: string[] = [];
    const completions: Array<(evt: {sessionId: string; bootEpoch: number}) => void> = [];
    const backend = buildBackend({
      startSerialSession: async () => 'session-1',
      onTelnetAutoLoginComplete: (_id: string, cb: typeof completions[number]) => {
        completions.push(cb);
        return noop;
      },
      onTelnetAutoLoginCancelled: () => noop,
      writeToSession: (_id: string, data: string) => writes.push(data),
    });
    const ctx = buildCtx(backend, {
      host: { id: 'serial-1', protocol: 'serial', username: 'admin', startupCommand: 'show version', startupCommandRunMode: runMode === 'lineDelay' ? 'lineDelay' : 'paste' },
      terminalSettings: { startupCommandDelayMs: 100 },
      noAutoRun: runMode === 'noAutoRun',
    });
    const starters = createTerminalSessionStarters(ctx as never);
    await starters.startSerial(term as never);
    completions[0]({sessionId: 'session-1', bootEpoch: 0});
    ctx.bootEpochRef.current = 1;
    ctx.hasRunStartupCommandRef.current = false;
    await starters.startSerial(term as never);
    t.mock.timers.tick(100);
    assert.deepEqual(writes, []);
    completions[1]({sessionId: 'session-1', bootEpoch: 1});
    t.mock.timers.tick(100);
    assert.deepEqual(writes, [runMode === 'noAutoRun' ? 'show version' : 'show version\r']);
  });
}

test('serial quick connect does not synthesize auto-login credentials', async () => {
  const { createSerialTerminalSession } = await import('../../../application/state/sessionFactories');
  const { resolveTerminalSessionHost } = await import('../../../domain/terminalHostResolution');
  const session = createSerialTerminalSession('quick', {path: '/dev/ttyUSB0', baudRate: 115200});
  const host = resolveTerminalSessionHost({session, hosts: [], groupConfigs: [], proxyProfiles: [], localOs: 'macos'});
  let options: Record<string, unknown> = {};
  const backend = buildBackend({startSerialSession: async (value: Record<string, unknown>) => {options = value; return 'quick';}});
  await createTerminalSessionStarters(buildCtx(backend, {host}) as never).startSerial(term as never);
  assert.equal(options.username, undefined);
  assert.equal(options.password, undefined);
});
