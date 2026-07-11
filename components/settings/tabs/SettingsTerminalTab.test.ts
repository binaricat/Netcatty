import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SettingsTerminalTab.tsx", import.meta.url), "utf8");

test("terminal settings hide terminal theme pickers while following app theme", () => {
  assert.match(source, /\{!followAppTerminalTheme && \(/);
  assert.doesNotMatch(source, /settings\.terminal\.theme\.followingTheme/);
});

test("terminal settings only update the legacy global theme for the active mode", () => {
  assert.match(source, /if \(themeModalSlot === resolvedTheme\) \{\s*setTerminalThemeId\(id\);/);
});

test("terminal settings expose host key verification toggle", () => {
  assert.match(source, /settings\.terminal\.connection\.verifyHostKeys/);
  assert.match(source, /checked=\{terminalSettings\.verifyHostKeys\}/);
  assert.match(source, /updateTerminalSetting\("verifyHostKeys", v\)/);
});

test("terminal settings expose SSH auto reconnect toggle", () => {
  assert.match(source, /settings\.terminal\.connection\.sshAutoReconnectEnabled/);
  assert.match(source, /checked=\{terminalSettings\.sshAutoReconnectEnabled\}/);
  assert.match(source, /updateTerminalSetting\("sshAutoReconnectEnabled", v\)/);
});

test("terminal settings expose the host information bar toggle", () => {
  assert.match(source, /checked=\{terminalSettings\.showHostInfoBar\}/);
  assert.match(source, /updateTerminalSetting\("showHostInfoBar", v\)/);
});
