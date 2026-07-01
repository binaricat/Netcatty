import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const appViewSource = readFileSync(new URL("./AppView.tsx", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../state/useThemeRuntime.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../state/useSettingsState.ts", import.meta.url), "utf8");

test("follow-app terminal theme selection updates the matching UI theme via ThemeRuntime", () => {
  assert.match(runtimeSource, /getFollowAppTerminalThemeSelectionUpdate\(themeId\)/);
  assert.match(runtimeSource, /setDarkUiThemeId\(update\.uiThemeId\)/);
  assert.match(runtimeSource, /setLightUiThemeId\(update\.uiThemeId\)/);
  assert.match(runtimeSource, /setTheme\(update\.appTheme\)/);
  assert.doesNotMatch(runtimeSource, /isFollowAppIntentSettled\(userIntent\.themeId/);
  assert.match(appSource, /useThemeRuntime\(/);
  assert.match(appSource, /themeRuntime\.pickTheme\(themeId\)/);
  assert.match(appSource, /useTerminalAppearanceInjection/);
  assert.match(appSource, /includeChromeSurfaces: followAppTerminalTheme/);
  assert.match(appSource, /clearThemeIntent\(\)/);
  assert.match(runtimeSource, /injectTerminalAppearanceVars\(appearance\.theme, \{ includeChromeSurfaces \}\)/);
  assert.doesNotMatch(settingsSource, /pendingFollowAppTerminalThemeId/);
  assert.doesNotMatch(settingsSource, /applyFollowAppTerminalThemePick/);
  assert.match(settingsSource, /appearanceTransitionModeRef\.current = 'instant'/);
  assert.match(appViewSource, /data-terminal-appearance-root/);
  assert.match(appViewSource, /pickTerminalTheme=\{ctx\.pickTerminalTheme\}/);
});

test("default terminal theme selection clears the current mode override", () => {
  assert.match(appSource, /const handleDefaultTerminalThemeChange = useCallback\(\(themeId: string\) => \{/);
  assert.match(appSource, /setTerminalThemeId\(themeId\)/);
  assert.match(appSource, /resolvedTheme === 'dark'[\s\S]*setTerminalThemeDarkId\(TERMINAL_THEME_AUTO\)/);
  assert.match(appSource, /setTerminalThemeLightId\(TERMINAL_THEME_AUTO\)/);
  assert.match(appViewSource, /onUpdateTerminalThemeId=\{handleDefaultTerminalThemeChange\}/);
});
