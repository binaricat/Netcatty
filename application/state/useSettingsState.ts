import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { SyncConfig, TerminalSettings, DEFAULT_TERMINAL_SETTINGS, HotkeyScheme, CustomKeyBindings, DEFAULT_KEY_BINDINGS, KeyBinding, UILanguage, SessionLogFormat } from '../../domain/models';
import {
  STORAGE_KEY_COLOR,
  STORAGE_KEY_SYNC,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_THEME,
  STORAGE_KEY_TERM_FONT_FAMILY,
  STORAGE_KEY_TERM_FONT_SIZE,
  STORAGE_KEY_TERM_SETTINGS,
  STORAGE_KEY_HOTKEY_SCHEME,
  STORAGE_KEY_CUSTOM_KEY_BINDINGS,
  STORAGE_KEY_HOTKEY_RECORDING,
  STORAGE_KEY_CUSTOM_CSS,
  STORAGE_KEY_UI_LANGUAGE,
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_UI_THEME_LIGHT,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_UI_FONT_FAMILY,
  STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR,
  STORAGE_KEY_SFTP_AUTO_SYNC,
  STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES,
  STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_SESSION_LOGS_ENABLED,
  STORAGE_KEY_SESSION_LOGS_DIR,
  STORAGE_KEY_SESSION_LOGS_FORMAT,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
  STORAGE_KEY_CLOSE_TO_TRAY,
} from '../../infrastructure/config/storageKeys';
import { DEFAULT_UI_LOCALE, resolveSupportedLocale } from '../../infrastructure/config/i18n';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { useCustomThemes } from '../state/customThemeStore';
import { DEFAULT_FONT_SIZE } from '../../infrastructure/config/fonts';
import { DARK_UI_THEMES, LIGHT_UI_THEMES, UiThemeTokens, getUiThemeById } from '../../infrastructure/config/uiThemes';
import { UI_FONTS, DEFAULT_UI_FONT_ID } from '../../infrastructure/config/uiFonts';
import { uiFontStore, useUIFontsLoaded } from './uiFontStore';
import { useAvailableFonts } from './fontStore';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

const DEFAULT_THEME: 'light' | 'dark' = 'light';
const DEFAULT_LIGHT_UI_THEME = 'snow';
const DEFAULT_DARK_UI_THEME = 'midnight';
const DEFAULT_ACCENT_MODE: 'theme' | 'custom' = 'theme';
const DEFAULT_CUSTOM_ACCENT = '221.2 83.2% 53.3%';
const DEFAULT_TERMINAL_THEME = 'netcatty-dark';
const DEFAULT_FONT_FAMILY = 'menlo';
// Auto-detect default hotkey scheme based on platform
const DEFAULT_HOTKEY_SCHEME: HotkeyScheme =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? 'mac'
    : 'pc';
const DEFAULT_SFTP_DOUBLE_CLICK_BEHAVIOR: 'open' | 'transfer' = 'open';
const DEFAULT_SFTP_AUTO_SYNC = false;
const DEFAULT_SFTP_SHOW_HIDDEN_FILES = false;
const DEFAULT_SFTP_USE_COMPRESSED_UPLOAD = true;

// Editor defaults
const DEFAULT_EDITOR_WORD_WRAP = false;

// Session Logs defaults
const DEFAULT_SESSION_LOGS_ENABLED = false;
const DEFAULT_SESSION_LOGS_FORMAT: SessionLogFormat = 'txt';

