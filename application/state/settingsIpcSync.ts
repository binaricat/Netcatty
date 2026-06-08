import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { CustomKeyBindings, HotkeyScheme, SessionLogFormat, TerminalSettings, UILanguage } from '../../domain/models';
import { parseCustomKeyBindingsStorageRecord } from '../../domain/customKeyBindings';
import { resolveSupportedLocale } from '../../infrastructure/config/i18n';
import {
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_COLOR,
  STORAGE_KEY_CUSTOM_CSS,
  STORAGE_KEY_CUSTOM_KEY_BINDINGS,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_HOTKEY_RECORDING,
  STORAGE_KEY_HOTKEY_SCHEME,
  STORAGE_KEY_SESSION_LOGS_DIR,
  STORAGE_KEY_SESSION_LOGS_ENABLED,
  STORAGE_KEY_SESSION_LOGS_FORMAT,
  STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED,
  STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED,
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE,
  STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY,
  STORAGE_KEY_TERM_FOLLOW_APP_THEME,
  STORAGE_KEY_TERM_FONT_FAMILY,
  STORAGE_KEY_TERM_FONT_SIZE,
  STORAGE_KEY_TERM_SETTINGS,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_TERM_THEME_DARK,
  STORAGE_KEY_TERM_THEME_LIGHT,
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_FONT_FAMILY,
  STORAGE_KEY_UI_LANGUAGE,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_UI_THEME_LIGHT,
  STORAGE_KEY_WORKSPACE_FOCUS_STYLE,
  STORAGE_KEY_WINDOW_OPACITY,
} from '../../infrastructure/config/storageKeys';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  clampWindowOpacity,
  isValidUiFontId,
  migrateIncomingTerminalFontId,
} from './settingsStateDefaults';

interface UseSettingsIpcSyncParams {
  syncAppearanceFromStorage: () => void;
  syncCustomCssFromStorage: () => void;
  setUiLanguage: Dispatch<SetStateAction<UILanguage>>;
  setUiFontFamilyId: Dispatch<SetStateAction<string>>;
  setTerminalThemeId: Dispatch<SetStateAction<string>>;
  setTerminalThemeDarkId: Dispatch<SetStateAction<string>>;
  setTerminalThemeLightId: Dispatch<SetStateAction<string>>;
  setFollowAppTerminalThemeState: Dispatch<SetStateAction<boolean>>;
  setTerminalFontFamilyId: Dispatch<SetStateAction<string>>;
  setTerminalFontSize: Dispatch<SetStateAction<number>>;
  mergeIncomingTerminalSettings: (incoming: Partial<TerminalSettings>) => void;
  setEditorWordWrapState: Dispatch<SetStateAction<boolean>>;
  setSessionLogsEnabled: Dispatch<SetStateAction<boolean>>;
  setSessionLogsDir: Dispatch<SetStateAction<string>>;
  setSessionLogsFormat: Dispatch<SetStateAction<SessionLogFormat>>;
  setSessionLogsTimestampsEnabled: Dispatch<SetStateAction<boolean>>;
  setSshDebugLogsEnabled: Dispatch<SetStateAction<boolean>>;
  setHotkeyScheme: Dispatch<SetStateAction<HotkeyScheme>>;
  applyIncomingCustomKeyBindings: (incoming: { bindings: CustomKeyBindings; version: number; origin: string }) => void;
  setIsHotkeyRecordingState: Dispatch<SetStateAction<boolean>>;
  setGlobalHotkeyEnabled: Dispatch<SetStateAction<boolean>>;
  setWindowOpacity: Dispatch<SetStateAction<number>>;
  setAutoUpdateEnabled: Dispatch<SetStateAction<boolean>>;
  setSftpAutoOpenSidebar: Dispatch<SetStateAction<boolean>>;
  setSftpDefaultViewMode: Dispatch<SetStateAction<'list' | 'tree'>>;
  setWorkspaceFocusStyleState: Dispatch<SetStateAction<'dim' | 'border'>>;
  setSftpTransferConcurrencyState: Dispatch<SetStateAction<number>>;
}

