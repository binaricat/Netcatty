import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { ConnectionLog } from "../domain/models/history.ts";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes.ts";
import { TooltipProvider } from "./ui/tooltip.tsx";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", source: "export default {};", shortCircuit: true };
    }
    if (url.includes("/@xterm/xterm/")) {
      return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    }
    if (url.includes("/@xterm/addon-fit/")) {
      return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    }
    if (url.includes("/@xterm/addon-webgl/")) {
      return { format: "module", source: "export class WebglAddon {}", shortCircuit: true };
    }
    if (url.endsWith("/customThemeStore.ts")) {
      return {
        format: "module",
        source: "export const useCustomThemes = () => []; export const useCustomThemeActions = () => ({}); export const customThemeStore = {};",
        shortCircuit: true,
      };
    }
    if (url.endsWith("/appearanceChromeStore.ts")) {
      return {
        format: "module",
        source: "export const useAppearanceChromeStore = () => ({ accentMode: 'theme', customAccent: '' });",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: LogView } = await import("./LogView.tsx");

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>{node}</TooltipProvider>
    </I18nProvider>,
  );

const defaultTheme = TERMINAL_THEMES[0];

test("LogView renders remote desktop recording viewport with download/delete actions and hides terminal appearance button", () => {
  const log: ConnectionLog = {
    id: "log-1",
    hostId: "h-1",
    hostLabel: "Windows Prod",
    hostname: "10.0.0.10",
    username: "Administrator",
    protocol: "rdp",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_120_000,
    localUsername: "alice",
    localHostname: "macbook",
    saved: true,
    recordingId: "123e4567-e89b-12d3-a456-426614174000",
    recordingMimeType: "video/webm;codecs=vp9,opus",
    recordingDurationMs: 120_000,
    recordingBytes: 5_242_880,
    recordingHasAudio: true,
  };

  const markup = renderWithI18n(
    React.createElement(LogView, {
      log,
      defaultTerminalTheme: defaultTheme,
      defaultFontSize: 13,
      isVisible: true,
      onClose: () => {},
      onUpdateLog: () => {},
    }),
  );

  assert.match(markup, /data-log-view="remote-desktop-recording"/);
  assert.match(markup, /Windows Prod/);
  assert.match(markup, /02:00/);
  assert.match(markup, /5 MB/);
  assert.match(markup, /Download \.webm/);
  assert.match(markup, /Delete Recording/);
  assert.doesNotMatch(markup, /Appearance/);
});

test("LogView renders clean non-terminal metadata card for unrecorded VNC/RDP sessions", () => {
  const log: ConnectionLog = {
    id: "log-2",
    hostId: "h-2",
    hostLabel: "Ubuntu VNC",
    hostname: "192.168.1.50",
    username: "ubuntu",
    protocol: "vnc",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_095_000,
    localUsername: "alice",
    localHostname: "macbook",
    saved: false,
  };

  const markup = renderWithI18n(
    React.createElement(LogView, {
      log,
      defaultTerminalTheme: defaultTheme,
      defaultFontSize: 13,
      isVisible: true,
      onClose: () => {},
      onUpdateLog: () => {},
    }),
  );

  assert.match(markup, /data-log-view="remote-desktop-metadata"/);
  assert.match(markup, /Ubuntu VNC/);
  assert.match(markup, /192\.168\.1\.50/);
  assert.match(markup, /1m 35s/);
  assert.doesNotMatch(markup, /Appearance/);
});

test("LogView memo comparator checks recordingId and recordingBytes", () => {
  const source = readFileSync(new URL("./LogView.tsx", import.meta.url), "utf8");
  const comparator = source.match(/const logViewAreEqual[\s\S]*?^};/m)?.[0] ?? "";
  assert.ok(comparator, "expected logViewAreEqual in LogView.tsx");
  assert.match(comparator, /prev\.log\.recordingId === next\.log\.recordingId/);
  assert.match(comparator, /prev\.log\.recordingBytes === next\.log\.recordingBytes/);
});
