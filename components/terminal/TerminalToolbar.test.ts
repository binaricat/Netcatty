import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { Host } from "../../types.ts";
import { TerminalToolbar } from "./TerminalToolbar.tsx";

const toolbarSource = readFileSync(new URL("./TerminalToolbar.tsx", import.meta.url), "utf8");

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

const pluginHost: Host = {
  ...sshHost,
  id: "plugin-1",
  label: "Plugin",
  hostname: "com.example.transport.connection",
  protocol: "plugin:com.example.transport.connection",
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
        sessionId: 'session-1',
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

test("shows manual session log button when requested", () => {
  const markup = renderToolbar(sshHost, "connected", {
    showLogButton: true,
    onToggleSessionLog: () => {},
  });

  const logIndex = markup.indexOf('aria-label="Start session log"');
  const scriptsIndex = markup.indexOf('aria-label="Scripts"');

  assert.notEqual(logIndex, -1);
  assert.notEqual(scriptsIndex, -1);
  assert.ok(logIndex < scriptsIndex);
});

test("marks manual session log button active while logging", () => {
  const markup = renderToolbar(sshHost, "connected", {
    showLogButton: true,
    onToggleSessionLog: () => {},
    isSessionLogging: true,
  });

  assert.match(
    markup,
    /aria-label="Stop session log"[^>]*aria-pressed="true"[^>]*style="background-color:var\(--terminal-toolbar-btn-active\)"/,
  );
});

test("hides SFTP for local terminal sessions", () => {
  const markup = renderToolbar({
    ...sshHost,
    id: "local-1",
    protocol: "local",
  });

  assert.equal(markup.includes('aria-label="Open SFTP"'), false);
});

test("hides SSH history for plugin terminal sessions", () => {
  const markup = renderToolbar(pluginHost, "connected", {
    onOpenHistory: () => {},
  });

  assert.equal(markup.includes('aria-label="Command history"'), false);
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

test("compact scripts popover hosts bulk-delete confirm outside the popover", () => {
  // Dialog focus leaves PopoverContent; if confirm stays inside ScriptsSidePanel,
  // the popover closes, isVisible clears pendingDeleteIds, and the prompt dies.
  assert.match(toolbarSource, /onBulkDeleteRequest=\{setPendingScriptDeleteIds\}/);
  assert.match(toolbarSource, /<VaultDeleteConfirmDialog/);
  // Popup vault mutation goes through the prop; the event only clears popover selection.
  assert.match(toolbarSource, /onDeleteSnippets\?\.\(new Set\(ids\)\)/);
  assert.match(toolbarSource, /netcatty:snippets:delete/);
  const scriptsPopoverIdx = toolbarSource.indexOf("open={scriptsPopoverOpen}");
  const popoverEndIdx = toolbarSource.indexOf("</Popover>", scriptsPopoverIdx);
  const dialogIdx = toolbarSource.indexOf("<VaultDeleteConfirmDialog", popoverEndIdx);
  assert.ok(scriptsPopoverIdx >= 0, "scripts popover open binding");
  assert.ok(popoverEndIdx > scriptsPopoverIdx, "scripts popover closes");
  assert.ok(dialogIdx > popoverEndIdx, "confirm dialog is a sibling after the popover");
  assert.equal(
    toolbarSource.includes("document.querySelector('[data-vault-delete-confirm=\"true\"]')"),
    false,
  );
});
