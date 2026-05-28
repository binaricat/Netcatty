import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
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
  STORAGE_KEY_HOTKEY_SCHEME,
  STORAGE_KEY_SESSION_LOGS_DIR,
  STORAGE_KEY_SESSION_LOGS_ENABLED,
  STORAGE_KEY_SESSION_LOGS_FORMAT,
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_SFTP_AUTO_SYNC,
  STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE,
  STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR,
  STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES,
  STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY,
  STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD,
  STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
  STORAGE_KEY_SHOW_RECENT_HOSTS,
  STORAGE_KEY_SHOW_SFTP_TAB,
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
} from '../../infrastructure/config/storageKeys';
import {
  isValidHslToken,
  isValidTheme,
  isValidUiFontId,
  isValidUiThemeId,
  migrateIncomingTerminalFontId,
} from './settingsStateDefaults';

interface UseSettingsStorageSyncParams {
  theme: 'dark' | 'light' | 'system';
  lightUiThemeId: string;
  darkUiThemeId: string;
  accentMode: 'theme' | 'custom';
  customAccent: string;
  customCSS: string;
  uiFontFamilyId: string;
  hotkeyScheme: HotkeyScheme;
  uiLanguage: UILanguage;
  terminalThemeId: string;
  followAppTerminalTheme: boolean;
  terminalFontFamilyId: string;
  terminalFontSize: number;
  sftpDoubleClickBehavior: 'open' | 'transfer';
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  sftpAutoOpenSidebar: boolean;
  sftpDefaultViewMode: 'list' | 'tree';
  showRecentHosts: boolean;
  showOnlyUngroupedHostsInRoot: boolean;
  showSftpTab: boolean;
  editorWordWrap: boolean;
  sessionLogsEnabled: boolean;
  sessionLogsDir: string;
  sessionLogsFormat: SessionLogFormat;
  globalHotkeyEnabled: boolean;
  autoUpdateEnabled: boolean;
  setTheme: Dispatch<SetStateAction<'dark' | 'light' | 'system'>>;
  setLightUiThemeId: Dispatch<SetStateAction<string>>;
  setDarkUiThemeId: Dispatch<SetStateAction<string>>;
  setAccentMode: Dispatch<SetStateAction<'theme' | 'custom'>>;
  setCustomAccent: Dispatch<SetStateAction<string>>;
  setCustomCSS: Dispatch<SetStateAction<string>>;
  setUiFontFamilyId: Dispatch<SetStateAction<string>>;
  setHotkeyScheme: Dispatch<SetStateAction<HotkeyScheme>>;
  setUiLanguage: Dispatch<SetStateAction<UILanguage>>;
  setTerminalThemeId: Dispatch<SetStateAction<string>>;
  setTerminalThemeDarkId: Dispatch<SetStateAction<string>>;
  setTerminalThemeLightId: Dispatch<SetStateAction<string>>;
  setFollowAppTerminalThemeState: Dispatch<SetStateAction<boolean>>;
  setTerminalFontFamilyId: Dispatch<SetStateAction<string>>;
  setTerminalFontSize: Dispatch<SetStateAction<number>>;
  setSftpDoubleClickBehavior: Dispatch<SetStateAction<'open' | 'transfer'>>;
  setSftpAutoSync: Dispatch<SetStateAction<boolean>>;
  setSftpShowHiddenFiles: Dispatch<SetStateAction<boolean>>;
  setSftpUseCompressedUpload: Dispatch<SetStateAction<boolean>>;
  setSftpAutoOpenSidebar: Dispatch<SetStateAction<boolean>>;
  setSftpDefaultViewMode: Dispatch<SetStateAction<'list' | 'tree'>>;
  setShowRecentHostsState: Dispatch<SetStateAction<boolean>>;
  setShowOnlyUngroupedHostsInRootState: Dispatch<SetStateAction<boolean>>;
  setShowSftpTabState: Dispatch<SetStateAction<boolean>>;
  setEditorWordWrapState: Dispatch<SetStateAction<boolean>>;
  setSessionLogsEnabled: Dispatch<SetStateAction<boolean>>;
  setSessionLogsDir: Dispatch<SetStateAction<string>>;
  setSessionLogsFormat: Dispatch<SetStateAction<SessionLogFormat>>;
  setGlobalHotkeyEnabled: Dispatch<SetStateAction<boolean>>;
  setAutoUpdateEnabled: Dispatch<SetStateAction<boolean>>;
  setWorkspaceFocusStyleState: Dispatch<SetStateAction<'dim' | 'border'>>;
  setSftpTransferConcurrencyState: Dispatch<SetStateAction<number>>;
  applyIncomingCustomKeyBindings: (incoming: { bindings: CustomKeyBindings; version: number; origin: string }) => void;
  mergeIncomingTerminalSettings: (incoming: Partial<TerminalSettings>) => void;
}

