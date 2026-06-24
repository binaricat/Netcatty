import test from "node:test";
import assert from "node:assert/strict";

import {
  getContrastRatio,
  buildAppThemeCssVars,
  getHslTokenRelativeLuminance,
  resolveReadableForegroundForHsl,
  resolveThemeAccentForeground,
} from "./settingsStateDefaults.ts";
import type { UiThemeTokens } from "../../infrastructure/config/uiThemes.ts";

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
