import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_AUTO_RECONNECT_DELAY_MS,
  getTerminalAutoReconnectDelayMs,
  canAttemptTerminalAutoReconnect,
  isTerminalAutoReconnectEnabled,
  shouldAutoReconnectAfterExit,
  shouldContinueAutoReconnectAfterFailure,
} from "./terminalAutoReconnect";

const sshHost = {
  protocol: "ssh" as const,
  hostname: "example.com",
};

test("terminal auto reconnect uses a five second retry delay", () => {
  assert.equal(TERMINAL_AUTO_RECONNECT_DELAY_MS, 5000);
});

test("configured reconnect intervals apply to the timer in milliseconds", () => {
  assert.equal(getTerminalAutoReconnectDelayMs(undefined), 5000);
  assert.equal(getTerminalAutoReconnectDelayMs({}), 5000);
  for (const seconds of [5, 30, 300, 3600]) {
    assert.equal(getTerminalAutoReconnectDelayMs({ sshAutoReconnectInterval: seconds }), seconds * 1000);
  }
  assert.equal(getTerminalAutoReconnectDelayMs({ sshAutoReconnectInterval: 0 }), 5000);
  assert.equal(getTerminalAutoReconnectDelayMs({ sshAutoReconnectInterval: Infinity }), 5000);
  assert.equal(getTerminalAutoReconnectDelayMs({ sshAutoReconnectInterval: 7200 }), 3600000);
});

test("terminal auto reconnect is disabled unless the setting is explicitly true", () => {
  assert.equal(isTerminalAutoReconnectEnabled(undefined), false);
  assert.equal(isTerminalAutoReconnectEnabled({ sshAutoReconnectEnabled: true }), true);
  assert.equal(isTerminalAutoReconnectEnabled({ sshAutoReconnectEnabled: false }), false);
});

test("unexpected SSH exits reconnect only after the tab has connected before", () => {
  assert.equal(
    shouldAutoReconnectAfterExit({
      evt: { reason: "closed" },
      host: sshHost,
      terminalSettings: { sshAutoReconnectEnabled: true },
      hasEverConnected: true,
    }),
    true,
  );

  assert.equal(
    shouldAutoReconnectAfterExit({
      evt: { reason: "closed" },
      host: sshHost,
      terminalSettings: { sshAutoReconnectEnabled: true },
      hasEverConnected: false,
    }),
    false,
  );
});

test("normal shell exits do not auto reconnect", () => {
  assert.equal(
    shouldAutoReconnectAfterExit({
      evt: { reason: "exited", exitCode: 0 },
      host: sshHost,
      terminalSettings: { sshAutoReconnectEnabled: true },
      hasEverConnected: true,
    }),
    false,
  );
});

test("administrative idle, timeout, and exit-signal disconnects do not auto reconnect", () => {
  for (const evt of [
    { reason: "timeout" as const },
    { reason: "timeout" as const, exitCode: 0 },
    { reason: "timeout" as const, error: "Connection timeout to example.com" },
    { reason: "signaled" as const, exitSignal: "SIGHUP" },
    { reason: "signaled" as const, exitSignal: "SIGTERM" },
    { reason: "signaled" as const },
    // A path that still says "closed" but plumbed the exit-signal is the same kick.
    { reason: "closed" as const, exitSignal: "SIGUSR2" },
    { reason: "closed" as const, exitSignal: "  SIGHUP  " },
  ]) {
    assert.equal(
      shouldAutoReconnectAfterExit({
        evt,
        host: sshHost,
        terminalSettings: { sshAutoReconnectEnabled: true },
        hasEverConnected: true,
      }),
      false,
    );
  }
});

test("transport drops still auto reconnect", () => {
  for (const evt of [
    { reason: "closed" as const },
    { reason: "error" as const, error: "connection reset" },
    { reason: "closed" as const, remoteClosedWithoutExitStatus: true },
    { reason: "closed" as const, exitSignal: "" },
    { reason: "closed" as const, exitSignal: "   " },
    { reason: "error" as const, error: "read ECONNRESET", exitSignal: "" },
    { reason: "error" as const, error: "read ECONNRESET", exitSignal: "SIGHUP" },
  ]) {
    assert.equal(
      shouldAutoReconnectAfterExit({
        evt,
        host: sshHost,
        terminalSettings: { sshAutoReconnectEnabled: true },
        hasEverConnected: true,
      }),
      true,
    );
  }
});

test("auto reconnect ignores protocols that already have different lifecycle semantics", () => {
  const variants = [
    { protocol: "local" as const, hostname: "localhost" },
    { protocol: "serial" as const, hostname: "/dev/tty.usbserial" },
    { protocol: "telnet" as const, hostname: "router.local" },
    { protocol: "ssh" as const, hostname: "example.com", moshEnabled: true },
    { protocol: "ssh" as const, hostname: "example.com", etEnabled: true },
  ];

  for (const host of variants) {
    assert.equal(
      shouldAutoReconnectAfterExit({
        evt: { reason: "error", error: "connection reset" },
        host,
        terminalSettings: { sshAutoReconnectEnabled: true },
        hasEverConnected: true,
      }),
      false,
    );
  }
});

test("an active auto reconnect loop continues after failed retry attempts", () => {
  assert.equal(
    shouldContinueAutoReconnectAfterFailure({
      host: sshHost,
      terminalSettings: { sshAutoReconnectEnabled: true },
      loopActive: true,
    }),
    true,
  );

  assert.equal(
    shouldContinueAutoReconnectAfterFailure({
      host: sshHost,
      terminalSettings: { sshAutoReconnectEnabled: false },
      loopActive: true,
    }),
    false,
  );
});

test("terminal auto reconnect can start from live or fully hibernated runtimes", () => {
  assert.equal(
    canAttemptTerminalAutoReconnect({
      hasTerminalRuntime: true,
      isHibernated: false,
    }),
    true,
  );

  assert.equal(
    canAttemptTerminalAutoReconnect({
      hasTerminalRuntime: false,
      isHibernated: true,
    }),
    true,
  );

  assert.equal(
    canAttemptTerminalAutoReconnect({
      hasTerminalRuntime: false,
      isHibernated: false,
    }),
    false,
  );
});