const readStoredString = (key: string): string | null => {
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

const isValidTheme = (value: unknown): value is 'light' | 'dark' => value === 'light' || value === 'dark';

const isValidHslToken = (value: string): boolean => {
  // Expect: "<h> <s>% <l>%", e.g. "221.2 83.2% 53.3%"
  return /^\s*\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%\s*$/.test(value);
};

const isValidUiThemeId = (theme: 'light' | 'dark', value: string): boolean => {
  const list = theme === 'dark' ? DARK_UI_THEMES : LIGHT_UI_THEMES;
  return list.some((preset) => preset.id === value);
};

const isValidUiFontId = (value: string): boolean => {
  // Local fonts are always considered valid
  if (value.startsWith('local-')) return true;
  // Check bundled fonts first, then check dynamically loaded fonts
  return UI_FONTS.some((font) => font.id === value) ||
    uiFontStore.getAvailableFonts().some((font) => font.id === value);
};

const serializeTerminalSettings = (settings: TerminalSettings): string =>
  JSON.stringify(settings);

const areTerminalSettingsEqual = (a: TerminalSettings, b: TerminalSettings): boolean =>
  serializeTerminalSettings(a) === serializeTerminalSettings(b);

const applyThemeTokens = (
  theme: 'light' | 'dark',
  tokens: UiThemeTokens,
  accentMode: 'theme' | 'custom',
  accentOverride: string,
) => {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.setProperty('--background', tokens.background);
  root.style.setProperty('--foreground', tokens.foreground);
  root.style.setProperty('--card', tokens.card);
  root.style.setProperty('--card-foreground', tokens.cardForeground);
  root.style.setProperty('--popover', tokens.popover);
  root.style.setProperty('--popover-foreground', tokens.popoverForeground);
  const accentToken = accentMode === 'custom' ? accentOverride : tokens.accent;
  const accentLightness = parseFloat(accentToken.split(/\s+/)[2]?.replace('%', '') || '');
  const computedAccentForeground = theme === 'dark'
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
  netcattyBridge.get()?.setTheme?.(theme);
  netcattyBridge.get()?.setBackgroundColor?.(tokens.background);
};

export const useSettingsState = () => {
  const availableFonts = useAvailableFonts();
  const uiFontsLoaded = useUIFontsLoaded();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = readStoredString(STORAGE_KEY_THEME);
    return stored && isValidTheme(stored) ? stored : DEFAULT_THEME;
  });
  const [lightUiThemeId, setLightUiThemeId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_THEME_LIGHT);
    return stored && isValidUiThemeId('light', stored) ? stored : DEFAULT_LIGHT_UI_THEME;
  });
  const [darkUiThemeId, setDarkUiThemeId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_THEME_DARK);
    return stored && isValidUiThemeId('dark', stored) ? stored : DEFAULT_DARK_UI_THEME;
  });
  const [customAccent, setCustomAccent] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_COLOR);
    return stored && isValidHslToken(stored) ? stored.trim() : DEFAULT_CUSTOM_ACCENT;
  });
  const [accentMode, setAccentMode] = useState<'theme' | 'custom'>(() => {
    const stored = readStoredString(STORAGE_KEY_ACCENT_MODE);
    if (stored === 'theme' || stored === 'custom') return stored;
    const legacyColor = readStoredString(STORAGE_KEY_COLOR);
    return legacyColor && isValidHslToken(legacyColor) ? 'custom' : DEFAULT_ACCENT_MODE;
  });
  const [uiFontFamilyId, setUiFontFamilyId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_FONT_FAMILY);
    return stored && isValidUiFontId(stored) ? stored : DEFAULT_UI_FONT_ID;
  });
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(() => localStorageAdapter.read<SyncConfig>(STORAGE_KEY_SYNC));
  const [terminalThemeId, setTerminalThemeId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME) || DEFAULT_TERMINAL_THEME);
  const [terminalFontFamilyId, setTerminalFontFamilyId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_FAMILY) || DEFAULT_FONT_FAMILY);
  const [terminalFontSize, setTerminalFontSize] = useState<number>(() => localStorageAdapter.readNumber(STORAGE_KEY_TERM_FONT_SIZE) || DEFAULT_FONT_SIZE);
  const [uiLanguage, setUiLanguage] = useState<UILanguage>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_LANGUAGE);
    return resolveSupportedLocale(stored || DEFAULT_UI_LOCALE);
  });
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings>(() => {
    const stored = localStorageAdapter.read<TerminalSettings>(STORAGE_KEY_TERM_SETTINGS);
    return stored ? { ...DEFAULT_TERMINAL_SETTINGS, ...stored } : DEFAULT_TERMINAL_SETTINGS;
  });
  const [hotkeyScheme, setHotkeyScheme] = useState<HotkeyScheme>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_HOTKEY_SCHEME);
    // Validate stored value is a valid HotkeyScheme
    if (stored === 'disabled' || stored === 'mac' || stored === 'pc') {
      return stored;
    }
    return DEFAULT_HOTKEY_SCHEME;
  });
  const [customKeyBindings, setCustomKeyBindings] = useState<CustomKeyBindings>(() =>
    localStorageAdapter.read<CustomKeyBindings>(STORAGE_KEY_CUSTOM_KEY_BINDINGS) || {}
  );
  const [isHotkeyRecording, setIsHotkeyRecordingState] = useState(false);
  const [customCSS, setCustomCSS] = useState<string>(() =>
    localStorageAdapter.readString(STORAGE_KEY_CUSTOM_CSS) || ''
  );
  const [sftpDoubleClickBehavior, setSftpDoubleClickBehavior] = useState<'open' | 'transfer'>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR);
    return (stored === 'open' || stored === 'transfer') ? stored : DEFAULT_SFTP_DOUBLE_CLICK_BEHAVIOR;
  });
  const [sftpAutoSync, setSftpAutoSync] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_AUTO_SYNC);
    return stored === 'true' ? true : DEFAULT_SFTP_AUTO_SYNC;
  });
  const [sftpShowHiddenFiles, setSftpShowHiddenFiles] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES);
    return stored === 'true' ? true : DEFAULT_SFTP_SHOW_HIDDEN_FILES;
  });
  const [sftpUseCompressedUpload, setSftpUseCompressedUpload] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD);
    // 兼容旧的设置值
    if (stored === 'true' || stored === 'enabled' || stored === 'ask') return true;
    if (stored === 'false' || stored === 'disabled') return false;
    return DEFAULT_SFTP_USE_COMPRESSED_UPLOAD;
  });

  // Editor Settings
  const [editorWordWrap, setEditorWordWrapState] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_EDITOR_WORD_WRAP);
    return stored === 'true' ? true : DEFAULT_EDITOR_WORD_WRAP;
  });

  // Session Logs Settings
  const [sessionLogsEnabled, setSessionLogsEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SESSION_LOGS_ENABLED);
    return stored === 'true' ? true : DEFAULT_SESSION_LOGS_ENABLED;
  });
  const [sessionLogsDir, setSessionLogsDir] = useState<string>(() => {
    return readStoredString(STORAGE_KEY_SESSION_LOGS_DIR) || '';
  });
  const [sessionLogsFormat, setSessionLogsFormat] = useState<SessionLogFormat>(() => {
    const stored = readStoredString(STORAGE_KEY_SESSION_LOGS_FORMAT);
    if (stored === 'txt' || stored === 'raw' || stored === 'html') return stored;
    return DEFAULT_SESSION_LOGS_FORMAT;
  });

  // Global Toggle Window Settings (Quake Mode)
  const [toggleWindowHotkey, setToggleWindowHotkey] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY);
    if (stored !== null) return stored;
    // Default: Ctrl+` (Control+backtick) - similar to VS Code terminal toggle
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    return isMac ? '⌃ + `' : 'Ctrl + `';
  });
  const [closeToTray, setCloseToTray] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_CLOSE_TO_TRAY);
    // Default to true (enabled)
    if (stored === null) return true;
    return stored === 'true';
  });
  const [hotkeyRegistrationError, setHotkeyRegistrationError] = useState<string | null>(null);
  const incomingTerminalSettingsSignatureRef = useRef<string | null>(null);
  const localTerminalSettingsVersionRef = useRef(0);
  const broadcastedLocalTerminalSettingsVersionRef = useRef(0);

  const setTerminalSettings = useCallback((nextValue: SetStateAction<TerminalSettings>) => {
    setTerminalSettingsState((prev) => {
      const next = typeof nextValue === 'function'
        ? (nextValue as (prevState: TerminalSettings) => TerminalSettings)(prev)
        : nextValue;
      if (areTerminalSettingsEqual(prev, next)) {
        return prev;
      }
      localTerminalSettingsVersionRef.current += 1;
      return next;
    });
  }, []);

  const mergeIncomingTerminalSettings = useCallback((incoming: Partial<TerminalSettings>) => {
    setTerminalSettingsState((prev) => {
      const next = { ...prev, ...incoming };
      if (areTerminalSettingsEqual(prev, next)) {
        return prev;
      }
      // Mark the exact incoming snapshot so only this state is skipped for IPC rebroadcast.
      incomingTerminalSettingsSignatureRef.current = serializeTerminalSettings(next);
      return next;
    });
  }, []);

  // Helper to notify other windows about settings changes via IPC
  const notifySettingsChanged = useCallback((key: string, value: unknown) => {
    try {
      netcattyBridge.get()?.notifySettingsChanged?.({ key, value });
    } catch {
      // ignore - bridge may not be available
    }
  }, []);

  const syncAppearanceFromStorage = useCallback(() => {
    const storedTheme = readStoredString(STORAGE_KEY_THEME);
    const nextTheme = storedTheme && isValidTheme(storedTheme) ? storedTheme : theme;
    const storedLightId = readStoredString(STORAGE_KEY_UI_THEME_LIGHT);
    const nextLightId = storedLightId && isValidUiThemeId('light', storedLightId) ? storedLightId : lightUiThemeId;
    const storedDarkId = readStoredString(STORAGE_KEY_UI_THEME_DARK);
    const nextDarkId = storedDarkId && isValidUiThemeId('dark', storedDarkId) ? storedDarkId : darkUiThemeId;
    const storedAccentMode = readStoredString(STORAGE_KEY_ACCENT_MODE);
    const nextAccentMode = storedAccentMode === 'theme' || storedAccentMode === 'custom' ? storedAccentMode : accentMode;
    const storedAccent = readStoredString(STORAGE_KEY_COLOR);
    const nextAccent = storedAccent && isValidHslToken(storedAccent) ? storedAccent.trim() : customAccent;

    setTheme(nextTheme);
    setLightUiThemeId(nextLightId);
    setDarkUiThemeId(nextDarkId);
    setAccentMode(nextAccentMode);
    setCustomAccent(nextAccent);

    const tokens = getUiThemeById(nextTheme, nextTheme === 'dark' ? nextDarkId : nextLightId).tokens;
    applyThemeTokens(nextTheme, tokens, nextAccentMode, nextAccent);
  }, [theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent]);

  const syncCustomCssFromStorage = useCallback(() => {
    const storedCss = localStorageAdapter.readString(STORAGE_KEY_CUSTOM_CSS) || '';
    setCustomCSS((prev) => (prev === storedCss ? prev : storedCss));
  }, []);

  useLayoutEffect(() => {
    const tokens = getUiThemeById(theme, theme === 'dark' ? darkUiThemeId : lightUiThemeId).tokens;
    applyThemeTokens(theme, tokens, accentMode, customAccent);
    localStorageAdapter.writeString(STORAGE_KEY_THEME, theme);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
    localStorageAdapter.writeString(STORAGE_KEY_ACCENT_MODE, accentMode);
    localStorageAdapter.writeString(STORAGE_KEY_COLOR, customAccent);
    // Notify other windows
    notifySettingsChanged(STORAGE_KEY_THEME, theme);
    notifySettingsChanged(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    notifySettingsChanged(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
    notifySettingsChanged(STORAGE_KEY_ACCENT_MODE, accentMode);
    notifySettingsChanged(STORAGE_KEY_COLOR, customAccent);
  }, [theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent, notifySettingsChanged]);

  useLayoutEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
    document.documentElement.lang = uiLanguage;
    netcattyBridge.get()?.setLanguage?.(uiLanguage);
    notifySettingsChanged(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
  }, [uiLanguage, notifySettingsChanged]);

  // Apply and persist UI font family
  // Re-run when fonts finish loading to get correct family for local fonts
  useLayoutEffect(() => {
    const font = uiFontStore.getFontById(uiFontFamilyId);
    document.documentElement.style.setProperty('--font-sans', font.family);
    localStorageAdapter.writeString(STORAGE_KEY_UI_FONT_FAMILY, uiFontFamilyId);
    notifySettingsChanged(STORAGE_KEY_UI_FONT_FAMILY, uiFontFamilyId);
  }, [uiFontFamilyId, uiFontsLoaded, notifySettingsChanged]);

  // Listen for settings changes from other windows via IPC
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onSettingsChanged) return;
    const unsubscribe = bridge.onSettingsChanged((payload) => {
      const { key, value } = payload;
      if (
        key === STORAGE_KEY_THEME ||
        key === STORAGE_KEY_UI_THEME_LIGHT ||
        key === STORAGE_KEY_UI_THEME_DARK ||
        key === STORAGE_KEY_ACCENT_MODE ||
        key === STORAGE_KEY_COLOR
      ) {
        syncAppearanceFromStorage();
        return;
      }
      if (key === STORAGE_KEY_UI_LANGUAGE && typeof value === 'string') {
        const next = resolveSupportedLocale(value);
        setUiLanguage((prev) => (prev === next ? prev : next));
        document.documentElement.lang = next;
      }
      if (key === STORAGE_KEY_CUSTOM_CSS && typeof value === 'string') {
        syncCustomCssFromStorage();
      }
      if (key === STORAGE_KEY_UI_FONT_FAMILY && typeof value === 'string') {
        if (isValidUiFontId(value)) {
          setUiFontFamilyId(value);
        }
      }
      if (key === STORAGE_KEY_TERM_THEME && typeof value === 'string') {
        setTerminalThemeId(value);
      }
      if (key === STORAGE_KEY_TERM_FONT_FAMILY && typeof value === 'string') {
        setTerminalFontFamilyId(value);
      }
      if (key === STORAGE_KEY_TERM_FONT_SIZE && typeof value === 'number') {
        setTerminalFontSize(value);
      }
      if (key === STORAGE_KEY_TERM_SETTINGS) {
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value) as Partial<TerminalSettings>;
            mergeIncomingTerminalSettings(parsed);
          } catch {
            // ignore parse errors
          }
        } else if (value && typeof value === 'object') {
          mergeIncomingTerminalSettings(value as Partial<TerminalSettings>);
        }
      }
      if (key === STORAGE_KEY_EDITOR_WORD_WRAP && typeof value === 'boolean') {
        setEditorWordWrapState((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_HOTKEY_SCHEME && (value === 'disabled' || value === 'mac' || value === 'pc')) {
        setHotkeyScheme(value);
      }
      if (key === STORAGE_KEY_CUSTOM_KEY_BINDINGS) {
        if (typeof value === 'string') {
          try {
            setCustomKeyBindings(JSON.parse(value) as CustomKeyBindings);
          } catch {
            // ignore parse errors
          }
        } else if (value && typeof value === 'object') {
          setCustomKeyBindings(value as CustomKeyBindings);
        }
      }
      if (key === STORAGE_KEY_HOTKEY_RECORDING && typeof value === 'boolean') {
        setIsHotkeyRecordingState(value);
      }
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    };
  }, [mergeIncomingTerminalSettings, syncAppearanceFromStorage, syncCustomCssFromStorage]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onLanguageChanged) return;
    const unsubscribe = bridge.onLanguageChanged((language) => {
      if (typeof language !== 'string' || !language.length) return;
      const next = resolveSupportedLocale(language);
      setUiLanguage((prev) => (prev === next ? prev : next));
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // Listen for storage changes from other windows (cross-window sync)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_THEME && e.newValue) {
        if (isValidTheme(e.newValue) && e.newValue !== theme) {
          setTheme(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_THEME_LIGHT && e.newValue) {
        if (isValidUiThemeId('light', e.newValue) && e.newValue !== lightUiThemeId) {
          setLightUiThemeId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_THEME_DARK && e.newValue) {
        if (isValidUiThemeId('dark', e.newValue) && e.newValue !== darkUiThemeId) {
          setDarkUiThemeId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_ACCENT_MODE && e.newValue) {
        if ((e.newValue === 'theme' || e.newValue === 'custom') && e.newValue !== accentMode) {
          setAccentMode(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_COLOR && e.newValue) {
        if (isValidHslToken(e.newValue) && e.newValue !== customAccent) {
          setCustomAccent(e.newValue.trim());
        }
      }
      if (e.key === STORAGE_KEY_CUSTOM_CSS && e.newValue !== null) {
        if (e.newValue !== customCSS) {
          setCustomCSS(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_FONT_FAMILY && e.newValue) {
        if (isValidUiFontId(e.newValue) && e.newValue !== uiFontFamilyId) {
          setUiFontFamilyId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_HOTKEY_SCHEME && e.newValue) {
        const newScheme = e.newValue as HotkeyScheme;
        if (newScheme !== hotkeyScheme) {
          setHotkeyScheme(newScheme);
        }
      }
      if (e.key === STORAGE_KEY_UI_LANGUAGE && e.newValue) {
        const next = resolveSupportedLocale(e.newValue);
        if (next !== uiLanguage) {
          setUiLanguage(next as UILanguage);
        }
      }
      if (e.key === STORAGE_KEY_CUSTOM_KEY_BINDINGS && e.newValue) {
        try {
          const newBindings = JSON.parse(e.newValue) as CustomKeyBindings;
          setCustomKeyBindings(newBindings);
        } catch {
          // ignore parse errors
        }
      }
      // Sync terminal settings from other windows
      if (e.key === STORAGE_KEY_TERM_SETTINGS && e.newValue) {
        try {
          const newSettings = JSON.parse(e.newValue) as TerminalSettings;
          mergeIncomingTerminalSettings({ ...DEFAULT_TERMINAL_SETTINGS, ...newSettings });
        } catch {
          // ignore parse errors
        }
      }
      // Sync terminal theme from other windows
      if (e.key === STORAGE_KEY_TERM_THEME && e.newValue) {
        if (e.newValue !== terminalThemeId) {
          setTerminalThemeId(e.newValue);
        }
      }
      // Sync terminal font family from other windows
      if (e.key === STORAGE_KEY_TERM_FONT_FAMILY && e.newValue) {
        if (e.newValue !== terminalFontFamilyId) {
          setTerminalFontFamilyId(e.newValue);
        }
      }
      // Sync terminal font size from other windows
      if (e.key === STORAGE_KEY_TERM_FONT_SIZE && e.newValue) {
        const newSize = parseInt(e.newValue, 10);
        if (!isNaN(newSize) && newSize !== terminalFontSize) {
          setTerminalFontSize(newSize);
        }
      }
      // Sync SFTP double-click behavior from other windows
      if (e.key === STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR && e.newValue) {
        if ((e.newValue === 'open' || e.newValue === 'transfer') && e.newValue !== sftpDoubleClickBehavior) {
          setSftpDoubleClickBehavior(e.newValue);
        }
      }
      // Sync SFTP auto-sync setting from other windows
      if (e.key === STORAGE_KEY_SFTP_AUTO_SYNC && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== sftpAutoSync) {
          setSftpAutoSync(newValue);
        }
      }
      // Sync SFTP show hidden files setting from other windows
      if (e.key === STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== sftpShowHiddenFiles) {
          setSftpShowHiddenFiles(newValue);
        }
      }
      if (e.key === STORAGE_KEY_EDITOR_WORD_WRAP && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== editorWordWrap) {
          setEditorWordWrapState(newValue);
        }
      }
      // Sync SFTP compressed upload setting from other windows
      if (e.key === STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD && e.newValue !== null) {
        const newValue = e.newValue === 'true' || e.newValue === 'enabled';
        if (newValue !== sftpUseCompressedUpload) {
          setSftpUseCompressedUpload(newValue);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent, customCSS, uiFontFamilyId, hotkeyScheme, uiLanguage, terminalThemeId, terminalFontFamilyId, terminalFontSize, sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles, sftpUseCompressedUpload, editorWordWrap, mergeIncomingTerminalSettings]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME, terminalThemeId);
    notifySettingsChanged(STORAGE_KEY_TERM_THEME, terminalThemeId);
  }, [terminalThemeId, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_FAMILY, terminalFontFamilyId);
    notifySettingsChanged(STORAGE_KEY_TERM_FONT_FAMILY, terminalFontFamilyId);
  }, [terminalFontFamilyId, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeNumber(STORAGE_KEY_TERM_FONT_SIZE, terminalFontSize);
    notifySettingsChanged(STORAGE_KEY_TERM_FONT_SIZE, terminalFontSize);
  }, [terminalFontSize, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.write(STORAGE_KEY_TERM_SETTINGS, terminalSettings);
    const currentSignature = serializeTerminalSettings(terminalSettings);
    const hasPendingUnbroadcastLocalChanges =
      localTerminalSettingsVersionRef.current !== broadcastedLocalTerminalSettingsVersionRef.current;
    if (incomingTerminalSettingsSignatureRef.current === currentSignature && !hasPendingUnbroadcastLocalChanges) {
      incomingTerminalSettingsSignatureRef.current = null;
      return;
    }
    incomingTerminalSettingsSignatureRef.current = null;
    notifySettingsChanged(STORAGE_KEY_TERM_SETTINGS, terminalSettings);
    broadcastedLocalTerminalSettingsVersionRef.current = localTerminalSettingsVersionRef.current;
  }, [terminalSettings, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_HOTKEY_SCHEME, hotkeyScheme);
    notifySettingsChanged(STORAGE_KEY_HOTKEY_SCHEME, hotkeyScheme);
  }, [hotkeyScheme, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.write(STORAGE_KEY_CUSTOM_KEY_BINDINGS, customKeyBindings);
    notifySettingsChanged(STORAGE_KEY_CUSTOM_KEY_BINDINGS, customKeyBindings);
  }, [customKeyBindings, notifySettingsChanged]);

  const setIsHotkeyRecording = useCallback((isRecording: boolean) => {
    setIsHotkeyRecordingState(isRecording);
    notifySettingsChanged(STORAGE_KEY_HOTKEY_RECORDING, isRecording);
  }, [notifySettingsChanged]);

  // Apply and persist custom CSS
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_CSS, customCSS);
    notifySettingsChanged(STORAGE_KEY_CUSTOM_CSS, customCSS);

    // Apply custom CSS to document
    let styleEl = document.getElementById('netcatty-custom-css') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'netcatty-custom-css';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = customCSS;
  }, [customCSS, notifySettingsChanged]);

  // Persist SFTP double-click behavior
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, sftpDoubleClickBehavior);
    notifySettingsChanged(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, sftpDoubleClickBehavior);
  }, [sftpDoubleClickBehavior, notifySettingsChanged]);

  // Persist SFTP auto-sync setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_SYNC, sftpAutoSync ? 'true' : 'false');
    notifySettingsChanged(STORAGE_KEY_SFTP_AUTO_SYNC, sftpAutoSync);
  }, [sftpAutoSync, notifySettingsChanged]);

  // Persist SFTP show hidden files setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, sftpShowHiddenFiles ? 'true' : 'false');
    notifySettingsChanged(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, sftpShowHiddenFiles);
  }, [sftpShowHiddenFiles, notifySettingsChanged]);

  // Persist SFTP compressed upload setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, sftpUseCompressedUpload ? 'true' : 'false');
    notifySettingsChanged(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, sftpUseCompressedUpload);
  }, [sftpUseCompressedUpload, notifySettingsChanged]);

  // Persist Session Logs settings
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_ENABLED, sessionLogsEnabled ? 'true' : 'false');
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_ENABLED, sessionLogsEnabled);
  }, [sessionLogsEnabled, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_DIR, sessionLogsDir);
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_DIR, sessionLogsDir);
  }, [sessionLogsDir, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_FORMAT, sessionLogsFormat);
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_FORMAT, sessionLogsFormat);
  }, [sessionLogsFormat, notifySettingsChanged]);

  // Persist and sync toggle window hotkey setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    notifySettingsChanged(STORAGE_KEY_TOGGLE_WINDOW_HOTKEY, toggleWindowHotkey);
    // Register/unregister the global hotkey in main process
    const bridge = netcattyBridge.get();
    if (bridge?.registerGlobalHotkey) {
      if (toggleWindowHotkey) {
        setHotkeyRegistrationError(null);
        bridge
          .registerGlobalHotkey(toggleWindowHotkey)
          .then((result) => {
            if (result?.success === false) {
              console.warn('[GlobalHotkey] Hotkey registration failed:', result.error);
              setHotkeyRegistrationError(result.error || 'Failed to register hotkey');
            }
          })
          .catch((err) => {
            console.warn('[GlobalHotkey] Failed to register hotkey:', err);
            setHotkeyRegistrationError(err?.message || 'Failed to register hotkey');
          });
      } else {
        setHotkeyRegistrationError(null);
        bridge.unregisterGlobalHotkey?.().catch((err) => {
          console.warn('[GlobalHotkey] Failed to unregister hotkey:', err);
        });
      }
    }
  }, [toggleWindowHotkey, notifySettingsChanged]);

  // Persist and sync close to tray setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_CLOSE_TO_TRAY, closeToTray ? 'true' : 'false');
    notifySettingsChanged(STORAGE_KEY_CLOSE_TO_TRAY, closeToTray);
    // Update main process tray behavior
    const bridge = netcattyBridge.get();
    if (bridge?.setCloseToTray) {
      bridge.setCloseToTray(closeToTray).catch((err) => {
        console.warn('[SystemTray] Failed to set close-to-tray:', err);
      });
    }
  }, [closeToTray, notifySettingsChanged]);

  // Get merged key bindings (defaults + custom overrides)
  const keyBindings = useMemo((): KeyBinding[] => {
    return DEFAULT_KEY_BINDINGS.map(binding => {
      const custom = customKeyBindings[binding.id];
      if (!custom) return binding;
      return {
        ...binding,
        mac: custom.mac ?? binding.mac,
        pc: custom.pc ?? binding.pc,
      };
    });
  }, [customKeyBindings]);

  // Update a single key binding
  const updateKeyBinding = useCallback((bindingId: string, scheme: 'mac' | 'pc', newKey: string) => {
    setCustomKeyBindings(prev => ({
      ...prev,
      [bindingId]: {
        ...prev[bindingId],
        [scheme]: newKey,
      },
    }));
  }, []);

  // Reset a key binding to default
  const resetKeyBinding = useCallback((bindingId: string, scheme?: 'mac' | 'pc') => {
    setCustomKeyBindings(prev => {
      const next = { ...prev };
      if (scheme) {
        if (next[bindingId]) {
          delete next[bindingId][scheme];
          if (Object.keys(next[bindingId]).length === 0) {
            delete next[bindingId];
          }
        }
      } else {
        delete next[bindingId];
      }
      return next;
    });
  }, []);

  // Reset all key bindings to defaults
  const resetAllKeyBindings = useCallback(() => {
    setCustomKeyBindings({});
  }, []);

  const updateSyncConfig = useCallback((config: SyncConfig | null) => {
    setSyncConfig(config);
    localStorageAdapter.write(STORAGE_KEY_SYNC, config);
  }, []);

  // Subscribe to custom theme changes so editing in-place triggers re-render
  const customThemes = useCustomThemes();

  const currentTerminalTheme = useMemo(
    () => TERMINAL_THEMES.find(t => t.id === terminalThemeId)
      || customThemes.find(t => t.id === terminalThemeId)
      || TERMINAL_THEMES[0],
    [terminalThemeId, customThemes]
  );

  const currentTerminalFont = useMemo(
    () => availableFonts.find(f => f.id === terminalFontFamilyId) || availableFonts[0],
    [terminalFontFamilyId, availableFonts]
  );

  const updateTerminalSetting = useCallback(<K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K]
  ) => {
    setTerminalSettings(prev => ({ ...prev, [key]: value }));
  }, [setTerminalSettings]);

  return {
    theme,
    setTheme,
    lightUiThemeId,
    setLightUiThemeId,
    darkUiThemeId,
    setDarkUiThemeId,
    accentMode,
    setAccentMode,
    customAccent,
    setCustomAccent,
    uiFontFamilyId,
    setUiFontFamilyId,
    syncConfig,
    updateSyncConfig,
    uiLanguage,
    setUiLanguage,
    terminalThemeId,
    setTerminalThemeId,
    currentTerminalTheme,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    currentTerminalFont,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    setTerminalSettings,
    updateTerminalSetting,
    hotkeyScheme,
    setHotkeyScheme,
    keyBindings,
    customKeyBindings,
    updateKeyBinding,
    resetKeyBinding,
    resetAllKeyBindings,
    isHotkeyRecording,
    setIsHotkeyRecording,
    customCSS,
    setCustomCSS,
    sftpDoubleClickBehavior,
    setSftpDoubleClickBehavior,
    sftpAutoSync,
    setSftpAutoSync,
    sftpShowHiddenFiles,
    setSftpShowHiddenFiles,
    sftpUseCompressedUpload,
    setSftpUseCompressedUpload,
    // Editor Settings
    editorWordWrap,
    setEditorWordWrap: useCallback((enabled: boolean) => {
      setEditorWordWrapState(enabled);
      localStorageAdapter.writeString(STORAGE_KEY_EDITOR_WORD_WRAP, String(enabled));
      notifySettingsChanged(STORAGE_KEY_EDITOR_WORD_WRAP, enabled);
    }, [notifySettingsChanged]),
    availableFonts,
    // Session Logs
    sessionLogsEnabled,
    setSessionLogsEnabled,
    sessionLogsDir,
    setSessionLogsDir,
    sessionLogsFormat,
    setSessionLogsFormat,
    // Global Toggle Window (Quake Mode)
    toggleWindowHotkey,
    setToggleWindowHotkey,
    closeToTray,
    setCloseToTray,
    hotkeyRegistrationError,
  };
};
