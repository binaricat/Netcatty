import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_AUTO_RECONNECT_DELAY_MS,
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
