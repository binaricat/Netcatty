import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

test("active chrome theme applies top tab vars and clears them before vault restore transition", () => {
  const chromeThemeSource = readFileSync(new URL("../state/useActiveChromeTheme.ts", import.meta.url), "utf8");
  const syncSource = readFileSync(new URL("../state/activeChromeThemeSync.ts", import.meta.url), "utf8");
  const effectsSource = readFileSync(new URL("../../components/terminalLayer/useTerminalLayerEffects.ts", import.meta.url), "utf8");

  assert.match(chromeThemeSource, /applyTopTabsChromeThemeVars\(theme\)/);
  assert.match(chromeThemeSource, /resolveReadableForegroundForHsl\(cursor\)/);
  const restoreBlock = chromeThemeSource.match(
    /clearTopTabsChromeThemeVars\(\);\s*runThemeTransition\(\(\) => \{\s*removeActiveChromeTheme\(\);/,
  )?.[0] ?? "";
  assert.notEqual(restoreBlock, "", "top tab vars must clear before the vault restore transition starts");
  assert.match(syncSource, /activeTabId === 'vault' \|\| activeTabId === 'sftp'\)[\s\S]*clearTopTabsChromeThemeVars\(\)/);
  assert.match(effectsSource, /if \(!isTerminalLayerVisible\) \{[\s\S]*clearTopTabsPreviewVars\(\)/);
});

test("top tabs chrome theme keeps accent foreground in sync", () => {
  const source = readFileSync(new URL("./topTabsChromeTheme.ts", import.meta.url), "utf8");
  const supportSource = readFileSync(new URL("../../components/terminalLayer/TerminalLayerSupport.tsx", import.meta.url), "utf8");

  assert.match(source, /--primary-foreground/);
  assert.match(source, /--accent-foreground/);
  assert.match(source, /resolveReadableForegroundForHsl\(accent\)/);
  assert.match(supportSource, /removeStylePropertyIfSet\(tabsRoot, '--primary-foreground'\)/);
  assert.match(supportSource, /removeStylePropertyIfSet\(tabsRoot, '--accent-foreground'\)/);
});
