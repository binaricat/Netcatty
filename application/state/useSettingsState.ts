import { useEffect, useMemo, useState } from 'react';
import { SyncConfig } from '../../domain/models';
import {
  STORAGE_KEY_COLOR,
  STORAGE_KEY_SYNC,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_THEME,
} from '../../infrastructure/config/storageKeys';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

const DEFAULT_COLOR = '221.2 83.2% 53.3%';
const DEFAULT_THEME: 'light' | 'dark' = 'light';
const DEFAULT_TERMINAL_THEME = 'termius-dark';

const applyThemeTokens = (theme: 'light' | 'dark', primaryColor: string) => {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.setProperty('--primary', primaryColor);
  root.style.setProperty('--accent', primaryColor);
  root.style.setProperty('--ring', primaryColor);
  const lightness = parseFloat(primaryColor.split(/\s+/)[2]?.replace('%', '') || '');
  const accentForeground = theme === 'dark'
    ? '220 40% 96%'
    : (!Number.isNaN(lightness) && lightness < 55 ? '0 0% 98%' : '222 47% 12%');
  root.style.setProperty('--accent-foreground', accentForeground);
};

export const useSettingsState = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorageAdapter.readString(STORAGE_KEY_THEME) as 'dark' | 'light') || DEFAULT_THEME);
  const [primaryColor, setPrimaryColor] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_COLOR) || DEFAULT_COLOR);
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(() => localStorageAdapter.read<SyncConfig>(STORAGE_KEY_SYNC));
  const [terminalThemeId, setTerminalThemeId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME) || DEFAULT_TERMINAL_THEME);

  useEffect(() => {
    applyThemeTokens(theme, primaryColor);
    localStorageAdapter.writeString(STORAGE_KEY_THEME, theme);
    localStorageAdapter.writeString(STORAGE_KEY_COLOR, primaryColor);
  }, [theme, primaryColor]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME, terminalThemeId);
  }, [terminalThemeId]);

  const updateSyncConfig = (config: SyncConfig | null) => {
    setSyncConfig(config);
    localStorageAdapter.write(STORAGE_KEY_SYNC, config);
  };

  const currentTerminalTheme = useMemo(
    () => TERMINAL_THEMES.find(t => t.id === terminalThemeId) || TERMINAL_THEMES[0],
    [terminalThemeId]
  );

  return {
    theme,
    setTheme,
    primaryColor,
    setPrimaryColor,
    syncConfig,
    updateSyncConfig,
    terminalThemeId,
    setTerminalThemeId,
    currentTerminalTheme,
  };
};
