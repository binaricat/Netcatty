import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTerminalSettings } from "./models";

test("normalizeTerminalSettings disables prompt line breaks by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.forcePromptNewLine, false);
});

test("normalizeTerminalSettings defaults startupCommandDelayMs to 600", () => {
  assert.equal(normalizeTerminalSettings().startupCommandDelayMs, 600);
});

test("normalizeTerminalSettings preserves a provided startupCommandDelayMs", () => {
  assert.equal(normalizeTerminalSettings({ startupCommandDelayMs: 0 }).startupCommandDelayMs, 0);
  assert.equal(normalizeTerminalSettings({ startupCommandDelayMs: 1500 }).startupCommandDelayMs, 1500);
});

test("normalizeTerminalSettings defaults localShellArgs to an empty array", () => {
  assert.deepEqual(normalizeTerminalSettings().localShellArgs, []);
});

test("normalizeTerminalSettings preserves provided localShellArgs", () => {
  assert.deepEqual(
    normalizeTerminalSettings({ localShellArgs: ["--login", "-i"] }).localShellArgs,
    ["--login", "-i"],
  );
});

test("normalizeTerminalSettings defaults middle-click behavior to paste", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.middleClickBehavior, "paste");
  assert.equal(settings.middleClickPaste, true);
});

test("normalizeTerminalSettings migrates disabled legacy middle-click paste", () => {
  const settings = normalizeTerminalSettings({ middleClickPaste: false });

  assert.equal(settings.middleClickBehavior, "disabled");
  assert.equal(settings.middleClickPaste, false);
});

test("normalizeTerminalSettings prefers explicit middle-click behavior over legacy paste flag", () => {
  const settings = normalizeTerminalSettings({
    middleClickBehavior: "context-menu",
    middleClickPaste: true,
  });

  assert.equal(settings.middleClickBehavior, "context-menu");
  assert.equal(settings.middleClickPaste, false);
});
