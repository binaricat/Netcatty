import {
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_COLOR,
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_UI_THEME_LIGHT,
} from '../../infrastructure/config/storageKeys';

export type AppearanceRenderSnapshot = {
  theme: "light" | "dark" | "system";
  resolvedTheme: "light" | "dark";
  lightUiThemeId: string;
  darkUiThemeId: string;
  accentMode: "theme" | "custom";
  customAccent: string;
};

export type AppearanceSyncEvent = {
  key: string;
  value: unknown;
};

const APPEARANCE_STORAGE_KEYS = new Set([
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_THEME_LIGHT,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_COLOR,
]);

export function isAppearanceStorageKey(key: string | null): boolean {
  return key !== null && APPEARANCE_STORAGE_KEYS.has(key);
}

export function hasPersistedAppearanceChanged(
  previous: AppearanceRenderSnapshot,
  current: AppearanceRenderSnapshot,
): boolean {
  return previous.theme !== current.theme
    || previous.lightUiThemeId !== current.lightUiThemeId
    || previous.darkUiThemeId !== current.darkUiThemeId
    || previous.accentMode !== current.accentMode
    || previous.customAccent !== current.customAccent;
}

export function resolveIncomingAppearanceValue<T>(
  incoming: AppearanceSyncEvent | undefined,
  key: string,
  storedValue: T,
  isValid: (value: unknown) => value is T,
): T {
  if (incoming?.key === key && isValid(incoming.value)) {
    return incoming.value;
  }
  return storedValue;
}
