import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTerminalSettings } from "./models";

test("normalizeTerminalSettings disables cursor line highlight by default", () => {
  assert.equal(normalizeTerminalSettings().highlightCursorLine, false);
});

test("normalizeTerminalSettings defaults disconnected sessions to a terminal notice", () => {
  assert.equal(normalizeTerminalSettings().disconnectedNoticeMode, "terminal");
});

test("normalizeTerminalSettings preserves supported disconnected notice modes", () => {
  assert.equal(
    normalizeTerminalSettings({ disconnectedNoticeMode: "terminal" }).disconnectedNoticeMode,
    "terminal",
  );
  assert.equal(
    normalizeTerminalSettings({ disconnectedNoticeMode: "dialog" }).disconnectedNoticeMode,
    "dialog",
  );
});

test("normalizeTerminalSettings rejects unsupported disconnected notice modes", () => {
  assert.equal(
    normalizeTerminalSettings({ disconnectedNoticeMode: "toast" as never }).disconnectedNoticeMode,
    "terminal",
  );
});

test("normalizeTerminalSettings preserves enabled cursor line highlight", () => {
  assert.equal(normalizeTerminalSettings({ highlightCursorLine: true }).highlightCursorLine, true);
});

test("normalizeTerminalSettings keeps Shift+Enter text opt-in for Win32 input mode", () => {
  assert.equal(normalizeTerminalSettings().shiftEnterForceText, false);
  assert.equal(normalizeTerminalSettings({ shiftEnterForceText: true }).shiftEnterForceText, true);
});

test("normalizeTerminalSettings disables prompt line breaks by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.forcePromptNewLine, false);
});

test("normalizeTerminalSettings defaults password prompt assist to hint", () => {
  assert.equal(normalizeTerminalSettings().passwordPromptAssist, "hint");
});

test("normalizeTerminalSettings preserves password prompt assist modes", () => {
  assert.equal(normalizeTerminalSettings({ passwordPromptAssist: "off" }).passwordPromptAssist, "off");
  assert.equal(normalizeTerminalSettings({ passwordPromptAssist: "hint" }).passwordPromptAssist, "hint");
  assert.equal(normalizeTerminalSettings({ passwordPromptAssist: "picker" }).passwordPromptAssist, "picker");
});

test("normalizeTerminalSettings falls back for unsupported password prompt assist modes", () => {
  assert.equal(
    normalizeTerminalSettings({ passwordPromptAssist: "legacy" as never }).passwordPromptAssist,
    "hint",
  );
});

test("normalizeTerminalSettings defaults autocomplete history scope to host", () => {
  assert.equal(normalizeTerminalSettings().autocompleteHistoryScope, "host");
});

test("normalizeTerminalSettings preserves autocomplete history scope", () => {
  assert.equal(
    normalizeTerminalSettings({ autocompleteHistoryScope: "global" }).autocompleteHistoryScope,
    "global",
  );
  assert.equal(
    normalizeTerminalSettings({ autocompleteHistoryScope: "host" }).autocompleteHistoryScope,
    "host",
  );
});

test("normalizeTerminalSettings falls back for unsupported autocomplete history scope", () => {
  assert.equal(
    normalizeTerminalSettings({ autocompleteHistoryScope: "legacy" as never }).autocompleteHistoryScope,
    "host",
  );
});

test("normalizeTerminalSettings enables Shift+Enter newline by default", () => {
  const settings = normalizeTerminalSettings();

  assert.equal(settings.shiftEnterNewlineEnabled, true);
  assert.equal(settings.shiftEnterNewlineText, "\\n");
});

