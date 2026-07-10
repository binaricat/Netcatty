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
import {
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_COLOR,
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_UI_THEME_LIGHT,
} from "../../infrastructure/config/storageKeys.ts";

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
  const incoming = { key: STORAGE_KEY_THEME, value: "dark" };

  assert.equal(
    resolveIncomingAppearanceValue(
      incoming,
      STORAGE_KEY_THEME,
      "system",
      "system",
      (value): value is "light" | "dark" | "system" => (
        value === "light" || value === "dark" || value === "system"
      ),
    ),
    "dark",
  );
  // Non-matching keyed IPC must keep the current in-memory value, not storage.
  assert.equal(
    resolveIncomingAppearanceValue(
      incoming,
      STORAGE_KEY_UI_THEME_DARK,
      "stale-from-storage",
      "midnight",
      (value): value is string => typeof value === "string",
    ),
    "midnight",
  );
  // Full rehydrate (no incoming) still prefers storage.
  assert.equal(
    resolveIncomingAppearanceValue(
      undefined,
      STORAGE_KEY_UI_THEME_DARK,
      "from-storage",
      "midnight",
      (value): value is string => typeof value === "string",
    ),
    "from-storage",
  );
});

test("a non-theme appearance IPC value wins over stale local storage for that key", () => {
  const current: AppearanceState = {
    theme: "dark",
    lightUiThemeId: "snow",
    darkUiThemeId: "midnight",
    accentMode: "theme",
    customAccent: "208 100% 50%",
  };
  // Storage still lags for every non-theme field (the race the review covers).
  const staleStored: StoredAppearanceValues = {
    theme: "dark",
    lightUiThemeId: "snow",
    darkUiThemeId: "midnight",
    accentMode: "theme",
    customAccent: "208 100% 50%",
  };

  // Picking a follow-app terminal theme updates darkUiThemeId; only that key is
  // announced on the IPC payload, so the reducer must prefer the payload.
  const darkUiSelection = {
    key: STORAGE_KEY_UI_THEME_DARK,
    value: "github",
  };
  const nextDarkUi = resolveAppearanceSyncState(current, {
    ...staleStored,
    darkUiThemeId: "midnight",
  }, darkUiSelection);
  assert.equal(nextDarkUi.darkUiThemeId, "github");
  assert.equal(nextDarkUi.theme, "dark");
  assert.equal(nextDarkUi.lightUiThemeId, "snow");

  const lightUiSelection = {
    key: STORAGE_KEY_UI_THEME_LIGHT,
    value: "flexoki",
  };
  const nextLightUi = resolveAppearanceSyncState(current, {
    ...staleStored,
    lightUiThemeId: "snow",
  }, lightUiSelection);
  assert.equal(nextLightUi.lightUiThemeId, "flexoki");

  const accentModeSelection = {
    key: STORAGE_KEY_ACCENT_MODE,
    value: "custom",
  };
  const nextAccentMode = resolveAppearanceSyncState(current, {
    ...staleStored,
    accentMode: "theme",
  }, accentModeSelection);
  assert.equal(nextAccentMode.accentMode, "custom");

  const customAccentSelection = {
    key: STORAGE_KEY_COLOR,
    value: "221.2 83.2% 53.3%",
  };
  const nextCustomAccent = resolveAppearanceSyncState(current, {
    ...staleStored,
    customAccent: "208 100% 50%",
  }, customAccentSelection);
  assert.equal(nextCustomAccent.customAccent, "221.2 83.2% 53.3%");

  // Without an announced key, full rehydrate still reads storage.
  const noIncoming = resolveAppearanceSyncState(current, {
    ...staleStored,
    darkUiThemeId: "github",
  });
  assert.equal(noIncoming.darkUiThemeId, "github");
});

test("sequential keyed appearance IPC updates compose without stale-storage clobber", () => {
  // One action changes theme + dark UI theme; the sender emits two keyed notifies.
  // Storage still holds the pre-change values for the entire sequence.
  const initial: AppearanceState = {
    theme: "system",
    lightUiThemeId: "snow",
    darkUiThemeId: "midnight",
    accentMode: "theme",
    customAccent: "208 100% 50%",
  };
  const staleStored: StoredAppearanceValues = { ...initial };

  let next = resolveAppearanceSyncState(initial, staleStored, {
    key: STORAGE_KEY_THEME,
    value: "dark",
  });
  assert.equal(next.theme, "dark");
  assert.equal(next.darkUiThemeId, "midnight");

  // Later theme-id message must not revert theme back to the stale stored System.
  next = resolveAppearanceSyncState(next, staleStored, {
    key: STORAGE_KEY_UI_THEME_DARK,
    value: "github",
  });
  assert.equal(next.theme, "dark");
  assert.equal(next.darkUiThemeId, "github");
  assert.equal(next.lightUiThemeId, "snow");
  assert.equal(next.accentMode, "theme");
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
  const themeNotifyIndex = stateSource.indexOf("notifySettingsChanged(STORAGE_KEY_THEME, theme)", writeIndex);
  const lightNotifyIndex = stateSource.indexOf("notifySettingsChanged(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId)", writeIndex);
  const darkNotifyIndex = stateSource.indexOf("notifySettingsChanged(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId)", writeIndex);
  const accentModeNotifyIndex = stateSource.indexOf("notifySettingsChanged(STORAGE_KEY_ACCENT_MODE, accentMode)", writeIndex);
  const colorNotifyIndex = stateSource.indexOf("notifySettingsChanged(STORAGE_KEY_COLOR, customAccent)", writeIndex);

  assert.ok(guardIndex >= 0, "the settings effect must compare persisted appearance fields");
  assert.ok(returnIndex > guardIndex && returnIndex < writeIndex, "the stale render must stop before storage is written");
  assert.ok(themeNotifyIndex > writeIndex, "theme changes must be announced over IPC with the new value");
  assert.ok(lightNotifyIndex > writeIndex, "light UI theme changes must be announced over IPC with the new value");
  assert.ok(darkNotifyIndex > writeIndex, "dark UI theme changes must be announced over IPC with the new value");
  assert.ok(accentModeNotifyIndex > writeIndex, "accent mode changes must be announced over IPC with the new value");
  assert.ok(colorNotifyIndex > writeIndex, "custom accent changes must be announced over IPC with the new value");
  // Source still only notifies fields that actually changed (keyed, not a single theme-only broadcast).
  assert.match(
    stateSource,
    /previousAppearance\.theme !== theme[\s\S]*notifySettingsChanged\(STORAGE_KEY_THEME, theme\)/,
  );
  assert.match(
    stateSource,
    /previousAppearance\.lightUiThemeId !== lightUiThemeId[\s\S]*notifySettingsChanged\(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId\)/,
  );
  assert.match(
    stateSource,
    /previousAppearance\.darkUiThemeId !== darkUiThemeId[\s\S]*notifySettingsChanged\(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId\)/,
  );
  // Sequential keyed IPC must compose via a ref, not a render-stale closure.
  assert.match(stateSource, /appearanceStateRef\.current = nextAppearance/);
  assert.match(ipcSource, /syncAppearanceFromStorage\(\{ key, value \}\)/);
  assert.match(storageSource, /resolveAppearanceStorageEvent\(s, e\.key, e\.newValue\)/);
  assert.match(popupSource, /terminalTheme=\{settings\.currentTerminalTheme\}/);
  assert.match(popupSource, /followAppTerminalTheme=\{settings\.followAppTerminalTheme\}/);
});
