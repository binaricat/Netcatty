import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasPersistedAppearanceChanged,
  resolveIncomingAppearanceValue,
  type AppearanceRenderSnapshot,
} from "./appearanceSync.ts";
import { STORAGE_KEY_THEME } from "../../infrastructure/config/storageKeys.ts";

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

test("System on a light OS changes to Dark in every open follow-app terminal", () => {
  type Theme = AppearanceRenderSnapshot["theme"];
  type Peer = {
    render: AppearanceRenderSnapshot;
    followsApp: boolean;
    openTerminalBackground: "light" | "dark";
  };

  const createPeer = (): Peer => ({
    render: { ...systemLight },
    followsApp: true,
    openTerminalBackground: "light",
  });
  const settings = createPeer();
  const main = createPeer();
  const detachedTerminal = createPeer();
  let storedTheme: Theme = "system";

  const persistAppearance = (
    previous: AppearanceRenderSnapshot,
    current: AppearanceRenderSnapshot,
  ) => {
    if (hasPersistedAppearanceChanged(previous, current)) {
      storedTheme = current.theme;
    }
  };
  const applyTheme = (peer: Peer, theme: Theme) => {
    peer.render = {
      ...peer.render,
      theme,
      resolvedTheme: theme === "system" ? "light" : theme,
    };
    if (peer.followsApp) peer.openTerminalBackground = peer.render.resolvedTheme;
  };

  const settingsBefore = settings.render;
  applyTheme(settings, "dark");
  persistAppearance(settingsBefore, settings.render);
  const darkSelection = { key: STORAGE_KEY_THEME, value: "dark" };

  // A stale peer receives an OS color event before the Dark IPC message. Its
  // semantic choice is still System, so it must not write System back.
  const staleMainBefore = main.render;
  main.render = { ...main.render, resolvedTheme: "dark" };
  persistAppearance(staleMainBefore, main.render);

  // Main windows use the ordered IPC value even if their storage read lags.
  applyTheme(main, resolveIncomingAppearanceValue(
    darkSelection,
    STORAGE_KEY_THEME,
    "system" as Theme,
    (value): value is Theme => value === "light" || value === "dark" || value === "system",
  ));

  // Detached terminal and tray renderers are not IPC broadcast targets; they
  // still receive the authoritative storage event.
  applyTheme(detachedTerminal, storedTheme);

  assert.equal(storedTheme, "dark");
  assert.equal(settings.render.theme, "dark");
  assert.equal(main.render.theme, "dark");
  assert.equal(main.render.resolvedTheme, "dark");
  assert.equal(detachedTerminal.render.theme, "dark");
  assert.equal(detachedTerminal.openTerminalBackground, "dark");
});

test("the race guards are wired into the real settings paths", () => {
  const stateSource = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const ipcSource = readFileSync(new URL("./settingsIpcSync.ts", import.meta.url), "utf8");
  const storageSource = readFileSync(new URL("./settingsStorageSync.ts", import.meta.url), "utf8");
  const popupSource = readFileSync(new URL("../../components/TerminalPopupPage.tsx", import.meta.url), "utf8");

  const guardIndex = stateSource.indexOf("hasPersistedAppearanceChanged(");
  const returnIndex = stateSource.indexOf("if (!persistedAppearanceChanged && persistMountedRef.current)", guardIndex);
  const writeIndex = stateSource.indexOf("localStorageAdapter.writeString(STORAGE_KEY_THEME", guardIndex);

  assert.ok(guardIndex >= 0, "the settings effect must compare persisted appearance fields");
  assert.ok(returnIndex > guardIndex && returnIndex < writeIndex, "the stale render must stop before storage is written");
  assert.match(ipcSource, /syncAppearanceFromStorage\(\{ key, value \}\)/);
  assert.doesNotMatch(storageSource, /isAppearanceStorageKey\(e\.key\).*return/);
  assert.match(popupSource, /useSettingsState\(\)/);
});
