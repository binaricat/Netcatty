import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalThemePanelState.ts", import.meta.url), "utf8");

test("follow-app side panel theme changes delegate to ThemeRuntime pickTheme", () => {
  assert.match(source, /pickTheme\(themeId\)/);
  assert.match(source, /if \(followAppTerminalTheme\) \{/);
  assert.doesNotMatch(source, /onUpdateFollowAppTerminalThemeId/);
  assert.doesNotMatch(source, /setThemePreview/);
  assert.doesNotMatch(source, /applyTerminalPreviewVars/);
});

test("manual side panel theme changes persist host overrides and use runtime pick intent", () => {
  assert.match(source, /pickTheme\(themeId, \{/);
  assert.match(source, /scopeHostId:/);
  assert.match(source, /onUpdateHost\(\{ \.\.\.rawFocusedHost, theme: themeId, themeOverride: true \}\)/);
  assert.doesNotMatch(source, /startTransition\(\(\) => \{[\s\S]*onUpdateHost\(\{ \.\.\.rawFocusedHost, theme: themeId/);
});

test("follow-app keeps runtime intent until the side panel closes", () => {
  assert.match(source, /isSidePanelOpenForCurrentTab/);
  assert.match(source, /if \(!followAppTerminalTheme && activeSidePanelTab !== 'theme'\)/);
  assert.match(source, /clearIntent\(\)/);
});

test("follow-app theme list selection tracks global runtime theme id", () => {
  assert.match(source, /listSelectedThemeId = followAppTerminalTheme/);
  assert.match(source, /terminalTheme\.id/);
});

test("manual theme list selection reads focused appearance from runtime", () => {
  assert.match(source, /resolveFocusedAppearance\(focusedHostScope\)/);
  assert.match(source, /focusedAppearance\.themeId/);
  assert.match(source, /resolvedPreviewTheme = focusedAppearance\.theme/);
});

test("closing the theme tab clears runtime user intent", () => {
  assert.match(source, /if \(isSidePanelOpenForCurrentTab\)/);
  assert.match(source, /clearIntent\(\)/);
});
