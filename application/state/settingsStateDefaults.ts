import type { HotkeyScheme, SessionLogFormat, TerminalSettings } from '../../domain/models';
import { STORAGE_KEY_TERM_FONT_FAMILY } from '../../infrastructure/config/storageKeys';
import { isDeprecatedPrimaryFontId } from '../../infrastructure/config/fonts';
import { DARK_UI_THEMES, LIGHT_UI_THEMES, type UiThemeTokens } from '../../infrastructure/config/uiThemes';
import { UI_FONTS } from '../../infrastructure/config/uiFonts';
import { uiFontStore } from './uiFontStore';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export const DEFAULT_THEME: 'light' | 'dark' | 'system' = 'dark';

/** Resolve the current OS color scheme preference. */
export const getSystemPreference = (): 'light' | 'dark' =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
export const DEFAULT_LIGHT_UI_THEME = 'snow';
export const DEFAULT_DARK_UI_THEME = 'midnight';
export const DEFAULT_ACCENT_MODE: 'theme' | 'custom' = 'theme';
export const DEFAULT_CUSTOM_ACCENT = '221.2 83.2% 53.3%';
export const DEFAULT_TERMINAL_THEME = 'netcatty-dark';
export const DEFAULT_FONT_FAMILY = 'menlo';

/**
 * Migrate any terminal font id arriving from storage / IPC / sync to a
 * safe value. If `raw` is a deprecated proportional id (pingfang-sc,
 * microsoft-yahei, comic-sans-ms), persist the rewrite back to
 * localStorage so subsequent ingest paths and cloud-sync uploads stop
 * carrying it. Used by every place that reads STORAGE_KEY_TERM_FONT_FAMILY
 * — initial useState init, rehydrateAllFromStorage, IPC notifySettings
 * change listener, and cross-window storage event listener — so a
 * single point of truth keeps deprecated ids from re-entering state.
 *
 * Returns null when there's nothing to apply (raw is empty); callers
 * fall back to DEFAULT_FONT_FAMILY in that case.
 */
export function migrateIncomingTerminalFontId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (isDeprecatedPrimaryFontId(raw)) {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_FAMILY, DEFAULT_FONT_FAMILY);
    return DEFAULT_FONT_FAMILY;
  }
  return raw;
}
// Auto-detect default hotkey scheme based on platform
export const DEFAULT_HOTKEY_SCHEME: HotkeyScheme =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? 'mac'
    : 'pc';
export const DEFAULT_SFTP_DOUBLE_CLICK_BEHAVIOR: 'open' | 'transfer' = 'open';
export const DEFAULT_SFTP_AUTO_SYNC = false;
export const DEFAULT_SFTP_SHOW_HIDDEN_FILES = false;
export const DEFAULT_SFTP_USE_COMPRESSED_UPLOAD = true;
export const DEFAULT_SFTP_AUTO_OPEN_SIDEBAR = false;
export const DEFAULT_SFTP_DEFAULT_VIEW_MODE: 'list' | 'tree' = 'list';
export const DEFAULT_SHOW_RECENT_HOSTS = true;
export const DEFAULT_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT = false;
export const DEFAULT_SHOW_SFTP_TAB = true;

// Editor defaults
export const DEFAULT_EDITOR_WORD_WRAP = false;

// Session Logs defaults
export const DEFAULT_SESSION_LOGS_ENABLED = false;
export const DEFAULT_SESSION_LOGS_FORMAT: SessionLogFormat = 'txt';

export const readStoredString = (key: string): string | null => {
  const raw = localStorageAdapter.readString(key);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : trimmed;
  } catch {
    return trimmed;
  }
};

export const isValidTheme = (value: unknown): value is 'light' | 'dark' | 'system' => value === 'light' || value === 'dark' || value === 'system';

export const isValidHslToken = (value: string): boolean => {
  // Expect: "<h> <s>% <l>%", e.g. "221.2 83.2% 53.3%"
  return /^\s*\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%\s*$/.test(value);
};

export const isValidUiThemeId = (theme: 'light' | 'dark', value: string): boolean => {
  const list = theme === 'dark' ? DARK_UI_THEMES : LIGHT_UI_THEMES;
  return list.some((preset) => preset.id === value);
};

export const isValidUiFontId = (value: string): boolean => {
  // Local fonts are always considered valid
  if (value.startsWith('local-')) return true;
  // Check bundled fonts first, then check dynamically loaded fonts
  return UI_FONTS.some((font) => font.id === value) ||
    uiFontStore.getAvailableFonts().some((font) => font.id === value);
};

export const serializeTerminalSettings = (settings: TerminalSettings): string =>
  JSON.stringify(settings);

export const areTerminalSettingsEqual = (a: TerminalSettings, b: TerminalSettings): boolean =>
  serializeTerminalSettings(a) === serializeTerminalSettings(b);

export const createCustomKeyBindingsSyncOrigin = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const applyThemeTokens = (
  themeSource: 'light' | 'dark' | 'system',
  resolvedTheme: 'light' | 'dark',
  tokens: UiThemeTokens,
  accentMode: 'theme' | 'custom',
  accentOverride: string,
) => {
  const root = window.document.documentElement;
  // If immersive override is active (style tag present), it owns the dark/light class — don't override
  if (!document.getElementById('netcatty-immersive-override')) {
    root.classList.remove('light', 'dark');
    root.classList.add(resolvedTheme);
  }
  root.style.setProperty('--background', tokens.background);
  root.style.setProperty('--foreground', tokens.foreground);
  root.style.setProperty('--card', tokens.card);
  root.style.setProperty('--card-foreground', tokens.cardForeground);
  root.style.setProperty('--popover', tokens.popover);
  root.style.setProperty('--popover-foreground', tokens.popoverForeground);
  const accentToken = accentMode === 'custom' ? accentOverride : tokens.accent;
  const accentLightness = parseFloat(accentToken.split(/\s+/)[2]?.replace('%', '') || '');
  const computedAccentForeground = resolvedTheme === 'dark'
    ? '220 40% 96%'
    : (!Number.isNaN(accentLightness) && accentLightness < 55 ? '0 0% 98%' : '222 47% 12%');

  root.style.setProperty('--primary', accentToken);
  root.style.setProperty('--primary-foreground', accentMode === 'custom' ? computedAccentForeground : tokens.primaryForeground);
  root.style.setProperty('--secondary', tokens.secondary);
  root.style.setProperty('--secondary-foreground', tokens.secondaryForeground);
  root.style.setProperty('--muted', tokens.muted);
  root.style.setProperty('--muted-foreground', tokens.mutedForeground);
  root.style.setProperty('--accent', accentToken);
  root.style.setProperty('--accent-foreground', accentMode === 'custom' ? computedAccentForeground : tokens.accentForeground);
  root.style.setProperty('--destructive', tokens.destructive);
  root.style.setProperty('--destructive-foreground', tokens.destructiveForeground);
  root.style.setProperty('--border', tokens.border);
  root.style.setProperty('--input', tokens.input);
  root.style.setProperty('--ring', accentToken);

  // Sync with native window title bar (Electron)
  netcattyBridge.get()?.setTheme?.(themeSource);
  netcattyBridge.get()?.setBackgroundColor?.(tokens.background);
};

