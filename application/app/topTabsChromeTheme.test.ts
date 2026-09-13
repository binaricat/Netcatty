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

test("bottom title bar receives and clears the same active theme as the tabs", async () => {
  const { applyTopTabsChromeThemeVars, clearTopTabsChromeThemeVars } = await import('./topTabsChromeTheme.ts');
  const { TERMINAL_THEMES } = await import('../../infrastructure/config/terminalThemes.ts');
  const makeRoot = () => {
    const values = new Map<string, string>();
    return { style: {
      getPropertyValue: (key: string) => values.get(key) ?? '',
      setProperty: (key: string, value: string) => values.set(key, value),
      removeProperty: (key: string) => values.delete(key),
    }};
  };
  const tabs = makeRoot();
  const titlebar = makeRoot();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelector: (selector: string) => selector === '[data-top-tabs-root]' ? tabs : titlebar,
  }});
  try {
    applyTopTabsChromeThemeVars(TERMINAL_THEMES[0]);
    for (const property of ['--secondary', '--foreground', '--top-tabs-bg']) {
      assert.notEqual(tabs.style.getPropertyValue(property), '');
      assert.equal(titlebar.style.getPropertyValue(property), tabs.style.getPropertyValue(property));
    }
    clearTopTabsChromeThemeVars();
    assert.equal(tabs.style.getPropertyValue('--secondary'), '');
    assert.equal(titlebar.style.getPropertyValue('--secondary'), '');
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
