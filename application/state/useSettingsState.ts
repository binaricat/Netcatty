import { useCallback,useEffect,useLayoutEffect,useMemo,useState } from 'react';
import { SyncConfig, TerminalSettings, DEFAULT_TERMINAL_SETTINGS, HotkeyScheme, CustomKeyBindings, DEFAULT_KEY_BINDINGS, KeyBinding, UILanguage } from '../../domain/models';
import {
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
STORAGE_KEY_UI_THEME_LIGHT,
STORAGE_KEY_UI_THEME_DARK,
} from '../../infrastructure/config/storageKeys';
import { DEFAULT_UI_LOCALE, resolveSupportedLocale } from '../../infrastructure/config/i18n';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { TERMINAL_FONTS, DEFAULT_FONT_SIZE } from '../../infrastructure/config/fonts';
import { DARK_UI_THEMES, LIGHT_UI_THEMES, UiThemeTokens, getUiThemeById } from '../../infrastructure/config/uiThemes';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

const DEFAULT_THEME: 'light' | 'dark' = 'light';
const DEFAULT_LIGHT_UI_THEME = 'snow';
const DEFAULT_DARK_UI_THEME = 'midnight';
const DEFAULT_TERMINAL_THEME = 'netcatty-dark';
const DEFAULT_FONT_FAMILY = 'menlo';
// Auto-detect default hotkey scheme based on platform
const DEFAULT_HOTKEY_SCHEME: HotkeyScheme = 
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) 
    ? 'mac' 
    : 'pc';

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

const isValidUiThemeId = (theme: 'light' | 'dark', value: string): boolean => {
  const list = theme === 'dark' ? DARK_UI_THEMES : LIGHT_UI_THEMES;
  return list.some((preset) => preset.id === value);
};

const applyThemeTokens = (theme: 'light' | 'dark', tokens: UiThemeTokens) => {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.setProperty('--background', tokens.background);
  root.style.setProperty('--foreground', tokens.foreground);
  root.style.setProperty('--card', tokens.card);
  root.style.setProperty('--card-foreground', tokens.cardForeground);
  root.style.setProperty('--popover', tokens.popover);
  root.style.setProperty('--popover-foreground', tokens.popoverForeground);
  root.style.setProperty('--primary', tokens.primary);
  root.style.setProperty('--primary-foreground', tokens.primaryForeground);
  root.style.setProperty('--secondary', tokens.secondary);
  root.style.setProperty('--secondary-foreground', tokens.secondaryForeground);
  root.style.setProperty('--muted', tokens.muted);
  root.style.setProperty('--muted-foreground', tokens.mutedForeground);
  root.style.setProperty('--accent', tokens.accent);
  root.style.setProperty('--accent-foreground', tokens.accentForeground);
  root.style.setProperty('--destructive', tokens.destructive);
  root.style.setProperty('--destructive-foreground', tokens.destructiveForeground);
  root.style.setProperty('--border', tokens.border);
  root.style.setProperty('--input', tokens.input);
  root.style.setProperty('--ring', tokens.ring);
  
  // Sync with native window title bar (Electron)
  netcattyBridge.get()?.setTheme?.(theme);
  netcattyBridge.get()?.setBackgroundColor?.(tokens.background);
};