test("normalizeTerminalSettings disables Kitty keyboard protocol by default", () => {
  assert.equal(normalizeTerminalSettings().kittyKeyboardProtocolEnabled, false);
  assert.equal(
    normalizeTerminalSettings({ kittyKeyboardProtocolEnabled: true }).kittyKeyboardProtocolEnabled,
    true,
  );
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

test("normalizeTerminalSettings defaults tab double click to a new connection", () => {
  assert.equal(normalizeTerminalSettings().tabDoubleClickBehavior, "duplicate");
});

test("normalizeTerminalSettings preserves supported tab double-click behaviors", () => {
  assert.equal(normalizeTerminalSettings({ tabDoubleClickBehavior: "duplicate" }).tabDoubleClickBehavior, "duplicate");
  assert.equal(normalizeTerminalSettings({ tabDoubleClickBehavior: "copy" }).tabDoubleClickBehavior, "copy");
  assert.equal(normalizeTerminalSettings({ tabDoubleClickBehavior: "disabled" }).tabDoubleClickBehavior, "disabled");
});

test("normalizeTerminalSettings rejects unsupported tab double-click behaviors", () => {
  assert.equal(
    normalizeTerminalSettings({ tabDoubleClickBehavior: "legacy" as never }).tabDoubleClickBehavior,
    "duplicate",
  );
});

test("normalizeTerminalSettings enables OSC desktop notifications by default", () => {
  assert.equal(normalizeTerminalSettings().oscNotifications, "always");
});

test("normalizeTerminalSettings preserves supported OSC notification modes", () => {
  assert.equal(normalizeTerminalSettings({ oscNotifications: "off" }).oscNotifications, "off");
  assert.equal(normalizeTerminalSettings({ oscNotifications: "unfocused" }).oscNotifications, "unfocused");
  assert.equal(normalizeTerminalSettings({ oscNotifications: "always" }).oscNotifications, "always");
});

test("normalizeTerminalSettings falls back for unsupported OSC notification modes", () => {
  assert.equal(
    normalizeTerminalSettings({ oscNotifications: "legacy" as never }).oscNotifications,
    "always",
  );
});

test("normalizeTerminalSettings enables font smoothing by default", () => {
  assert.equal(normalizeTerminalSettings().fontSmoothing, true);
});

test("normalizeTerminalSettings enables terminal auto-close by default", () => {
  assert.equal(normalizeTerminalSettings().autoCloseOnExit, true);
});

test("normalizeTerminalSettings preserves disabled terminal auto-close", () => {
  assert.equal(normalizeTerminalSettings({ autoCloseOnExit: false }).autoCloseOnExit, false);
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

test("normalizeTerminalSettings defaults host info bar title mode to address", () => {
  assert.equal(normalizeTerminalSettings().hostInfoBarTitleMode, "address");
});

test("normalizeTerminalSettings preserves supported host info bar title modes", () => {
  assert.equal(normalizeTerminalSettings({ hostInfoBarTitleMode: "label" }).hostInfoBarTitleMode, "label");
  assert.equal(normalizeTerminalSettings({ hostInfoBarTitleMode: "address" }).hostInfoBarTitleMode, "address");
});

test("normalizeTerminalSettings falls back for unsupported host info bar title modes", () => {
  assert.equal(
    normalizeTerminalSettings({ hostInfoBarTitleMode: "both" as never }).hostInfoBarTitleMode,
    "address",
  );
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

test("normalizeTerminalSettings enables normalizeTextOnCopy by default", () => {
  assert.equal(normalizeTerminalSettings().normalizeTextOnCopy, true);
  assert.equal(normalizeTerminalSettings({ normalizeTextOnCopy: false }).normalizeTextOnCopy, false);
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

test("normalizeTerminalSettings migrates legacy autocompleteMaxSuggestions default 8 to 50", () => {
  assert.equal(
    normalizeTerminalSettings({ autocompleteMaxSuggestions: 8 }).autocompleteMaxSuggestions,
    50,
  );
});

test("normalizeTerminalSettings preserves intentional custom autocompleteMaxSuggestions", () => {
  assert.equal(
    normalizeTerminalSettings({ autocompleteMaxSuggestions: 6 }).autocompleteMaxSuggestions,
    6,
  );
  assert.equal(
    normalizeTerminalSettings({ autocompleteMaxSuggestions: 20 }).autocompleteMaxSuggestions,
    20,
  );
});

test("normalizeTerminalSettings keeps multi-line paste confirmation opt-in", () => {
  assert.equal(normalizeTerminalSettings().confirmBeforeMultilinePaste, false);
  assert.equal(
    normalizeTerminalSettings({ confirmBeforeMultilinePaste: true }).confirmBeforeMultilinePaste,
    true,
  );
});

test("normalizeTerminalSettings clamps the multi-line paste threshold", () => {
  assert.equal(normalizeTerminalSettings().multilinePasteConfirmMinLines, 2);
  assert.equal(
    normalizeTerminalSettings({ multilinePasteConfirmMinLines: 5 }).multilinePasteConfirmMinLines,
    5,
  );
  assert.equal(
    normalizeTerminalSettings({ multilinePasteConfirmMinLines: 0 }).multilinePasteConfirmMinLines,
    1,
  );
  assert.equal(
    normalizeTerminalSettings({ multilinePasteConfirmMinLines: 5000 })
      .multilinePasteConfirmMinLines,
    1000,
  );
});
