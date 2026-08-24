import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readComponentSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("settings, tray, and terminal popup routes do not create fallback settings owners", () => {
  const settingsPage = readComponentSource("./SettingsPage.tsx");
  const trayPanel = readComponentSource("./TrayPanel.tsx");
  const terminalPopupPage = readComponentSource("./TerminalPopupPage.tsx");

  assert.doesNotMatch(settingsPage, /fallbackSettings\s*=\s*useSettingsState\(\)/);
  assert.doesNotMatch(settingsPage, /settings\?:\s*SettingsState/);
  assert.doesNotMatch(settingsPage, /providedSettings\s*\?\?/);

  assert.doesNotMatch(trayPanel, /fallbackSettings\s*=\s*useSettingsState\(\)/);
  assert.doesNotMatch(trayPanel, /settings\?:\s*SettingsState/);
  assert.doesNotMatch(trayPanel, /providedSettings\s*\?\?/);

  assert.doesNotMatch(terminalPopupPage, /fallbackSettings\s*=\s*useSettingsState\(\)/);
  assert.doesNotMatch(terminalPopupPage, /settings\?:\s*SettingsState/);
  assert.doesNotMatch(terminalPopupPage, /providedSettings\s*\?\?/);
});

test("terminal popups wait for app-lock initialization before starting a terminal", () => {
  const indexSource = readComponentSource("../index.tsx");
  assert.match(
    indexSource,
    /allowTerminalStart=\{appLock\.initialized\s*&&\s*!appLock\.locked\}/,
  );
});
