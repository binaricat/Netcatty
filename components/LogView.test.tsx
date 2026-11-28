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

test("LogView memo comparator checks recordingId, recordings, remoteDesktopEvents, and recordingBytes", () => {
  const source = readFileSync(new URL("./LogView.tsx", import.meta.url), "utf8");
  const comparator = source.match(/const logViewAreEqual[\s\S]*?^};/m)?.[0] ?? "";
  assert.ok(comparator, "expected logViewAreEqual in LogView.tsx");
  assert.match(comparator, /prev\.log\.recordingId === next\.log\.recordingId/);
  assert.match(comparator, /prev\.log\.recordingBytes === next\.log\.recordingBytes/);
  assert.match(comparator, /prev\.log\.recordings === next\.log\.recordings/);
  assert.match(comparator, /prev\.log\.remoteDesktopEvents === next\.log\.remoteDesktopEvents/);
});

test("LogView renders multi-clip strip and video-linked session timeline with seek chips", () => {
  const log: ConnectionLog = {
    id: "log-multi",
    sessionId: "sess-rdp-multi",
    hostId: "h-1",
    hostLabel: "Windows Multi",
    hostname: "10.0.0.11",
    username: "Administrator",
    protocol: "rdp",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_180_000,
    localUsername: "alice",
    localHostname: "macbook",
    saved: true,
    recordingId: "22222222-2222-4222-8222-222222222222",
    recordings: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: 1_700_000_010_000,
        endedAt: 1_700_000_040_000,
        durationMs: 30_000,
        bytes: 1_048_576,
        mimeType: "video/webm;codecs=vp9",
        hasAudio: false,
        width: 1920,
        height: 1080,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        startedAt: 1_700_000_060_000,
        endedAt: 1_700_000_120_000,
        durationMs: 60_000,
        bytes: 2_097_152,
        mimeType: "video/webm;codecs=vp9,opus",
        hasAudio: true,
        width: 1920,
        height: 1080,
      },
    ],
    remoteDesktopMeta: {
      resolution: { width: 1920, height: 1080 },
      securityLabel: "TLS / NLA",
      tunneled: true,
    },
    remoteDesktopEvents: [
      {
        id: "ev-1",
        timestamp: 1_700_000_075_000,
        kind: "clipboard_download",
        summary: "Downloaded report.pdf",
        detail: "1.2 MB",
      },
    ],
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

  assert.match(markup, /data-testid="log-view-clip-strip"/);
  assert.match(markup, /data-testid="log-view-timeline-drawer"/);
  assert.match(markup, /Downloaded report\.pdf/);
  assert.match(markup, /data-seek-seconds="15"/);
  assert.match(markup, /TLS \/ NLA/);
});
