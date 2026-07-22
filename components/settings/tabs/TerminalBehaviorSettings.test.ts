import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeTerminalSettings } from "../../../domain/models/terminal.ts";
import { TerminalBehaviorSettings } from "./TerminalBehaviorSettings.tsx";

const renderSettings = (autoCloseOnExit: boolean) => renderToStaticMarkup(
  React.createElement(TerminalBehaviorSettings, {
    t: (key: string) => key,
    terminalSettings: normalizeTerminalSettings({ autoCloseOnExit }),
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
