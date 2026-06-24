import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { Host } from "../../types.ts";
import { TerminalToolbar } from "./TerminalToolbar.tsx";

const sshHost: Host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  protocol: "ssh",
};

const serialHost: Host = {
  ...sshHost,
  id: "serial-1",
  label: "Serial",
  hostname: "/dev/tty.usbserial",
  protocol: "serial",
};

const renderToolbar = (
  host: Host,
  status: "connecting" | "connected" | "disconnected" = "connected",
  props: Partial<React.ComponentProps<typeof TerminalToolbar>> = {},
) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(TerminalToolbar, {
        status,
        host,
        onOpenSFTP: () => {},
        onOpenScripts: () => {},
        onOpenTheme: () => {},
        ...props,
      }),
    ),
  );

test("keeps SFTP visible before the terminal overflow menu for SSH sessions", () => {
  const markup = renderToolbar(sshHost);

  const sftpIndex = markup.indexOf('aria-label="Open SFTP"');
  const moreIndex = markup.indexOf('aria-label="More actions"');

  assert.notEqual(sftpIndex, -1);
  assert.notEqual(moreIndex, -1);
  assert.ok(sftpIndex < moreIndex);
});

test("keeps Scripts visible before the terminal overflow menu", () => {
  const markup = renderToolbar(sshHost);

  const scriptsIndex = markup.indexOf('aria-label="Scripts"');
  const moreIndex = markup.indexOf('aria-label="More actions"');

  assert.notEqual(scriptsIndex, -1);
  assert.notEqual(moreIndex, -1);
  assert.ok(scriptsIndex < moreIndex);
  assert.equal(markup.match(/Scripts/g)?.length, 1);
  assert.match(markup, /type="button"[^>]*aria-label="Scripts"/);
});

test("hides SFTP for local terminal sessions", () => {
  const markup = renderToolbar({
    ...sshHost,
    id: "local-1",
    protocol: "local",
  });

  assert.equal(markup.includes('aria-label="Open SFTP"'), false);
});

test("shows YMODEM send only for connected serial sessions", () => {
  const connectedSerial = renderToolbar(serialHost, "connected", {
    onSendYmodem: () => {},
    onReceiveYmodem: () => {},
  });
  const disconnectedSerial = renderToolbar(serialHost, "disconnected", {
    onSendYmodem: () => {},
    onReceiveYmodem: () => {},
  });
  const ssh = renderToolbar(sshHost, "connected", {
    onSendYmodem: () => {},
    onReceiveYmodem: () => {},
  });
  const local = renderToolbar({
    ...sshHost,
    id: "local-1",
    protocol: "local",
  }, "connected", {
    onSendYmodem: () => {},
    onReceiveYmodem: () => {},
  });

  assert.equal(connectedSerial.includes('aria-label="Send with YMODEM"'), true);
  assert.equal(connectedSerial.includes('aria-label="Receive with YMODEM"'), true);
  assert.doesNotMatch(connectedSerial, /aria-label="Send with YMODEM"[^>]*disabled/);
  assert.equal(disconnectedSerial.includes('aria-label="Send with YMODEM - Available after connect"'), true);
  assert.equal(disconnectedSerial.includes('aria-label="Receive with YMODEM - Available after connect"'), true);
  assert.match(disconnectedSerial, /aria-label="Send with YMODEM - Available after connect"[^>]*disabled/);
  assert.match(disconnectedSerial, /aria-label="Receive with YMODEM - Available after connect"[^>]*disabled/);
  assert.equal(ssh.includes('aria-label="Send with YMODEM"'), false);
  assert.equal(ssh.includes('aria-label="Receive with YMODEM"'), false);
  assert.equal(local.includes('aria-label="Send with YMODEM"'), false);
  assert.equal(local.includes('aria-label="Receive with YMODEM"'), false);
});

test("uses the terminal active button color for pressed toolbar actions", () => {
  const markup = renderToolbar(sshHost, "connected", {
    isSearchOpen: true,
    onToggleSearch: () => {},
  });

  assert.match(
    markup,
    /aria-label="Search terminal"[^>]*style="background-color:var\(--terminal-toolbar-btn-active\)"/,
  );
});
