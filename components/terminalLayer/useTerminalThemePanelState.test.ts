import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalThemePanelState.ts", import.meta.url), "utf8");

test("follow-app side panel theme changes update the global terminal theme", () => {
  assert.match(source, /onUpdateFollowAppTerminalThemeId\?\.\(themeId\)/);
  assert.match(source, /if \(followAppTerminalTheme\) \{/);
});

test("follow-app side panel theme changes skip focused-only terminal preview", () => {
  const followAppBranch = source.match(/if \(followAppTerminalTheme\) \{[\s\S]*?return;[\s\S]*?\n\s+\}/)?.[0] ?? "";

  assert.notEqual(followAppBranch, "", "follow-app theme changes should have an immediate branch");
  assert.doesNotMatch(followAppBranch, /applyTerminalPreviewVars/);
  assert.doesNotMatch(followAppBranch, /applyTopTabsPreviewVars/);
  assert.doesNotMatch(followAppBranch, /applyHostTreePreviewVars/);
  assert.match(followAppBranch, /clearTerminalPreviewVars\(previewTargetSessionId\)/);
  assert.match(followAppBranch, /clearHostTreePreviewVars\(\)/);
  assert.match(followAppBranch, /clearTopTabsPreviewVars\(\)/);
  assert.match(
    source,
    /if \(followAppTerminalTheme\) \{[\s\S]*setThemePreview\(\{ targetSessionId: null, themeId: null \}\);[\s\S]*onUpdateFollowAppTerminalThemeId\?\.\(themeId\);[\s\S]*return;[\s\S]*\}\s+applyTopTabsPreviewVars\(themeId\);[\s\S]*applyHostTreePreviewVars\(themeId\);[\s\S]*applyTerminalPreviewVars\(previewTargetSessionId, themeId\);/,
  );
});

test("theme previews update the host tree sidebar in the same pass", () => {
  assert.match(source, /applyHostTreePreviewVars\(themeId\)/);
  assert.match(source, /clearHostTreePreviewVars\(\)/);
});
