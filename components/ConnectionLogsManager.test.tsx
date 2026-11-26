import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { ConnectionLog } from "../domain/models/history.ts";
import { TooltipProvider } from "./ui/tooltip.tsx";
import ConnectionLogsManager, {
  formatRecordingBytes,
  formatRecordingDuration,
} from "./ConnectionLogsManager.tsx";

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>{node}</TooltipProvider>
    </I18nProvider>,
  );

test("formatRecordingDuration and formatRecordingBytes format human-readable pills", () => {
  assert.equal(formatRecordingDuration(0), "00:00");
  assert.equal(formatRecordingDuration(134_000), "02:14");
  assert.equal(formatRecordingDuration(3_661_000), "1:01:01");

  assert.equal(formatRecordingBytes(0), "");
  assert.equal(formatRecordingBytes(512), "512 B");
  assert.equal(formatRecordingBytes(4_404_019), "4.2 MB");
});

test("ConnectionLogsManager renders RDP/VNC icons and compact recording pill when recordingId is present", () => {
  const logs: ConnectionLog[] = [
    {
      id: "log-rdp-rec",
      hostId: "h-1",
      hostLabel: "Windows Prod",
      hostname: "10.0.0.10",
      username: "Administrator",
      protocol: "rdp",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_134_000,
      localUsername: "alice",
      localHostname: "macbook",
      saved: true,
      recordingId: "123e4567-e89b-12d3-a456-426614174000",
      recordingMimeType: "video/webm;codecs=vp9,opus",
      recordingDurationMs: 134_000,
      recordingBytes: 4_404_019,
      recordingHasAudio: true,
    },
    {
      id: "log-vnc-plain",
      hostId: "h-2",
      hostLabel: "Linux Desktop",
      hostname: "10.0.0.20",
      username: "",
      protocol: "vnc",
      startTime: 1_699_999_000_000,
      endTime: 1_699_999_060_000,
      localUsername: "alice",
      localHostname: "macbook",
      saved: false,
    },
  ];

  const markup = renderWithI18n(
    React.createElement(ConnectionLogsManager, {
      logs,
      hosts: [],
      onToggleSaved: () => {},
      onDelete: () => {},
      onClearUnsaved: () => {},
      onOpenLogView: () => {},
    }),
  );

  assert.match(markup, /Windows Prod/);
  assert.match(markup, /Linux Desktop/);
  assert.match(markup, /data-recording-badge="123e4567-e89b-12d3-a456-426614174000"/);
  assert.match(markup, /02:14 · 4\.2 MB/);
  assert.match(markup, /vnc, 10\.0\.0\.20/);
  assert.match(markup, /bg-blue-500\/15 text-blue-600/);
  assert.match(markup, /bg-teal-500\/15 text-teal-600/);
});
