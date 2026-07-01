import assert from "node:assert/strict";
import test from "node:test";

import { emptyTerminalThemePreview } from "./terminalThemePreview";
import {
  resolveActiveThemePreviewId,
  resolveThemeListSelectionId,
} from "./terminalThemeSelection";

const preview = {
  targetSessionId: "session-a",
  targetHostId: "host-1",
  globalPreview: false,
  themeId: "dracula",
};

test("active preview id follows host scope when focus moves within the same host", () => {
  assert.equal(
    resolveActiveThemePreviewId(preview, "session-b", "host-1"),
    "dracula",
  );
  assert.equal(
    resolveActiveThemePreviewId(preview, "session-b", "host-2"),
    null,
  );
});

test("follow-app list selection prefers pending pick over resolved terminal theme", () => {
  assert.equal(
    resolveThemeListSelectionId({
      followAppTerminalTheme: true,
      followAppPendingThemeId: "system-flexoki-light",
      terminalThemeId: "system-github-dark",
      themePreview: emptyTerminalThemePreview(),
      previewTargetSessionId: "session-a",
      previewTargetHostId: "host-1",
      focusedThemeId: "system-github-dark",
    }),
    "system-flexoki-light",
  );
});

test("manual list selection prefers in-scope preview over focused theme", () => {
  assert.equal(
    resolveThemeListSelectionId({
      followAppTerminalTheme: false,
      followAppPendingThemeId: null,
      terminalThemeId: "netcatty-dark",
      themePreview: preview,
      previewTargetSessionId: "session-b",
      previewTargetHostId: "host-1",
      focusedThemeId: "solarized-light",
    }),
    "dracula",
  );
});
