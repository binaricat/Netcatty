import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { Host } from "../../types.ts";
import { TerminalConnectionDialog } from "./TerminalConnectionDialog.tsx";

const host: Host = {
  id: "host-1",
  label: "10.2.0.32",
  hostname: "10.2.0.32",
  port: 22,
  username: "root",
  tags: [],
  os: "linux",
  protocol: "ssh",
};

const renderDialog = (
  props: Partial<React.ComponentProps<typeof TerminalConnectionDialog>> = {},
) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    { locale: "en" },
    React.createElement(TerminalConnectionDialog, {
      host,
      status: "connecting",
      error: null,
      progressValue: 55,
      chainProgress: null,
      needsAuth: false,
      showLogs: false,
      _setShowLogs: () => {},
      keys: [],
      authProps: {
        authMethod: "password",
        setAuthMethod: () => {},
        authUsername: "root",
        setAuthUsername: () => {},
        authPassword: "",
        setAuthPassword: () => {},
        authKeyId: null,
        setAuthKeyId: () => {},
        authPassphrase: "",
        setAuthPassphrase: () => {},
        showAuthPassphrase: false,
        setShowAuthPassphrase: () => {},
        showAuthPassword: false,
        setShowAuthPassword: () => {},
        authRetryMessage: null,
        onSubmit: () => {},
        onCancel: () => {},
        isValid: true,
      },
      progressProps: {
        timeLeft: 20,
        isCancelling: false,
        progressLogs: ["Host key verification required for 10.2.0.32."],
        onCancelConnect: () => {},
        onCloseSession: () => {},
        onRetry: () => {},
      },
      ...props,
    }),
  ),
);

test("renders host key confirmation inside the connection dialog", () => {
  const markup = renderDialog({
    showLogs: true,
    hostKeyVerification: {
      hostKeyInfo: {
        hostname: "10.2.0.32",
        port: 22,
        keyType: "ssh-ed25519",
        fingerprint: "abc123",
        status: "unknown",
      },
      onClose: () => {},
      onContinue: () => {},
      onAddAndContinue: () => {},
    },
  });

  assert.match(markup, /Confirm this host key/);
  assert.match(markup, /abc123/);
  assert.match(markup, /Add and continue/);
  assert.match(markup, /Host key verification required for 10\.2\.0\.32\./);
  assert.equal(markup.includes("Timeout in"), false);
});

test("does not show a countdown while waiting for user input", () => {
  const markup = renderDialog({
    progressProps: {
      timeLeft: 20,
      isAwaitingUserInput: true,
      isCancelling: false,
      progressLogs: ["Waiting for passphrase."],
      onCancelConnect: () => {},
      onCloseSession: () => {},
      onRetry: () => {},
    },
  });

  assert.match(markup, /Waiting for user input/);
  assert.equal(markup.includes("Timeout in"), false);
});

test("shows enter reconnect hint when disconnected reconnect is available", () => {
  const markup = renderDialog({
    status: "disconnected",
    error: null,
    showEnterReconnectHint: true,
  });

  assert.match(markup, /Press Enter to reconnect/);
});

test("does not show enter reconnect hint until the caller marks enter reconnect available", () => {
  const markup = renderDialog({
    status: "disconnected",
    error: null,
  });

  assert.equal(markup.includes("Press Enter to reconnect"), false);
});

test("renders changed host key warning in the same connection dialog", () => {
  const markup = renderDialog({
    hostKeyVerification: {
      hostKeyInfo: {
        hostname: "10.2.0.32",
        port: 22,
        keyType: "ssh-ed25519",
        fingerprint: "new-fingerprint",
        knownFingerprint: "old-fingerprint",
        status: "changed",
      },
      onClose: () => {},
      onContinue: () => {},
      onAddAndContinue: () => {},
    },
  });

  assert.match(markup, /Host key changed/);
  assert.match(markup, /new-fingerprint/);
  assert.match(markup, /Saved fingerprint/);
  assert.match(markup, /old-fingerprint/);
  assert.match(markup, /Update and continue/);
});

test("keeps the second progress segment parked until the first segment finishes", () => {
  const markup = renderDialog({ progressValue: 75 });

  assert.match(markup, /style="width:100%"/);
  assert.match(markup, /style="width:0%"/);
});

test("fills both progress segments for disconnected states", () => {
  const markup = renderDialog({
    status: "disconnected",
    error: "Connection timed out.",
    progressValue: 5,
  });

  const fullSegments = markup.match(/style="width:100%"/g) ?? [];
  assert.equal(fullSegments.length >= 2, true);
});

test("keeps connection log padding inside the scrollable content", () => {
  const markup = renderDialog({
    status: "disconnected",
    error: "Connection timed out.",
    showLogs: true,
    progressProps: {
      timeLeft: 0,
      isCancelling: false,
      progressLogs: Array.from({ length: 12 }, (_, index) => `Log line ${index + 1}`),
      onCancelConnect: () => {},
      onCloseSession: () => {},
      onRetry: () => {},
    },
  });

  assert.match(markup, /class="[^"]*max-h-44/);
  assert.doesNotMatch(markup, /class="[^"]*max-h-44[^"]*p-2\.5/);
  assert.match(markup, /class="[^"]*p-2\.5[^"]*pb-4[^"]*pr-4/);
});

test("shows the ET server port (not the SSH port) for an ET host with a custom etPort", () => {
  const markup = renderDialog({
    host: { ...host, etEnabled: true, port: 22, etPort: 9022 },
  });

  // ET connectivity hinges on the etserver port, so the dialog must show it.
  assert.match(markup, /10\.2\.0\.32:9022/);
  assert.equal(markup.includes("10.2.0.32:22"), false);
});

test("defaults the displayed ET port to 2022 when no etPort is set", () => {
  const markup = renderDialog({
    host: { ...host, etEnabled: true, port: 22 },
  });

  assert.match(markup, /10\.2\.0\.32:2022/);
  assert.equal(markup.includes("10.2.0.32:22"), false);
});

test("shows restored session copy for disconnected restored placeholders", () => {
  const markup = renderDialog({
    status: "disconnected",
    error: null,
    restoreState: "restored-disconnected",
  } as Partial<React.ComponentProps<typeof TerminalConnectionDialog>>);

  assert.match(markup, /Restored session/);
  assert.match(markup, /This terminal is disconnected/);
  assert.match(markup, /Reconnect/);
});
