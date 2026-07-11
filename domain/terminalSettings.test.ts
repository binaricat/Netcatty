import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTerminalSettings } from "./models";

test("normalizeTerminalSettings disables prompt line breaks by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.forcePromptNewLine, false);
});

test("normalizeTerminalSettings enables Shift+Enter newline by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.shiftEnterNewlineEnabled, true);
  assert.equal(settings.shiftEnterNewlineText, "\\n");
});

test("normalizeTerminalSettings preserves Shift+Enter text", () => {
  assert.equal(
    normalizeTerminalSettings({ shiftEnterNewlineText: " \\\\\\n" }).shiftEnterNewlineText,
    " \\\\\\n",
  );
});

test("normalizeTerminalSettings falls back when Shift+Enter text is not a string", () => {
  assert.equal(
    normalizeTerminalSettings({ shiftEnterNewlineText: null as never }).shiftEnterNewlineText,
    "\\n",
  );
});

test("normalizeTerminalSettings defaults startupCommandDelayMs to 600", () => {
  assert.equal(normalizeTerminalSettings().startupCommandDelayMs, 600);
});

test("normalizeTerminalSettings defaults dynamic tab titles to agent mode", () => {
  assert.equal(normalizeTerminalSettings().dynamicTabTitleMode, "agent");
});

test("normalizeTerminalSettings preserves supported dynamic tab title modes", () => {
  assert.equal(normalizeTerminalSettings({ dynamicTabTitleMode: "off" }).dynamicTabTitleMode, "off");
  assert.equal(normalizeTerminalSettings({ dynamicTabTitleMode: "agent" }).dynamicTabTitleMode, "agent");
  assert.equal(normalizeTerminalSettings({ dynamicTabTitleMode: "all" }).dynamicTabTitleMode, "all");
});

test("normalizeTerminalSettings falls back for unsupported dynamic tab title modes", () => {
  assert.equal(
    normalizeTerminalSettings({ dynamicTabTitleMode: "legacy" as never }).dynamicTabTitleMode,
    "agent",
  );
});

test("normalizeTerminalSettings enables font smoothing by default", () => {
  assert.equal(normalizeTerminalSettings().fontSmoothing, true);
});

test("normalizeTerminalSettings disables SSH auto reconnect by default", () => {
  assert.equal(normalizeTerminalSettings().sshAutoReconnectEnabled, false);
});

test("normalizeTerminalSettings preserves explicit SSH auto reconnect settings", () => {
  assert.equal(normalizeTerminalSettings({ sshAutoReconnectEnabled: true }).sshAutoReconnectEnabled, true);
  assert.equal(normalizeTerminalSettings({ sshAutoReconnectEnabled: false }).sshAutoReconnectEnabled, false);
});

test("normalizeTerminalSettings shows the host information bar by default", () => {
  assert.equal(normalizeTerminalSettings().showHostInfoBar, true);
});

test("normalizeTerminalSettings preserves a hidden host information bar", () => {
  assert.equal(normalizeTerminalSettings({ showHostInfoBar: false }).showHostInfoBar, false);
});

test("normalizeTerminalSettings disables hibernate for hidden tabs by default", () => {
  assert.equal(normalizeTerminalSettings().hibernateHiddenTabs, false);
  assert.equal(normalizeTerminalSettings().hibernateHiddenTabsDelaySec, 5);
});

test("normalizeTerminalSettings clamps hibernate delay seconds", () => {
  assert.equal(normalizeTerminalSettings({ hibernateHiddenTabsDelaySec: 120 }).hibernateHiddenTabsDelaySec, 120);
  assert.equal(normalizeTerminalSettings({ hibernateHiddenTabsDelaySec: 2 }).hibernateHiddenTabsDelaySec, 5);
});

test("normalizeTerminalSettings preserves disabled font smoothing", () => {
  assert.equal(normalizeTerminalSettings({ fontSmoothing: false }).fontSmoothing, false);
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

test("normalizeTerminalSettings defaults word separators to xterm-compatible boundaries", () => {
  assert.equal(normalizeTerminalSettings().wordSeparators, " ()[]{}'\"");
});

test("normalizeTerminalSettings preserves custom word separators", () => {
  const custom = " ()[]{}'\"=,:";

  assert.equal(normalizeTerminalSettings({ wordSeparators: custom }).wordSeparators, custom);
});

test("normalizeTerminalSettings falls back when word separators are not a string", () => {
  assert.equal(
    normalizeTerminalSettings({ wordSeparators: null as never }).wordSeparators,
    " ()[]{}'\"",
  );
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
