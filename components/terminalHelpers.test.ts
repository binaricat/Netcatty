import test from "node:test";
import assert from "node:assert/strict";

import type { Host } from "../domain/models";
import {
  shouldHideConnectingDialogForConnectionReuse,
  shouldShowTerminalConnectionDialog,
} from "./terminal/terminalHelpers";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "alice",
  authMethod: "password",
  ...overrides,
});

test("connection dialog is hidden while a reused SSH channel is opening", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: true,
    }),
    false,
  );
});

test("connection dialog remains visible when reuse is not actually supported", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
      hideConnectingDialogForConnectionReuse: false,
    }),
    true,
  );
});

test("connection dialog still appears for fresh remote connections", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    true,
  );
});

test("connection dialog keeps existing local and disconnected behavior", () => {
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connecting",
      isLocalConnection: true,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "connected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTerminalConnectionDialog({
      status: "disconnected",
      isLocalConnection: false,
      isSerialConnection: false,
      isDisconnectedDialogDismissed: true,
    }),
    false,
  );
});

test("connection reuse hides connecting dialog only while reuse is still possible", () => {
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: false,
    }),
    true,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ x11Forwarding: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ moshEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host({ etEnabled: true }),
      connectionReuseFellBack: false,
    }),
    false,
  );
  assert.equal(
    shouldHideConnectingDialogForConnectionReuse({
      reuseConnectionFromSessionId: "source-session",
      host: host(),
      connectionReuseFellBack: true,
    }),
    false,
  );
});
