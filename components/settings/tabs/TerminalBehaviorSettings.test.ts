import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeTerminalSettings } from "../../../domain/models/terminal.ts";
import { TerminalBehaviorSettings } from "./TerminalBehaviorSettings.tsx";

const renderSettings = (
  autoCloseOnExit: boolean,
  disconnectedNoticeMode: "terminal" | "dialog" = "terminal",
) => renderToStaticMarkup(
  React.createElement(TerminalBehaviorSettings, {
    t: (key: string) => key,
    terminalSettings: normalizeTerminalSettings({ autoCloseOnExit, disconnectedNoticeMode }),
    updateTerminalSetting: () => {},
  }),
);

test("terminal behavior settings expose enabled auto-close by default", () => {
  const markup = renderSettings(true);

  assert.match(
    markup,
    /settings\.terminal\.behavior\.autoCloseOnExit[\s\S]*?role="switch" aria-checked="true"/,
  );
});

test("terminal behavior settings expose disabled auto-close", () => {
  const markup = renderSettings(false);

  assert.match(
    markup,
    /settings\.terminal\.behavior\.autoCloseOnExit[\s\S]*?role="switch" aria-checked="false"/,
  );
});

test("terminal behavior settings expose OSC desktop notification mode", () => {
  const markup = renderSettings(true);
  assert.match(markup, /settings-anchor-terminal-osc-notifications/);
  assert.match(markup, /settings\.terminal\.behavior\.oscNotifications/);
  assert.match(markup, /settings\.terminal\.behavior\.oscNotifications\.always/);
});

test("terminal behavior settings expose disconnected notice mode", () => {
  const terminalMarkup = renderSettings(true, "terminal");
  const dialogMarkup = renderSettings(true, "dialog");

  assert.match(terminalMarkup, /settings-anchor-terminal-disconnected-notice/);
  assert.match(terminalMarkup, /settings\.terminal\.behavior\.disconnectedNotice/);
  assert.match(terminalMarkup, /settings\.terminal\.behavior\.disconnectedNotice\.terminal/);
  assert.match(dialogMarkup, /settings\.terminal\.behavior\.disconnectedNotice\.dialog/);
});