export const useSettingsState = () => {
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
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(() => localStorageAdapter.read<SyncConfig>(STORAGE_KEY_SYNC));
  const [terminalThemeId, setTerminalThemeId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME) || DEFAULT_TERMINAL_THEME);
  const [terminalFontFamilyId, setTerminalFontFamilyId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_FAMILY) || DEFAULT_FONT_FAMILY);
  const [terminalFontSize, setTerminalFontSize] = useState<number>(() => localStorageAdapter.readNumber(STORAGE_KEY_TERM_FONT_SIZE) || DEFAULT_FONT_SIZE);
  const [uiLanguage, setUiLanguage] = useState<UILanguage>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_LANGUAGE);
    return resolveSupportedLocale(stored || DEFAULT_UI_LOCALE);
  });
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>(() => {
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

  // Helper to notify other windows about settings changes via IPC
  const notifySettingsChanged = useCallback((key: string, value: unknown) => {
    try {
      netcattyBridge.get()?.notifySettingsChanged?.({ key, value });
    } catch {
      // ignore - bridge may not be available
    }
  }, []);

  useLayoutEffect(() => {
    const tokens = getUiThemeById(theme, theme === 'dark' ? darkUiThemeId : lightUiThemeId).tokens;
    applyThemeTokens(theme, tokens);
    localStorageAdapter.writeString(STORAGE_KEY_THEME, theme);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
    // Notify other windows
    notifySettingsChanged(STORAGE_KEY_THEME, theme);
    notifySettingsChanged(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    notifySettingsChanged(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
  }, [theme, lightUiThemeId, darkUiThemeId, notifySettingsChanged]);

  useLayoutEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
    document.documentElement.lang = uiLanguage;
    netcattyBridge.get()?.setLanguage?.(uiLanguage);
    notifySettingsChanged(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
  }, [uiLanguage, notifySettingsChanged]);

  // Listen for settings changes from other windows via IPC
	  useEffect(() => {
	    const bridge = netcattyBridge.get();
	    if (!bridge?.onSettingsChanged) return;
	    const unsubscribe = bridge.onSettingsChanged((payload) => {
	      const { key, value } = payload;
      if (key === STORAGE_KEY_THEME && (value === 'light' || value === 'dark')) {
        setTheme(value);
        const tokens = getUiThemeById(value, value === 'dark' ? darkUiThemeId : lightUiThemeId).tokens;
        applyThemeTokens(value, tokens);
      }
      if (key === STORAGE_KEY_UI_THEME_LIGHT && typeof value === 'string' && isValidUiThemeId('light', value)) {
        setLightUiThemeId(value);
        if (theme === 'light') {
          const tokens = getUiThemeById('light', value).tokens;
          applyThemeTokens('light', tokens);
        }
      }
      if (key === STORAGE_KEY_UI_THEME_DARK && typeof value === 'string' && isValidUiThemeId('dark', value)) {
        setDarkUiThemeId(value);
        if (theme === 'dark') {
          const tokens = getUiThemeById('dark', value).tokens;
          applyThemeTokens('dark', tokens);
        }
      }
      if (key === STORAGE_KEY_UI_LANGUAGE && typeof value === 'string') {
        const next = resolveSupportedLocale(value);
        setUiLanguage((prev) => (prev === next ? prev : next));
	        document.documentElement.lang = next;
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
  }, [theme, lightUiThemeId, darkUiThemeId]);

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
      if (e.key === STORAGE_KEY_CUSTOM_CSS && e.newValue !== null) {
        if (e.newValue !== customCSS) {
          setCustomCSS(e.newValue);
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
	          setTerminalSettings(_prev => ({ ...DEFAULT_TERMINAL_SETTINGS, ...newSettings }));
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
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [theme, lightUiThemeId, darkUiThemeId, customCSS, hotkeyScheme, uiLanguage, terminalThemeId, terminalFontFamilyId, terminalFontSize]);

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
  }, [terminalSettings]);

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
    
    // Apply custom CSS to document
    let styleEl = document.getElementById('netcatty-custom-css') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'netcatty-custom-css';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = customCSS;
  }, [customCSS]);

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

  const currentTerminalTheme = useMemo(
    () => TERMINAL_THEMES.find(t => t.id === terminalThemeId) || TERMINAL_THEMES[0],
    [terminalThemeId]
  );

  const currentTerminalFont = useMemo(
    () => TERMINAL_FONTS.find(f => f.id === terminalFontFamilyId) || TERMINAL_FONTS[0],
    [terminalFontFamilyId]
  );

  const updateTerminalSetting = useCallback(<K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K]
  ) => {
    setTerminalSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  return {
    theme,
    setTheme,
    lightUiThemeId,
    setLightUiThemeId,
    darkUiThemeId,
    setDarkUiThemeId,
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
  };
};