export function useSettingsStorageSync({
  theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent,
  customCSS, uiFontFamilyId, hotkeyScheme, uiLanguage,
  terminalThemeId, followAppTerminalTheme, terminalFontFamilyId, terminalFontSize,
  sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles,
  sftpUseCompressedUpload, sftpAutoOpenSidebar, sftpDefaultViewMode,
  showRecentHosts, showOnlyUngroupedHostsInRoot, showSftpTab,
  editorWordWrap, sessionLogsEnabled, sessionLogsDir, sessionLogsFormat,
  globalHotkeyEnabled, autoUpdateEnabled,
  setTheme, setLightUiThemeId, setDarkUiThemeId, setAccentMode, setCustomAccent,
  setCustomCSS, setUiFontFamilyId, setHotkeyScheme, setUiLanguage,
  setTerminalThemeId, setTerminalThemeDarkId, setTerminalThemeLightId,
  setFollowAppTerminalThemeState, setTerminalFontFamilyId, setTerminalFontSize,
  setSftpDoubleClickBehavior, setSftpAutoSync, setSftpShowHiddenFiles,
  setSftpUseCompressedUpload, setSftpAutoOpenSidebar, setSftpDefaultViewMode,
  setShowRecentHostsState, setShowOnlyUngroupedHostsInRootState, setShowSftpTabState,
  setEditorWordWrapState, setSessionLogsEnabled, setSessionLogsDir, setSessionLogsFormat,
  setGlobalHotkeyEnabled, setAutoUpdateEnabled, setWorkspaceFocusStyleState,
  setSftpTransferConcurrencyState, applyIncomingCustomKeyBindings, mergeIncomingTerminalSettings,
}: UseSettingsStorageSyncParams) {
  // Fix 4: Keep a ref snapshot of current settings so the storage event handler
  // can compare without capturing 25+ state variables in its closure / dep array.
  // This avoids constant listener detach/reattach on every state change.
  const settingsSnapshotRef = useRef({
    theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent,
    customCSS, uiFontFamilyId, hotkeyScheme, uiLanguage,
    terminalThemeId, followAppTerminalTheme, terminalFontFamilyId, terminalFontSize,
    sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles,
    sftpUseCompressedUpload, sftpAutoOpenSidebar, sftpDefaultViewMode,
    showRecentHosts, showOnlyUngroupedHostsInRoot, showSftpTab,
    editorWordWrap, sessionLogsEnabled, sessionLogsDir, sessionLogsFormat,
    globalHotkeyEnabled, autoUpdateEnabled,
  });
  settingsSnapshotRef.current = {
    theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent,
    customCSS, uiFontFamilyId, hotkeyScheme, uiLanguage,
    terminalThemeId, followAppTerminalTheme, terminalFontFamilyId, terminalFontSize,
    sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles,
    sftpUseCompressedUpload, sftpAutoOpenSidebar, sftpDefaultViewMode,
    showRecentHosts, showOnlyUngroupedHostsInRoot, showSftpTab,
    editorWordWrap, sessionLogsEnabled, sessionLogsDir, sessionLogsFormat,
    globalHotkeyEnabled, autoUpdateEnabled,
  };

  // Listen for storage changes from other windows (cross-window sync)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      const s = settingsSnapshotRef.current;
      if (e.key === STORAGE_KEY_THEME && e.newValue) {
        if (isValidTheme(e.newValue) && e.newValue !== s.theme) {
          setTheme(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_THEME_LIGHT && e.newValue) {
        if (isValidUiThemeId('light', e.newValue) && e.newValue !== s.lightUiThemeId) {
          setLightUiThemeId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_THEME_DARK && e.newValue) {
        if (isValidUiThemeId('dark', e.newValue) && e.newValue !== s.darkUiThemeId) {
          setDarkUiThemeId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_ACCENT_MODE && e.newValue) {
        if ((e.newValue === 'theme' || e.newValue === 'custom') && e.newValue !== s.accentMode) {
          setAccentMode(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_COLOR && e.newValue) {
        if (isValidHslToken(e.newValue) && e.newValue !== s.customAccent) {
          setCustomAccent(e.newValue.trim());
        }
      }
      if (e.key === STORAGE_KEY_CUSTOM_CSS && e.newValue !== null) {
        if (e.newValue !== s.customCSS) {
          setCustomCSS(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_UI_FONT_FAMILY && e.newValue) {
        if (isValidUiFontId(e.newValue) && e.newValue !== s.uiFontFamilyId) {
          setUiFontFamilyId(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_HOTKEY_SCHEME && e.newValue) {
        const newScheme = e.newValue as HotkeyScheme;
        if (newScheme !== s.hotkeyScheme) {
          setHotkeyScheme(newScheme);
        }
      }
      if (e.key === STORAGE_KEY_UI_LANGUAGE && e.newValue) {
        const next = resolveSupportedLocale(e.newValue);
        if (next !== s.uiLanguage) {
          setUiLanguage(next as UILanguage);
        }
      }
      if (e.key === STORAGE_KEY_CUSTOM_KEY_BINDINGS && e.newValue) {
        const parsed = parseCustomKeyBindingsStorageRecord(e.newValue);
        if (parsed) {
          applyIncomingCustomKeyBindings(parsed);
        }
      }
      // Sync terminal settings from other windows
      if (e.key === STORAGE_KEY_TERM_SETTINGS && e.newValue) {
        try {
          const newSettings = JSON.parse(e.newValue) as TerminalSettings;
          mergeIncomingTerminalSettings(newSettings);
        } catch {
          // ignore parse errors
        }
      }
      // Sync terminal theme from other windows
      if (e.key === STORAGE_KEY_TERM_THEME && e.newValue) {
        if (e.newValue !== s.terminalThemeId) {
          setTerminalThemeId(e.newValue);
        }
      }
      // Sync per-mode follow terminal themes from other windows
      if (e.key === STORAGE_KEY_TERM_THEME_DARK && e.newValue) {
        const next = e.newValue;
        setTerminalThemeDarkId((prev) => (prev === next ? prev : next));
      }
      if (e.key === STORAGE_KEY_TERM_THEME_LIGHT && e.newValue) {
        const next = e.newValue;
        setTerminalThemeLightId((prev) => (prev === next ? prev : next));
      }
      // Sync follow-app-theme toggle from other windows
      if (e.key === STORAGE_KEY_TERM_FOLLOW_APP_THEME && e.newValue) {
        const next = e.newValue === 'true';
        if (next !== s.followAppTerminalTheme) {
          setFollowAppTerminalThemeState(next);
        }
      }
      // Sync terminal font family from other windows
      if (e.key === STORAGE_KEY_TERM_FONT_FAMILY && e.newValue) {
        const migrated = migrateIncomingTerminalFontId(e.newValue);
        if (migrated && migrated !== s.terminalFontFamilyId) {
          setTerminalFontFamilyId(migrated);
        }
      }
      // Sync terminal font size from other windows
      if (e.key === STORAGE_KEY_TERM_FONT_SIZE && e.newValue) {
        const newSize = parseInt(e.newValue, 10);
        if (!isNaN(newSize) && newSize !== s.terminalFontSize) {
          setTerminalFontSize(newSize);
        }
      }
      // Sync SFTP double-click behavior from other windows
      if (e.key === STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR && e.newValue) {
        if ((e.newValue === 'open' || e.newValue === 'transfer') && e.newValue !== s.sftpDoubleClickBehavior) {
          setSftpDoubleClickBehavior(e.newValue);
        }
      }
      // Sync SFTP auto-sync setting from other windows
      if (e.key === STORAGE_KEY_SFTP_AUTO_SYNC && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.sftpAutoSync) {
          setSftpAutoSync(newValue);
        }
      }
      // Sync SFTP show hidden files setting from other windows
      if (e.key === STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.sftpShowHiddenFiles) {
          setSftpShowHiddenFiles(newValue);
        }
      }
      if (e.key === STORAGE_KEY_EDITOR_WORD_WRAP && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.editorWordWrap) {
          setEditorWordWrapState(newValue);
        }
      }
      if (e.key === STORAGE_KEY_SESSION_LOGS_ENABLED && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.sessionLogsEnabled) {
          setSessionLogsEnabled(newValue);
        }
      }
      if (e.key === STORAGE_KEY_SESSION_LOGS_DIR && e.newValue !== null) {
        if (e.newValue !== s.sessionLogsDir) {
          setSessionLogsDir(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_SESSION_LOGS_FORMAT && e.newValue) {
        if (
          (e.newValue === 'txt' || e.newValue === 'raw' || e.newValue === 'html') &&
          e.newValue !== s.sessionLogsFormat
        ) {
          setSessionLogsFormat(e.newValue);
        }
      }
      // Sync SFTP compressed upload setting from other windows
      if (e.key === STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD && e.newValue !== null) {
        const newValue = e.newValue === 'true' || e.newValue === 'enabled';
        if (newValue !== s.sftpUseCompressedUpload) {
          setSftpUseCompressedUpload(newValue);
        }
      }
      // Sync SFTP auto-open sidebar setting from other windows
      if (e.key === STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.sftpAutoOpenSidebar) {
          setSftpAutoOpenSidebar(newValue);
        }
      }
      // Sync SFTP default view mode from other windows
      if (e.key === STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE && e.newValue) {
        if ((e.newValue === 'list' || e.newValue === 'tree') && e.newValue !== s.sftpDefaultViewMode) {
          setSftpDefaultViewMode(e.newValue);
        }
      }
      if (e.key === STORAGE_KEY_SHOW_RECENT_HOSTS && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.showRecentHosts) {
          setShowRecentHostsState(newValue);
        }
      }
      if (e.key === STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.showOnlyUngroupedHostsInRoot) {
          setShowOnlyUngroupedHostsInRootState(newValue);
        }
      }
      if (e.key === STORAGE_KEY_SHOW_SFTP_TAB && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.showSftpTab) {
          setShowSftpTabState(newValue);
        }
      }
      // Sync global hotkey enabled setting from other windows
      if (e.key === STORAGE_KEY_GLOBAL_HOTKEY_ENABLED && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.globalHotkeyEnabled) {
          setGlobalHotkeyEnabled(newValue);
        }
      }
      // Sync auto-update enabled setting from other windows
      if (e.key === STORAGE_KEY_AUTO_UPDATE_ENABLED && e.newValue !== null) {
        const newValue = e.newValue === 'true';
        if (newValue !== s.autoUpdateEnabled) {
          setAutoUpdateEnabled(newValue);
        }
      }
      // Sync workspace focus style from other windows
      if (e.key === STORAGE_KEY_WORKSPACE_FOCUS_STYLE && e.newValue !== null) {
        if (e.newValue === 'dim' || e.newValue === 'border') {
          setWorkspaceFocusStyleState(e.newValue);
        }
      }
      // Sync transfer concurrency from other windows
      if (e.key === STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY && e.newValue !== null) {
        const num = Number(e.newValue);
        if (num >= 1 && num <= 16) {
          setSftpTransferConcurrencyState(num);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [
    applyIncomingCustomKeyBindings,
    mergeIncomingTerminalSettings,
    setAccentMode,
    setAutoUpdateEnabled,
    setCustomAccent,
    setCustomCSS,
    setDarkUiThemeId,
    setEditorWordWrapState,
    setFollowAppTerminalThemeState,
    setGlobalHotkeyEnabled,
    setHotkeyScheme,
    setLightUiThemeId,
    setSessionLogsDir,
    setSessionLogsEnabled,
    setSessionLogsFormat,
    setSftpAutoOpenSidebar,
    setSftpAutoSync,
    setSftpDefaultViewMode,
    setSftpDoubleClickBehavior,
    setSftpShowHiddenFiles,
    setSftpTransferConcurrencyState,
    setSftpUseCompressedUpload,
    setShowOnlyUngroupedHostsInRootState,
    setShowRecentHostsState,
    setShowSftpTabState,
    setTerminalFontFamilyId,
    setTerminalFontSize,
    setTerminalThemeDarkId,
    setTerminalThemeId,
    setTerminalThemeLightId,
    setTheme,
    setUiFontFamilyId,
    setUiLanguage,
    setWorkspaceFocusStyleState,
  ]);


}