export function useSettingsIpcSync({
  syncAppearanceFromStorage,
  syncCustomCssFromStorage,
  setUiLanguage,
  setUiFontFamilyId,
  setTerminalThemeId,
  setTerminalThemeDarkId,
  setTerminalThemeLightId,
  setFollowAppTerminalThemeState,
  setTerminalFontFamilyId,
  setTerminalFontSize,
  mergeIncomingTerminalSettings,
  setEditorWordWrapState,
  setSessionLogsEnabled,
  setSessionLogsDir,
  setSessionLogsFormat,
  setSessionLogsTimestampsEnabled,
  setSshDebugLogsEnabled,
  setHotkeyScheme,
  applyIncomingCustomKeyBindings,
  setIsHotkeyRecordingState,
  setGlobalHotkeyEnabled,
  setWindowOpacity,
  setAutoUpdateEnabled,
  setSftpAutoOpenSidebar,
  setSftpDefaultViewMode,
  setWorkspaceFocusStyleState,
  setSftpTransferConcurrencyState,
}: UseSettingsIpcSyncParams) {
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
      if (key === STORAGE_KEY_TERM_THEME_DARK && typeof value === 'string') {
        setTerminalThemeDarkId(value);
      }
      if (key === STORAGE_KEY_TERM_THEME_LIGHT && typeof value === 'string') {
        setTerminalThemeLightId(value);
      }
      if (key === STORAGE_KEY_TERM_FOLLOW_APP_THEME) {
        const next = value === true || value === 'true';
        setFollowAppTerminalThemeState((prev) => (prev === next ? prev : next));
      }
      if (key === STORAGE_KEY_TERM_FONT_FAMILY && typeof value === 'string') {
        const migrated = migrateIncomingTerminalFontId(value);
        if (migrated) setTerminalFontFamilyId(migrated);
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
      if (key === STORAGE_KEY_SESSION_LOGS_ENABLED && typeof value === 'boolean') {
        setSessionLogsEnabled((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SESSION_LOGS_DIR && typeof value === 'string') {
        setSessionLogsDir((prev) => (prev === value ? prev : value));
      }
      if (
        key === STORAGE_KEY_SESSION_LOGS_FORMAT &&
        (value === 'txt' || value === 'raw' || value === 'html')
      ) {
        setSessionLogsFormat((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED && typeof value === 'boolean') {
        setSessionLogsTimestampsEnabled((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED && typeof value === 'boolean') {
        setSshDebugLogsEnabled((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_HOTKEY_SCHEME && (value === 'disabled' || value === 'mac' || value === 'pc')) {
        setHotkeyScheme(value);
      }
      if (key === STORAGE_KEY_CUSTOM_KEY_BINDINGS) {
        const parsed = parseCustomKeyBindingsStorageRecord(value);
        if (parsed) {
          applyIncomingCustomKeyBindings(parsed);
        }
      }
      if (key === STORAGE_KEY_HOTKEY_RECORDING && typeof value === 'boolean') {
        setIsHotkeyRecordingState(value);
      }
      if (key === STORAGE_KEY_GLOBAL_HOTKEY_ENABLED && typeof value === 'boolean') {
        setGlobalHotkeyEnabled((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_WINDOW_OPACITY && (typeof value === 'number' || typeof value === 'string')) {
        const nextOpacity = clampWindowOpacity(value);
        setWindowOpacity((prev) => (prev === nextOpacity ? prev : nextOpacity));
      }
      if (key === STORAGE_KEY_AUTO_UPDATE_ENABLED && typeof value === 'boolean') {
        setAutoUpdateEnabled((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR && typeof value === 'boolean') {
        setSftpAutoOpenSidebar((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE && typeof value === 'string') {
        if (value === 'list' || value === 'tree') {
          setSftpDefaultViewMode((prev) => (prev === value ? prev : value));
        }
      }
      if (key === STORAGE_KEY_WORKSPACE_FOCUS_STYLE && (value === 'dim' || value === 'border')) {
        setWorkspaceFocusStyleState((prev) => (prev === value ? prev : value));
      }
      if (key === STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY && typeof value === 'number') {
        setSftpTransferConcurrencyState((prev) => (prev === value ? prev : value));
      }
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    };
  }, [
    applyIncomingCustomKeyBindings,
    mergeIncomingTerminalSettings,
    setAutoUpdateEnabled,
    setEditorWordWrapState,
    setFollowAppTerminalThemeState,
    setGlobalHotkeyEnabled,
    setWindowOpacity,
    setHotkeyScheme,
    setIsHotkeyRecordingState,
    setSessionLogsDir,
    setSessionLogsEnabled,
    setSessionLogsFormat,
    setSessionLogsTimestampsEnabled,
    setSshDebugLogsEnabled,
    setSftpAutoOpenSidebar,
    setSftpDefaultViewMode,
    setSftpTransferConcurrencyState,
    setTerminalFontFamilyId,
    setTerminalFontSize,
    setTerminalThemeDarkId,
    setTerminalThemeId,
    setTerminalThemeLightId,
    setUiFontFamilyId,
    setUiLanguage,
    setWorkspaceFocusStyleState,
    syncAppearanceFromStorage,
    syncCustomCssFromStorage,
  ]);


}
