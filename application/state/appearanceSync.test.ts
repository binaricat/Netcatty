import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { idleThemeUserIntent, resolveGlobalTerminalAppearance } from "../../domain/terminalAppearanceRuntime.ts";
import {
  hasPersistedAppearanceChanged,
  resolveAppearanceStorageEvent,
  resolveAppearanceSyncState,
  resolveIncomingAppearanceValue,
  type AppearanceState,
  type AppearanceRenderSnapshot,
  type StoredAppearanceValues,
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
  const initialState: AppearanceState = {
    theme: systemLight.theme,
    lightUiThemeId: systemLight.lightUiThemeId,
    darkUiThemeId: systemLight.darkUiThemeId,
    accentMode: systemLight.accentMode,
    customAccent: systemLight.customAccent,
  };
  const terminalAppearance = (appearance: AppearanceState, resolvedTheme: "light" | "dark") => (
    resolveGlobalTerminalAppearance({
      userIntent: idleThemeUserIntent(),
      settings: {
        terminalThemeId: "netcatty-dark",
        terminalThemeDarkId: "auto",
        terminalThemeLightId: "auto",
        followAppTerminalTheme: true,
        resolvedTheme,
        lightUiThemeId: appearance.lightUiThemeId,
        darkUiThemeId: appearance.darkUiThemeId,
        accentMode: appearance.accentMode,
        customAccent: appearance.customAccent,
      },
      customThemes: [],
    })
  );
  const persistRender = (
    stored: StoredAppearanceValues,
    previous: AppearanceRenderSnapshot,
    current: AppearanceRenderSnapshot,
  ): StoredAppearanceValues => {
    if (!hasPersistedAppearanceChanged(previous, current)) return stored;
    return {
      theme: current.theme,
      lightUiThemeId: current.lightUiThemeId,
      darkUiThemeId: current.darkUiThemeId,
      accentMode: current.accentMode,
      customAccent: current.customAccent,
    };
  };

  let stored: StoredAppearanceValues = { ...initialState };
  let main = { ...initialState };
  let detachedTerminal = { ...initialState };
  const initialMainTerminal = terminalAppearance(main, "light");
  const initialDetachedTerminal = terminalAppearance(detachedTerminal, "light");

  const settingsDark: AppearanceRenderSnapshot = {
    ...systemLight,
    theme: "dark",
    resolvedTheme: "dark",
  };
  stored = persistRender(stored, systemLight, settingsDark);
  const darkSelection = { key: STORAGE_KEY_THEME, value: "dark" };

  // A stale peer receives an OS color event before the Dark IPC message. Its
  // semantic choice is still System, so it must not write System back.
  stored = persistRender(stored, systemLight, { ...systemLight, resolvedTheme: "dark" });

  // Main windows run the production IPC reducer. Deliberately pass its lagging
  // System storage read so only the ordered Dark payload can win.
  main = resolveAppearanceSyncState(main, {
    ...stored,
    theme: "system",
  }, darkSelection);

  // Detached terminal and tray renderers run the production storage-event
  // reducer because they are not direct IPC broadcast targets.
  const detachedUpdate = resolveAppearanceStorageEvent(
    detachedTerminal,
    darkSelection.key,
    String(stored.theme),
  );
  detachedTerminal = detachedUpdate.next;

  const finalMainTerminal = terminalAppearance(main, "dark");
  const finalDetachedTerminal = terminalAppearance(detachedTerminal, "dark");

  assert.equal(stored.theme, "dark");
  assert.equal(settingsDark.theme, "dark");
  assert.equal(main.theme, "dark");
  assert.equal(detachedUpdate.handled, true);
  assert.equal(detachedTerminal.theme, "dark");
  assert.equal(initialMainTerminal.theme.type, "light");
  assert.equal(initialDetachedTerminal.theme.type, "light");
  assert.equal(finalMainTerminal.theme.type, "dark");
  assert.equal(finalDetachedTerminal.theme.type, "dark");
  assert.notEqual(finalMainTerminal.theme.colors.background, initialMainTerminal.theme.colors.background);
  assert.notEqual(finalDetachedTerminal.theme.colors.background, initialDetachedTerminal.theme.colors.background);
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
  assert.match(storageSource, /resolveAppearanceStorageEvent\(s, e\.key, e\.newValue\)/);
  assert.match(popupSource, /terminalTheme=\{settings\.currentTerminalTheme\}/);
  assert.match(popupSource, /followAppTerminalTheme=\{settings\.followAppTerminalTheme\}/);
});
