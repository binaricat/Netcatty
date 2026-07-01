import test from "node:test";
import assert from "node:assert/strict";

import {
  getContrastRatio,
  buildAppThemeCssVars,
  getHslTokenRelativeLuminance,
  resolveReadableForegroundForHsl,
  resolveThemeAccentForeground,
  migrateIncomingTerminalFontId,
} from "./settingsStateDefaults.ts";
import { TERMINAL_FONT_AUTO } from "../../infrastructure/config/fonts.ts";
import { STORAGE_KEY_TERM_FONT_FAMILY } from "../../infrastructure/config/storageKeys.ts";
import type { UiThemeTokens } from "../../infrastructure/config/uiThemes.ts";

function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

test("migrateIncomingTerminalFontId rewrites deprecated ids to the auto sentinel, not menlo", () => {
  // menlo would put Windows/Linux upgrade users back into the #1647 path,
  // and a concrete id would leak across OSes via sync; auto resolves per device.
  const store = installMemoryLocalStorage();
  try {
    assert.equal(migrateIncomingTerminalFontId("pingfang-sc"), TERMINAL_FONT_AUTO);
    // The rewrite is persisted as the platform-neutral sentinel, never a concrete id.
    assert.equal(store.get(STORAGE_KEY_TERM_FONT_FAMILY), TERMINAL_FONT_AUTO);
    assert.equal(migrateIncomingTerminalFontId("microsoft-yahei"), TERMINAL_FONT_AUTO);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("migrateIncomingTerminalFontId leaves valid ids and empty values untouched", () => {
  assert.equal(migrateIncomingTerminalFontId("jetbrains-mono"), "jetbrains-mono");
  assert.equal(migrateIncomingTerminalFontId(TERMINAL_FONT_AUTO), TERMINAL_FONT_AUTO);
  assert.equal(migrateIncomingTerminalFontId(""), null);
  assert.equal(migrateIncomingTerminalFontId(null), null);
});

test("readable foreground picks white text for dark accent colors", () => {
  assert.equal(resolveReadableForegroundForHsl("270 70% 45%"), "0 0% 100%");
});

test("readable foreground picks black text for light accent colors", () => {
  assert.equal(resolveReadableForegroundForHsl("48 95% 72%"), "0 0% 0%");
});

test("computed contrast chooses the stronger black or white foreground", () => {
  const purpleLuminance = getHslTokenRelativeLuminance("270 70% 45%");
  assert.equal(typeof purpleLuminance, "number");
  assert.ok(getContrastRatio(1, purpleLuminance as number) > getContrastRatio(0, purpleLuminance as number));

  const yellowLuminance = getHslTokenRelativeLuminance("48 95% 72%");
  assert.equal(typeof yellowLuminance, "number");
  assert.ok(getContrastRatio(0, yellowLuminance as number) > getContrastRatio(1, yellowLuminance as number));
});

test("theme accent foreground uses the computed color for preset accent buttons", () => {
  const tokens: UiThemeTokens = {
    background: "0 0% 100%",
    foreground: "222 47% 12%",
    card: "0 0% 100%",
    cardForeground: "222 47% 12%",
    popover: "0 0% 100%",
    popoverForeground: "222 47% 12%",
    primary: "270 70% 45%",
    primaryForeground: "0 0% 0%",
    secondary: "220 12% 95%",
    secondaryForeground: "222 47% 12%",
    muted: "220 12% 95%",
    mutedForeground: "220 10% 45%",
    accent: "270 70% 45%",
    accentForeground: "0 0% 0%",
    destructive: "0 70% 50%",
    destructiveForeground: "0 0% 100%",
    border: "220 12% 88%",
    input: "220 12% 88%",
    ring: "270 70% 45%",
  };

  assert.equal(resolveThemeAccentForeground(tokens, "theme", "48 95% 72%"), "0 0% 100%");
  assert.equal(resolveThemeAccentForeground(tokens, "custom", "48 95% 72%"), "0 0% 0%");
});

test("app surface theme vars isolate non-terminal pages from active terminal chrome", () => {
  const tokens: UiThemeTokens = {
    background: "0 0% 100%",
    foreground: "222 47% 12%",
    card: "0 0% 100%",
    cardForeground: "222 47% 12%",
    popover: "0 0% 100%",
    popoverForeground: "222 47% 12%",
    primary: "270 70% 45%",
    primaryForeground: "0 0% 0%",
    secondary: "220 12% 95%",
    secondaryForeground: "222 47% 12%",
    muted: "220 12% 95%",
    mutedForeground: "220 10% 45%",
    accent: "270 70% 45%",
    accentForeground: "0 0% 0%",
    destructive: "0 70% 50%",
    destructiveForeground: "0 0% 100%",
    border: "220 12% 88%",
    input: "220 12% 88%",
    ring: "270 70% 45%",
  };

  assert.deepEqual(buildAppThemeCssVars(tokens, "theme", "48 95% 72%"), {
    "--background": "0 0% 100%",
    "--foreground": "222 47% 12%",
    "--card": "0 0% 100%",
    "--card-foreground": "222 47% 12%",
    "--popover": "0 0% 100%",
    "--popover-foreground": "222 47% 12%",
    "--primary": "270 70% 45%",
    "--primary-foreground": "0 0% 100%",
    "--secondary": "220 12% 95%",
    "--secondary-foreground": "222 47% 12%",
    "--muted": "220 12% 95%",
    "--muted-foreground": "220 10% 45%",
    "--accent": "270 70% 45%",
    "--accent-foreground": "0 0% 100%",
    "--destructive": "0 70% 50%",
    "--destructive-foreground": "0 0% 100%",
    "--border": "220 12% 88%",
    "--input": "220 12% 88%",
    "--ring": "270 70% 45%",
  });
});
