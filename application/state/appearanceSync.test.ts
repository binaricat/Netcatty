import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPersistedAppearanceChanged,
  isAppearanceStorageKey,
  resolveIncomingAppearanceValue,
  type AppearanceRenderSnapshot,
} from "./appearanceSync.ts";

const systemLight: AppearanceRenderSnapshot = {
  theme: "system",
  resolvedTheme: "light",
  lightUiThemeId: "snow",
  darkUiThemeId: "midnight",
  accentMode: "theme",
  customAccent: "208 100% 50%",
};

test("an OS color event cannot persist a stale System choice over a newer Dark choice", () => {
  const systemDark = { ...systemLight, resolvedTheme: "dark" as const };
  let storedTheme: "light" | "dark" | "system" = "dark";

  if (hasPersistedAppearanceChanged(systemLight, systemDark)) {
    storedTheme = systemDark.theme;
  }

  assert.equal(storedTheme, "dark");
});

test("an explicit theme choice remains a persisted appearance change", () => {
  assert.equal(
    hasPersistedAppearanceChanged(systemLight, {
      ...systemLight,
      theme: "dark",
      resolvedTheme: "dark",
    }),
    true,
  );
});

test("an appearance IPC value wins over stale local storage for the changed key", () => {
  const incoming = { key: "netcatty_theme_v1", value: "dark" };

  assert.equal(
    resolveIncomingAppearanceValue(
      incoming,
      "netcatty_theme_v1",
      "system",
      (value): value is "light" | "dark" | "system" => (
        value === "light" || value === "dark" || value === "system"
      ),
    ),
    "dark",
  );
  assert.equal(
    resolveIncomingAppearanceValue(
      incoming,
      "netcatty_ui_theme_dark_v1",
      "midnight",
      (value): value is string => typeof value === "string",
    ),
    "midnight",
  );
});

test("appearance storage echoes are left to the ordered IPC sync path", () => {
  assert.equal(isAppearanceStorageKey("netcatty_theme_v1"), true);
  assert.equal(isAppearanceStorageKey("netcatty_ui_theme_dark_v1"), true);
  assert.equal(isAppearanceStorageKey("netcatty_term_theme_v1"), false);
});
