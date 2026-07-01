import test from "node:test";
import assert from "node:assert/strict";

import {
  SSH_AUTH_READY_TIMEOUT_MS,
  SSH_TCP_CONNECT_TIMEOUT_MS,
  getConnectionTimeoutMs,
  hasConnectionPassedTcpDial,
  shouldRunConnectionTimeout,
} from "./connectionTimeouts";

test("SSH connection timeout constants separate TCP dial from auth wait", () => {
  assert.equal(SSH_TCP_CONNECT_TIMEOUT_MS, 20_000);
  assert.equal(SSH_AUTH_READY_TIMEOUT_MS, 120_000);
});

const baseTimeoutState = {
  status: "connecting",
  needsAuth: false,
  isLocalConnection: false,
  isSerialConnection: false,
  hasSshTcpConnectProgress: true,
  needsHostKeyVerification: false,
  isConnectionAwaitingUserInput: false,
  isConnectionPastTcpDial: false,
};

test("connection timeout runs for an ordinary remote connect attempt", () => {
  assert.equal(shouldRunConnectionTimeout(baseTimeoutState), true);
});

test("connection timeout pauses while SSH waits for user confirmation", () => {
  assert.equal(shouldRunConnectionTimeout({
    ...baseTimeoutState,
    needsHostKeyVerification: true,
  }), false);
  assert.equal(shouldRunConnectionTimeout({
    ...baseTimeoutState,
    isConnectionAwaitingUserInput: true,
  }), false);
});

test("connection timeout switches from TCP dial to auth readiness after TCP connects", () => {
  assert.equal(getConnectionTimeoutMs(baseTimeoutState), SSH_TCP_CONNECT_TIMEOUT_MS);
  assert.equal(getConnectionTimeoutMs({
    ...baseTimeoutState,
    isConnectionPastTcpDial: true,
  }), SSH_AUTH_READY_TIMEOUT_MS);
});

test("connection timeout keeps the auth-ready window for protocols without SSH TCP progress", () => {
  assert.equal(getConnectionTimeoutMs({
    ...baseTimeoutState,
    hasSshTcpConnectProgress: false,
  }), SSH_AUTH_READY_TIMEOUT_MS);
});

test("TCP dial is only considered passed after an actual transport connection", () => {
  assert.equal(hasConnectionPassedTcpDial("connecting"), false);
  assert.equal(hasConnectionPassedTcpDial("auth-attempt"), false);
  assert.equal(hasConnectionPassedTcpDial("error"), false);
  assert.equal(hasConnectionPassedTcpDial("forwarding"), false);
  assert.equal(hasConnectionPassedTcpDial("tcp-connected"), true);
  assert.equal(hasConnectionPassedTcpDial("authenticating"), true);
  assert.equal(hasConnectionPassedTcpDial("connected"), true);
});
