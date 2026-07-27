import test from "node:test";
import assert from "node:assert/strict";

import type { Host } from "../domain/models";
import {
  AUTO_RUN_SNIPPET_LINE_DELAY_MS,
  shouldHideConnectingDialogForConnectionReuse,
  shouldDelayAutoRunSnippetInput,
  shouldReconnectDisconnectedDialogOnEnterKey,
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

test("disconnected dialog reconnects on plain Enter when no control owns focus", () => {
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: false,
    }),
    false,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "a",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    shouldReconnectDisconnectedDialogOnEnterKey({
      key: "Enter",
      enabled: true,
      shiftKey: true,
    }),
    false,
  );
});

test("disconnected dialog leaves Enter to focused buttons and inputs", () => {
  class FakeElement {
    constructor(private readonly selectorMatch: boolean) {}
    closest(selector: string) {
      void selector;
      return this.selectorMatch ? this : null;
    }
  }
  const previousHTMLElement = globalThis.HTMLElement;
  // @ts-expect-error test double for DOM instanceof checks
  globalThis.HTMLElement = FakeElement;
  try {
    const buttonLike = new FakeElement(true);
    const plain = new FakeElement(false);
    assert.equal(
      shouldReconnectDisconnectedDialogOnEnterKey({
        key: "Enter",
        enabled: true,
        target: buttonLike as unknown as EventTarget,
      }),
      false,
    );
    assert.equal(
      shouldReconnectDisconnectedDialogOnEnterKey({
        key: "Enter",
        enabled: true,
        target: plain as unknown as EventTarget,
      }),
      true,
    );
  } finally {
    globalThis.HTMLElement = previousHTMLElement;
  }
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

test("auto-run snippets only delay multi-line input in line-by-line mode", () => {
  assert.equal(AUTO_RUN_SNIPPET_LINE_DELAY_MS > 0, true);
  assert.equal(shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", { noAutoRun: false }), false);
  assert.equal(
    shouldDelayAutoRunSnippetInput("sudo apt install gconf2-common -y\necho \"123456\"", {
      noAutoRun: false,
    }),
    false,
  );
  assert.equal(
    shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", {
      noAutoRun: false,
      multiLineRunMode: "lineDelay",
    }),
    true,
  );
  assert.equal(shouldDelayAutoRunSnippetInput("tthdf 0 2323\nadmin\ntest123", { noAutoRun: true }), false);
  assert.equal(shouldDelayAutoRunSnippetInput("show version", { noAutoRun: false }), false);
  assert.equal(shouldDelayAutoRunSnippetInput("show version\r", { noAutoRun: false }), false);
});
