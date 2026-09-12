import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';

import { runThemeTransition, type ThemeTransitionMode } from './themeTransition';
import { publishAppearanceChromeSnapshot } from './appearanceChromeStore';
import {
  publishSettingsChromeSnapshot,
  registerSettingsChromeActions,
} from './settingsChromeStore';
import {
  publishTerminalSettingsSnapshot,
  registerTerminalSettingsActions,
} from './terminalSettingsStore';
import { SyncConfig, TerminalSettings, HotkeyScheme, CustomKeyBindings, DEFAULT_KEY_BINDINGS, KeyBinding, UILanguage, SessionLogFormat, normalizeTerminalSettings } from '../../domain/models';
import {
  normalizeAppLockTimeoutMinutes,
  type AppLockSettings,
  type AppLockTimeoutMinutes,
} from '../../domain/appLock';
import {
  DEFAULT_HTTP_NETWORK_PROXY,
  areHttpNetworkProxySettingsEqual,
  normalizeHttpNetworkProxySettings,
  type HttpNetworkProxySettings,
} from '../../domain/httpNetworkProxy';
import {
  STORAGE_KEY_COLOR,
  STORAGE_KEY_SYNC,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_TERM_FOLLOW_APP_THEME,
  STORAGE_KEY_TERM_THEME_DARK,
  STORAGE_KEY_TERM_THEME_LIGHT,
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
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD,
  STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY,
  STORAGE_KEY_SFTP_SKIP_UNCHANGED,
  STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS,
  STORAGE_KEY_SFTP_TRANSFER_POOL_IDLE_TTL_MS,
  STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_SESSION_LOGS_ENABLED,
  STORAGE_KEY_RESTORE_PREVIOUS_SESSION,
  STORAGE_KEY_RESTORE_TERMINAL_CWD,
  STORAGE_KEY_STARTUP_LANDING,
  STORAGE_KEY_SESSION_LOGS_DIR,
  STORAGE_KEY_SESSION_LOGS_FORMAT,
  STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED,
  STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED,
  STORAGE_KEY_SSH_DEEP_LINK_ENABLED,
  STORAGE_KEY_JMS_DEEP_LINK_ENABLED,
  STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED,
  STORAGE_KEY_TOGGLE_WINDOW_HOTKEY,
  STORAGE_KEY_CLOSE_TO_TRAY,
  STORAGE_KEY_AUTO_LAUNCH_ENABLED,
  STORAGE_KEY_HTTP_NETWORK_PROXY,
  STORAGE_KEY_GLOBAL_HOTKEY_ENABLED,
  STORAGE_KEY_WINDOW_OPACITY,
  STORAGE_KEY_APP_ICON_VARIANT,
  STORAGE_KEY_AUTO_UPDATE_ENABLED,
  STORAGE_KEY_WORKSPACE_FOCUS_STYLE,
  STORAGE_KEY_SHOW_RECENT_HOSTS,
  STORAGE_KEY_HOST_CLICK_BEHAVIOR,
  STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
  STORAGE_KEY_SHOW_SFTP_TAB,
  STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS,
  STORAGE_KEY_SHOW_TAB_NUMBER_BADGES,
  STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM,
} from '../../infrastructure/config/storageKeys';
import { DEFAULT_UI_LOCALE, resolveSupportedLocale } from '../../infrastructure/config/i18n';
import {
  areCustomKeyBindingsEqual,
  nextCustomKeyBindingsSyncVersion,
  parseCustomKeyBindingsStorageRecord,
  resetCustomKeyBinding,
  serializeCustomKeyBindingsStorageRecord,
  shouldApplyIncomingCustomKeyBindingsRecord,
  updateCustomKeyBinding as updateCustomKeyBindingRecord,
} from '../../domain/customKeyBindings';
import { resolveGlobalTerminalAppearance, idleThemeUserIntent } from '../../domain/terminalAppearanceRuntime';
import { DEFAULT_FONT_SIZE, TERMINAL_FONT_AUTO } from '../../infrastructure/config/fonts';
import { getUiThemeById } from '../../infrastructure/config/uiThemes';
import { DEFAULT_UI_FONT_ID, withWindowsEmojiFallback } from '../../infrastructure/config/uiFonts';
import { uiFontStore, useUIFontsLoaded } from './uiFontStore';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  resolveSftpTransferConcurrency,
  resolveSftpSkipUnchangedEnabled,
} from './sftp/transferConcurrency';
import { resolveSshTransportIdleTtlMs } from '../../infrastructure/config/sshTransportIdleTtl';
import {
  DEFAULT_ACCENT_MODE,
  DEFAULT_DARK_UI_THEME,
  DEFAULT_EDITOR_WORD_WRAP,
  DEFAULT_HOTKEY_SCHEME,
  DEFAULT_LIGHT_UI_THEME,
  DEFAULT_SESSION_LOGS_ENABLED,
  DEFAULT_SESSION_LOGS_FORMAT,
  DEFAULT_SESSION_LOGS_TIMESTAMPS_ENABLED,
  DEFAULT_SFTP_AUTO_OPEN_SIDEBAR,
  DEFAULT_SFTP_FOLLOW_TERMINAL_CWD,
  DEFAULT_SFTP_AUTO_SYNC,
  DEFAULT_SFTP_DEFAULT_VIEW_MODE,
  DEFAULT_SFTP_DOUBLE_CLICK_BEHAVIOR,
  DEFAULT_SFTP_SHOW_HIDDEN_FILES,
  DEFAULT_SFTP_USE_COMPRESSED_UPLOAD,
  DEFAULT_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
  DEFAULT_SHOW_RECENT_HOSTS,
  DEFAULT_HOST_CLICK_BEHAVIOR,
  DEFAULT_SHOW_SFTP_TAB,
  DEFAULT_SHOW_HOST_TREE_SIDEBAR,
  DEFAULT_SHELL_ONLY_TAB_NUMBER_SHORTCUTS,
  DEFAULT_SHOW_TAB_NUMBER_BADGES,
  DEFAULT_DISABLE_TERMINAL_FONT_ZOOM,
  DEFAULT_SSH_DEBUG_LOGS_ENABLED,
  DEFAULT_SSH_DEEP_LINK_ENABLED,
  DEFAULT_JMS_DEEP_LINK_ENABLED,
  DEFAULT_EXPLORER_CONTEXT_MENU_ENABLED,
  DEFAULT_TERMINAL_THEME,
  DEFAULT_THEME,
  DEFAULT_WINDOW_OPACITY,
  clampWindowOpacity,
  applyThemeTokens,
  areTerminalSettingsEqual,
  createCustomKeyBindingsSyncOrigin,
  getSystemPreference,
  isValidHslToken,
  isValidTheme,
  isValidUiFontId,
  isValidUiThemeId,
  migrateIncomingTerminalFontId,
  readStoredString,
  serializeTerminalSettings,
  type HostClickBehavior,
} from './settingsStateDefaults';
import { isHostClickBehavior } from '../../domain/hostClickBehavior';
import {
  resolveStartupLandingSetting,
  type StartupLanding,
} from '../../domain/startupLanding';
import { resolveRestorePreviousSessionSetting, resolveRestoreTerminalCwdSetting } from './sessionRestoreSettings';
import { sessionRestoreStorage } from './sessionRestoreStorage';
import { useSettingsStorageSync } from './settingsStorageSync';
import { useSettingsIpcSync } from './settingsIpcSync';
import { TERMINAL_THEME_AUTO } from '../../domain/terminalAppearance';
import { customThemeStore, useCustomThemes } from '../state/customThemeStore';
import { useSystemSettingsEffects } from './systemSettingsEffects';
import { resolveAppIconVariant, type AppIconVariant } from '../../domain/appIconVariant';
import { DEFAULT_APP_ICON_VARIANT } from '../../infrastructure/config/appIconVariants';
import { applyCustomCssToDocument } from '../../lib/customCss';
import {
  DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_ENABLED,
  DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  isTerminalSidePanelAutoOpenTab,
  type TerminalSidePanelAutoOpenTab,
} from '../../domain/terminalSidePanelAutoOpen';
import {
  parseWindowOpacityRecord,
  shouldApplyWindowOpacityRecord,
  type WindowOpacityMutationSource,
  type WindowOpacityRecord,
} from './windowOpacitySync';
import {
  parseCustomAccentRecord,
  serializeCustomAccentRecord,
  shouldApplyCustomAccentRecord,
  shouldBroadcastCustomAccentChange,
  type CustomAccentMutationSource,
  type CustomAccentRecord,
} from './customAccentSync';
import {
  createLocalTerminalFontSizeRecord,
  createTerminalFontSizeSyncOrigin,
  parseTerminalFontSizeRecord,
  resolveAuthoritativeTerminalFontSizeStorage,
  resolveIncomingTerminalFontSize,
  shouldBroadcastTerminalFontSizeChange,
  type TerminalFontSizeMutationSource,
  type TerminalFontSizeRecord,
} from './terminalFontSizeSync';
import {
  hasPersistedAppearanceChanged,
  resolveAppearanceSyncState,
  type AppearanceRenderSnapshot,
  type AppearanceSyncEvent,
} from './appearanceSync';

export const useSettingsState = (options: { enableSettingsSync?: boolean; enableSystemEffects?: boolean } = {}) => {
  const enableSettingsSync = options.enableSettingsSync !== false;
  const enableSystemEffects = options.enableSystemEffects !== false;
  const initialCustomKeyBindingsRecord =
    parseCustomKeyBindingsStorageRecord(localStorageAdapter.readString(STORAGE_KEY_CUSTOM_KEY_BINDINGS));
  const uiFontsLoaded = useUIFontsLoaded();
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    const stored = readStoredString(STORAGE_KEY_THEME);
    return stored && isValidTheme(stored) ? stored : DEFAULT_THEME;
  });
  // Track the OS color scheme preference (updated by matchMedia listener)
  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(getSystemPreference);
  // resolvedTheme is always 'light' or 'dark' - derived synchronously from theme + OS preference
  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? systemPreference : theme;
  const [lightUiThemeId, setLightUiThemeId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_THEME_LIGHT);
    return stored && isValidUiThemeId('light', stored) ? stored : DEFAULT_LIGHT_UI_THEME;
  });
  const [darkUiThemeId, setDarkUiThemeId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_THEME_DARK);
    return stored && isValidUiThemeId('dark', stored) ? stored : DEFAULT_DARK_UI_THEME;
  });
  const [customAccentRecord, setCustomAccentRecord] = useState<CustomAccentRecord>(() => {
    return parseCustomAccentRecord(readStoredString(STORAGE_KEY_COLOR));
  });
  const customAccent = customAccentRecord.color;
  const customAccentMutationSourceRef = useRef<CustomAccentMutationSource>('local');
  const setCustomAccent = useCallback((nextValue: SetStateAction<string>) => {
    customAccentMutationSourceRef.current = 'local';
    setCustomAccentRecord((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: string) => string)(prev.color)
        : nextValue;
      const next = parseCustomAccentRecord(candidate);
      if (next.color === prev.color) return prev;
      return { color: next.color, version: prev.version + 1 };
    });
  }, []);
  const applyIncomingCustomAccent = useCallback((raw: unknown) => {
    const incoming = parseCustomAccentRecord(raw);
    setCustomAccentRecord((prev) => {
      if (!shouldApplyCustomAccentRecord(prev, incoming)) {
        return prev;
      }
      customAccentMutationSourceRef.current = 'incoming';
      return incoming;
    });
  }, []);
  const [accentMode, setAccentMode] = useState<'theme' | 'custom'>(() => {
    const stored = readStoredString(STORAGE_KEY_ACCENT_MODE);
    if (stored === 'theme' || stored === 'custom') return stored;
    const raw = readStoredString(STORAGE_KEY_COLOR);
    if (!raw) return DEFAULT_ACCENT_MODE;
    if (isValidHslToken(raw.trim())) return 'custom';
    if (raw.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(raw.trim()) as { color?: unknown };
        return typeof obj.color === 'string' && isValidHslToken(obj.color) ? 'custom' : DEFAULT_ACCENT_MODE;
      } catch {
        return DEFAULT_ACCENT_MODE;
      }
    }
    return DEFAULT_ACCENT_MODE;
  });
  const [uiFontFamilyId, setUiFontFamilyId] = useState<string>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_FONT_FAMILY);
    return stored && isValidUiFontId(stored) ? stored : DEFAULT_UI_FONT_ID;
  });
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(() => localStorageAdapter.read<SyncConfig>(STORAGE_KEY_SYNC));
  const [terminalThemeId, setTerminalThemeId] = useState<string>(() => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME) || DEFAULT_TERMINAL_THEME);
  const [followAppTerminalTheme, setFollowAppTerminalThemeState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_TERM_FOLLOW_APP_THEME);
    if (stored !== null) return stored === 'true';
    // First time seeing this key. For genuinely fresh installs (no existing
    // terminal theme in storage) default ON so the terminal matches the app
    // theme out of the box. For upgrades from an older version (existing
    // terminal theme present) default OFF to avoid silently overriding the
    // user's manual choice.
    const isUpgrade = !!localStorageAdapter.readString(STORAGE_KEY_TERM_THEME);
    return !isUpgrade;
  });
  const [terminalThemeDarkId, setTerminalThemeDarkId] = useState<string>(
    () => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME_DARK) || TERMINAL_THEME_AUTO,
  );
  const [terminalThemeLightId, setTerminalThemeLightId] = useState<string>(
    () => localStorageAdapter.readString(STORAGE_KEY_TERM_THEME_LIGHT) || TERMINAL_THEME_AUTO,
  );
  const [terminalFontFamilyId, setTerminalFontFamilyId] = useState<string>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_FAMILY);
    return migrateIncomingTerminalFontId(stored) ?? TERMINAL_FONT_AUTO;
  });
  const [terminalFontSizeRecord, setTerminalFontSizeRecord] = useState<TerminalFontSizeRecord>(() => {
    const stored = readStoredString(STORAGE_KEY_TERM_FONT_SIZE);
    if (stored === null) {
      return { fontSize: DEFAULT_FONT_SIZE, version: 0, origin: 'legacy' };
    }
    return parseTerminalFontSizeRecord(stored);
  });
  const terminalFontSize = terminalFontSizeRecord.fontSize;
  const terminalFontSizeRecordRef = useRef(terminalFontSizeRecord);
  const terminalFontSizeMutationSourceRef = useRef<TerminalFontSizeMutationSource>('local');
  const terminalFontSizeLocalOriginRef = useRef(createTerminalFontSizeSyncOrigin());
  const setTerminalFontSize = useCallback((nextValue: SetStateAction<number>) => {
    terminalFontSizeMutationSourceRef.current = 'local';
    const persistedRaw = localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_SIZE);
    const current = terminalFontSizeRecordRef.current;
    const candidate = typeof nextValue === 'function'
      ? (nextValue as (prevState: number) => number)(current.fontSize)
      : nextValue;
    const next = createLocalTerminalFontSizeRecord(
      current,
      persistedRaw,
      candidate,
      terminalFontSizeLocalOriginRef.current,
    );
    if (next === current) return;
    terminalFontSizeRecordRef.current = next;
    setTerminalFontSizeRecord(next);
  }, []);
  const applyIncomingTerminalFontSize = useCallback((raw: unknown) => {
    const resolution = resolveIncomingTerminalFontSize(
      terminalFontSizeRecordRef.current,
      raw,
      localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_SIZE),
    );
    if (resolution.repairSerializedRecord !== null) {
      localStorageAdapter.writeString(
        STORAGE_KEY_TERM_FONT_SIZE,
        resolution.repairSerializedRecord,
      );
    }
    if (!resolution.shouldUpdate) return;
    terminalFontSizeMutationSourceRef.current = 'incoming';
    terminalFontSizeRecordRef.current = resolution.record;
    setTerminalFontSizeRecord(resolution.record);
  }, []);
  const [uiLanguage, setUiLanguage] = useState<UILanguage>(() => {
    const stored = readStoredString(STORAGE_KEY_UI_LANGUAGE);
    return resolveSupportedLocale(stored || DEFAULT_UI_LOCALE);
  });
  const [appLockSettings, setAppLockSettingsState] = useState<AppLockSettings>({
    enabled: false,
    timeoutMinutes: 15,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false,
    passwordVerifier: null,
  });
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings>(() => {
    const stored = localStorageAdapter.read<TerminalSettings>(STORAGE_KEY_TERM_SETTINGS);
    return normalizeTerminalSettings(stored);
  });
  const [hotkeyScheme, setHotkeyScheme] = useState<HotkeyScheme>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_HOTKEY_SCHEME);
    // Validate stored value is a valid HotkeyScheme
    if (stored === 'disabled' || stored === 'mac' || stored === 'pc') {
      return stored;
    }
    return DEFAULT_HOTKEY_SCHEME;
  });
  const [customKeyBindings, setCustomKeyBindingsState] = useState<CustomKeyBindings>(() =>
    initialCustomKeyBindingsRecord?.bindings || {}
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
  const [sftpAutoOpenSidebar, setSftpAutoOpenSidebar] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR);
    return stored === 'true' ? true : DEFAULT_SFTP_AUTO_OPEN_SIDEBAR;
  });
  const [sftpFollowTerminalCwd, setSftpFollowTerminalCwd] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD);
    return stored === 'true' ? true : DEFAULT_SFTP_FOLLOW_TERMINAL_CWD;
  });
  const [sftpDefaultViewMode, setSftpDefaultViewMode] = useState<'list' | 'tree'>(() => {
    const stored = readStoredString(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE);
    return (stored === 'list' || stored === 'tree') ? stored : DEFAULT_SFTP_DEFAULT_VIEW_MODE;
  });
  const [showRecentHosts, setShowRecentHostsState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_RECENT_HOSTS);
    return stored ?? DEFAULT_SHOW_RECENT_HOSTS;
  });
  const [hostClickBehavior, setHostClickBehaviorState] = useState<HostClickBehavior>(() => {
    const stored = readStoredString(STORAGE_KEY_HOST_CLICK_BEHAVIOR);
    return isHostClickBehavior(stored) ? stored : DEFAULT_HOST_CLICK_BEHAVIOR;
  });
  const [showOnlyUngroupedHostsInRoot, setShowOnlyUngroupedHostsInRootState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT);
    return stored ?? DEFAULT_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT;
  });
  const [showSftpTab, setShowSftpTabState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_SFTP_TAB);
    return stored ?? DEFAULT_SHOW_SFTP_TAB;
  });
  const [showHostTreeSidebar, setShowHostTreeSidebarState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR);
    return stored ?? DEFAULT_SHOW_HOST_TREE_SIDEBAR;
  });
  const [terminalSidePanelAutoOpen, setTerminalSidePanelAutoOpenState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN);
    return stored ?? DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_ENABLED;
  });
  const [terminalSidePanelAutoOpenTab, setTerminalSidePanelAutoOpenTabState] = useState<TerminalSidePanelAutoOpenTab>(() => {
    const stored = readStoredString(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB);
    return isTerminalSidePanelAutoOpenTab(stored) ? stored : DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB;
  });
  const [shellOnlyTabNumberShortcuts, setShellOnlyTabNumberShortcutsState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS);
    return stored ?? DEFAULT_SHELL_ONLY_TAB_NUMBER_SHORTCUTS;
  });
  const [showTabNumberBadges, setShowTabNumberBadgesState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_TAB_NUMBER_BADGES);
    return stored ?? DEFAULT_SHOW_TAB_NUMBER_BADGES;
  });
  const [disableTerminalFontZoom, setDisableTerminalFontZoomState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM);
    return stored ?? DEFAULT_DISABLE_TERMINAL_FONT_ZOOM;
  });
  const [restorePreviousSession, setRestorePreviousSessionState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION);
    return resolveRestorePreviousSessionSetting(stored);
  });
  const [restoreTerminalCwd, setRestoreTerminalCwdState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_TERMINAL_CWD);
    return resolveRestoreTerminalCwdSetting(stored);
  });
  const [startupLanding, setStartupLandingState] = useState<StartupLanding>(() => {
    return resolveStartupLandingSetting(readStoredString(STORAGE_KEY_STARTUP_LANDING));
  });
  const [sftpTransferConcurrency, setSftpTransferConcurrencyState] = useState<number>(() => {
    return resolveSftpTransferConcurrency(() =>
      localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
    );
  });
  // Folder transfer concurrency is renderer-only (runSftpTransferWorkers).
  // Do not push it into main-process host admission - that made multi-select
  // top-level files queue against each other and against folder children.
  const [sftpSkipUnchanged, setSftpSkipUnchanged] = useState<boolean>(() =>
    resolveSftpSkipUnchangedEnabled(() => localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_SKIP_UNCHANGED)),
  );

  const [sshTransportIdleTtlMs, setSshTransportIdleTtlMsState] = useState<number>(() => {
    // Prefer the new SSH transport key; if absent (upgrade), migrate the legacy
    // transfer-pool keep-alive value so users do not silently fall back to 5m.
    return resolveSshTransportIdleTtlMs(() => {
      const next = localStorageAdapter.readNumber(STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS);
      if (next != null) return next;
      const legacy = localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_POOL_IDLE_TTL_MS);
      if (legacy != null) {
        try {
          localStorageAdapter.writeString(STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS, String(legacy));
        } catch {
          // ignore migration write failures
        }
      }
      return legacy;
    });
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
  const [sessionLogsTimestampsEnabled, setSessionLogsTimestampsEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED);
    return stored === 'true' ? true : DEFAULT_SESSION_LOGS_TIMESTAMPS_ENABLED;
  });
  const [sshDebugLogsEnabled, setSshDebugLogsEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED);
    return stored === 'true' ? true : DEFAULT_SSH_DEBUG_LOGS_ENABLED;
  });
  const [sshDeepLinkEnabled, setSshDeepLinkEnabledState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED);
    return stored ?? DEFAULT_SSH_DEEP_LINK_ENABLED;
  });
  const [jmsDeepLinkEnabled, setJmsDeepLinkEnabledState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED);
    return stored ?? DEFAULT_JMS_DEEP_LINK_ENABLED;
  });
  const [explorerContextMenuEnabled, setExplorerContextMenuEnabledState] = useState<boolean>(() => {
    const stored = localStorageAdapter.readBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED);
    return stored ?? DEFAULT_EXPLORER_CONTEXT_MENU_ENABLED;
  });
  const [explorerContextMenuSupported, setExplorerContextMenuSupported] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;
    return /Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent);
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
  // Optimistic cache for first paint; useSystemSettingsEffects hydrates this
  // from app.getLoginItemSettings() (the real source of truth) on mount.
  const [autoLaunchEnabled, setAutoLaunchEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_AUTO_LAUNCH_ENABLED);
    return stored === 'true';
  });
  const [autoLaunchSupported, setAutoLaunchSupported] = useState<boolean>(true);
  const [httpNetworkProxy, setHttpNetworkProxyState] = useState<HttpNetworkProxySettings>(() => {
    const stored = localStorageAdapter.read<unknown>(STORAGE_KEY_HTTP_NETWORK_PROXY);
    return normalizeHttpNetworkProxySettings(stored ?? DEFAULT_HTTP_NETWORK_PROXY);
  });
  const setHttpNetworkProxy = useCallback((nextValue: SetStateAction<HttpNetworkProxySettings>) => {
    setHttpNetworkProxyState((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: HttpNetworkProxySettings) => HttpNetworkProxySettings)(prev)
        : nextValue;
      // Preserve the previous object when values are unchanged so cross-window
      // settings:changed IPC does not rebroadcast forever via useSystemSettingsEffects.
      const next = normalizeHttpNetworkProxySettings(candidate);
      return areHttpNetworkProxySettingsEqual(prev, next) ? prev : next;
    });
  }, []);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_AUTO_UPDATE_ENABLED);
    if (stored === null) return true; // Default to enabled
    return stored === 'true';
  });
  const [hotkeyRegistrationError, setHotkeyRegistrationError] = useState<string | null>(null);
  const [globalHotkeyEnabled, setGlobalHotkeyEnabled] = useState<boolean>(() => {
    const stored = readStoredString(STORAGE_KEY_GLOBAL_HOTKEY_ENABLED);
    if (stored === null) return true; // Default to enabled
    return stored === 'true';
  });
  const [windowOpacityRecord, setWindowOpacityRecord] = useState<WindowOpacityRecord>(() => {
    const stored = readStoredString(STORAGE_KEY_WINDOW_OPACITY);
    if (stored === null) return { opacity: DEFAULT_WINDOW_OPACITY, version: 0 };
    return parseWindowOpacityRecord(stored);
  });
  const windowOpacity = windowOpacityRecord.opacity;
  const windowOpacityMutationSourceRef = useRef<WindowOpacityMutationSource>('local');
  const setWindowOpacity = useCallback((nextValue: SetStateAction<number>) => {
    windowOpacityMutationSourceRef.current = 'local';
    setWindowOpacityRecord((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: number) => number)(prev.opacity)
        : nextValue;
      const nextOpacity = clampWindowOpacity(candidate);
      if (nextOpacity === prev.opacity) return prev;
      return { opacity: nextOpacity, version: prev.version + 1 };
    });
  }, []);
  const applyIncomingWindowOpacity = useCallback((raw: unknown) => {
    const incoming = parseWindowOpacityRecord(raw);
    // Version gate so stale IPC/storage echoes cannot clobber a newer local
    // drag revision (see #2018).
    setWindowOpacityRecord((prev) => {
      if (!shouldApplyWindowOpacityRecord(prev, incoming)) {
        return prev;
      }
      windowOpacityMutationSourceRef.current = 'incoming';
      return incoming;
    });
  }, []);
  const [appIconVariant, setAppIconVariantState] = useState<AppIconVariant>(() => {
    const stored = readStoredString(STORAGE_KEY_APP_ICON_VARIANT);
    return resolveAppIconVariant(stored ?? DEFAULT_APP_ICON_VARIANT);
  });
  const setAppIconVariant = useCallback((nextValue: SetStateAction<AppIconVariant>) => {
    setAppIconVariantState((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: AppIconVariant) => AppIconVariant)(prev)
        : nextValue;
      return resolveAppIconVariant(candidate);
    });
  }, []);
  const incomingTerminalSettingsSignatureRef = useRef<string | null>(null);
  const localTerminalSettingsVersionRef = useRef(0);
  const broadcastedLocalTerminalSettingsVersionRef = useRef(0);
  const customKeyBindingsVersionRef = useRef(initialCustomKeyBindingsRecord?.version || 0);
  const customKeyBindingsOriginRef = useRef(initialCustomKeyBindingsRecord?.origin || 'legacy');
  const customKeyBindingsLocalOriginRef = useRef(createCustomKeyBindingsSyncOrigin());
  const customKeyBindingsMutationSourceRef = useRef<'local' | 'incoming'>('local');
  const sshDeepLinkMutationSourceRef = useRef<'local' | 'incoming'>('local');
  const sshDeepLinkEnabledRef = useRef(sshDeepLinkEnabled);
  const sshDeepLinkSetRequestIdRef = useRef(0);
  const jmsDeepLinkMutationSourceRef = useRef<'local' | 'incoming'>('local');
  const jmsDeepLinkEnabledRef = useRef(jmsDeepLinkEnabled);
  const jmsDeepLinkSetRequestIdRef = useRef(0);
  const explorerContextMenuMutationSourceRef = useRef<'local' | 'incoming'>('local');
  const explorerContextMenuEnabledRef = useRef(explorerContextMenuEnabled);
  const explorerContextMenuSetRequestIdRef = useRef(0);

  // Fix 1: Mount guard - skip redundant IPC broadcasts & localStorage writes on initial mount.
  // Set to true by the LAST useEffect declaration; all persist effects see false on first render.
  const persistMountedRef = useRef(false);
  const appearanceTransitionModeRef = useRef<ThemeTransitionMode>('view');
  const previousAppearanceRenderRef = useRef<AppearanceRenderSnapshot | null>(null);
  // Latest appearance kept in a ref so sequential keyed IPC updates (one multi-field
  // change -> multiple notifies) can compose without waiting for a React re-render.
  const appearanceStateRef = useRef({
    theme,
    lightUiThemeId,
    darkUiThemeId,
    accentMode,
    customAccent,
    customAccentVersion: customAccentRecord.version,
  });
  appearanceStateRef.current = {
    theme,
    lightUiThemeId,
    darkUiThemeId,
    accentMode,
    customAccent,
    customAccentVersion: customAccentRecord.version,
  };

  const setTerminalSettings = useCallback((nextValue: SetStateAction<TerminalSettings>) => {
    setTerminalSettingsState((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: TerminalSettings) => TerminalSettings)(prev)
        : nextValue;
      const next = normalizeTerminalSettings(candidate);
      if (areTerminalSettingsEqual(prev, next)) {
        return prev;
      }
      localTerminalSettingsVersionRef.current += 1;
      return next;
    });
  }, []);

  const mergeIncomingTerminalSettings = useCallback((incoming: Partial<TerminalSettings>) => {
    setTerminalSettingsState((prev) => {
      const merged: Partial<TerminalSettings> = { ...prev, ...incoming };
      if (
        !Object.prototype.hasOwnProperty.call(incoming, 'middleClickBehavior') &&
        Object.prototype.hasOwnProperty.call(incoming, 'middleClickPaste')
      ) {
        delete merged.middleClickBehavior;
      }
      const next = normalizeTerminalSettings(merged);
      if (areTerminalSettingsEqual(prev, next)) {
        return prev;
      }
      // Mark the exact incoming snapshot so only this state is skipped for IPC rebroadcast.
      incomingTerminalSettingsSignatureRef.current = serializeTerminalSettings(next);
      return next;
    });
  }, []);

  const setCustomKeyBindings = useCallback((nextValue: SetStateAction<CustomKeyBindings>) => {
    setCustomKeyBindingsState((prev) => {
      const candidate = typeof nextValue === 'function'
        ? (nextValue as (prevState: CustomKeyBindings) => CustomKeyBindings)(prev)
        : nextValue;
      if (areCustomKeyBindingsEqual(prev, candidate)) {
        return prev;
      }
      customKeyBindingsVersionRef.current = nextCustomKeyBindingsSyncVersion(
        customKeyBindingsVersionRef.current,
      );
      customKeyBindingsOriginRef.current = customKeyBindingsLocalOriginRef.current;
      customKeyBindingsMutationSourceRef.current = 'local';
      return candidate;
    });
  }, []);

  const applyIncomingCustomKeyBindings = useCallback((incoming: {
    bindings: CustomKeyBindings;
    version: number;
    origin: string;
  }) => {
    setCustomKeyBindingsState((prev) => {
      if (!shouldApplyIncomingCustomKeyBindingsRecord(
        {
          version: customKeyBindingsVersionRef.current,
          origin: customKeyBindingsOriginRef.current,
        },
        {
          version: incoming.version,
          origin: incoming.origin,
        },
      )) {
        return prev;
      }
      customKeyBindingsVersionRef.current = incoming.version;
      customKeyBindingsOriginRef.current = incoming.origin;
      customKeyBindingsMutationSourceRef.current = 'incoming';
      if (areCustomKeyBindingsEqual(prev, incoming.bindings)) {
        return prev;
      }
      return incoming.bindings;
    });
  }, []);

  const applyIncomingSshDeepLinkEnabled = useCallback((enabled: boolean) => {
    sshDeepLinkSetRequestIdRef.current += 1;
    setSshDeepLinkEnabledState((prev) => {
      if (prev === enabled) return prev;
      sshDeepLinkMutationSourceRef.current = 'incoming';
      return enabled;
    });
  }, []);

  const applyIncomingJmsDeepLinkEnabled = useCallback((enabled: boolean) => {
    jmsDeepLinkSetRequestIdRef.current += 1;
    setJmsDeepLinkEnabledState((prev) => {
      if (prev === enabled) return prev;
      jmsDeepLinkMutationSourceRef.current = 'incoming';
      return enabled;
    });
  }, []);

  const applyIncomingExplorerContextMenuEnabled = useCallback((enabled: boolean) => {
    explorerContextMenuSetRequestIdRef.current += 1;
    setExplorerContextMenuEnabledState((prev) => {
      if (prev === enabled) return prev;
      explorerContextMenuMutationSourceRef.current = 'incoming';
      return enabled;
    });
  }, []);

  // Helper to notify other windows about settings changes via IPC
  const notifySettingsChanged = useCallback((key: string, value: unknown) => {
    if (!enableSettingsSync) return;
    try {
      netcattyBridge.get()?.notifySettingsChanged?.({ key, value });
    } catch {
      // ignore - bridge may not be available
    }
  }, [enableSettingsSync]);


  const setSftpTransferConcurrency = useCallback((value: number) => {
    const clamped = Math.max(1, Math.min(16, Math.round(value)));
    setSftpTransferConcurrencyState(clamped);
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY, String(clamped));
    // Intentionally not calling setGlobalTransferConcurrency - this setting
    // only caps files inside a single folder transfer job.
    notifySettingsChanged(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY, clamped);
  }, [notifySettingsChanged]);

  const setSshTransportIdleTtlMs = useCallback((value: number) => {
    const next = resolveSshTransportIdleTtlMs(() => value);
    setSshTransportIdleTtlMsState(next);
    localStorageAdapter.writeString(STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS, String(next));
    notifySettingsChanged(STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS, next);
  }, [notifySettingsChanged]);

  // Push idle TTL to the main-process transport registry on load and whenever
  // it changes (including cross-window IPC/storage updates to local state).
  const lastPushedSshTransportIdleTtlRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastPushedSshTransportIdleTtlRef.current === sshTransportIdleTtlMs) return;
    lastPushedSshTransportIdleTtlRef.current = sshTransportIdleTtlMs;
    notifySettingsChanged(STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS, sshTransportIdleTtlMs);
  }, [sshTransportIdleTtlMs, notifySettingsChanged]);

  const [workspaceFocusStyle, setWorkspaceFocusStyleState] = useState<'dim' | 'border'>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_WORKSPACE_FOCUS_STYLE);
    return stored === 'border' ? 'border' : 'dim';
  });
  const setWorkspaceFocusStyle = useCallback((style: 'dim' | 'border') => {
    setWorkspaceFocusStyleState(style);
    localStorageAdapter.writeString(STORAGE_KEY_WORKSPACE_FOCUS_STYLE, style);
    notifySettingsChanged(STORAGE_KEY_WORKSPACE_FOCUS_STYLE, style);
  }, [notifySettingsChanged]);

  const setAppLockTimeoutMinutes = useCallback((timeoutMinutes: AppLockTimeoutMinutes) => {
    void netcattyBridge.get()?.setAppLockTimeoutMinutes?.(normalizeAppLockTimeoutMinutes(timeoutMinutes))
      ?.then((next) => {
        if (next) setAppLockSettingsState(next);
      })
      .catch(() => {});
  }, []);

  const requestAppLockEnable = useCallback(async () => {
    const next = await netcattyBridge.get()?.requestAppLockEnable?.();
    if (next && !('ok' in next)) {
      setAppLockSettingsState(next);
    }
    return next ?? appLockSettings;
  }, [appLockSettings]);

  const requestAppLockDisable = useCallback(async (currentPassword: string) => {
    const next = await netcattyBridge.get()?.requestAppLockDisable?.(currentPassword);
    if (next && !('ok' in next)) {
      setAppLockSettingsState(next);
    }
    return next ?? appLockSettings;
  }, [appLockSettings]);

  const requestAppLockPasswordChange = useCallback(async (input: {
    currentPassword?: string;
    nextPassword: string;
  }) => {
    const next = await netcattyBridge.get()?.requestAppLockPasswordChange?.(input);
    if (next && !('ok' in next)) {
      setAppLockSettingsState(next);
    }
    return next ?? appLockSettings;
  }, [appLockSettings]);

  const setAppLockSystemUnlockEnabled = useCallback(async (input: {
    enabled: boolean;
    currentPassword?: string;
    autoPromptEnabled?: boolean;
  }) => {
    const next = await netcattyBridge.get()?.setAppLockSystemUnlockEnabled?.(input);
    if (next && !('ok' in next)) {
      setAppLockSettingsState(next);
    }
    return next ?? appLockSettings;
  }, [appLockSettings]);

  const syncAppearanceFromStorage = useCallback((incoming?: AppearanceSyncEvent) => {
    const current = appearanceStateRef.current;
    const nextAppearance = resolveAppearanceSyncState(
      current,
      {
        theme: readStoredString(STORAGE_KEY_THEME),
        lightUiThemeId: readStoredString(STORAGE_KEY_UI_THEME_LIGHT),
        darkUiThemeId: readStoredString(STORAGE_KEY_UI_THEME_DARK),
        accentMode: readStoredString(STORAGE_KEY_ACCENT_MODE),
        customAccent: readStoredString(STORAGE_KEY_COLOR),
      },
      incoming,
    );
    const {
      theme: nextTheme,
      lightUiThemeId: nextLightId,
      darkUiThemeId: nextDarkId,
      accentMode: nextAccentMode,
      customAccent: nextAccent,
      customAccentVersion: nextAccentVersion,
    } = nextAppearance;

    // Fix 2: Skip expensive DOM operations if nothing actually changed
    if (
      nextTheme === current.theme &&
      nextLightId === current.lightUiThemeId &&
      nextDarkId === current.darkUiThemeId &&
      nextAccentMode === current.accentMode &&
      nextAccent === current.customAccent &&
      nextAccentVersion === current.customAccentVersion
    ) {
      return;
    }

    // Publish synchronously so a later keyed IPC in the same turn composes on top.
    appearanceStateRef.current = nextAppearance;
    if (
      nextAccent !== current.customAccent
      || nextAccentVersion !== current.customAccentVersion
    ) {
      // Mark incoming so the persist effect does not rebroadcast to the peer that
      // originated this update (color-picker drag ping-pong; see #2743).
      customAccentMutationSourceRef.current = 'incoming';
      setCustomAccentRecord({ color: nextAccent, version: nextAccentVersion });
    }
    setTheme(nextTheme);
    setLightUiThemeId(nextLightId);
    setDarkUiThemeId(nextDarkId);
    setAccentMode(nextAccentMode);

    const effective = nextTheme === 'system' ? getSystemPreference() : nextTheme;
    const tokens = getUiThemeById(effective, effective === 'dark' ? nextDarkId : nextLightId).tokens;
    runThemeTransition(() => {
      applyThemeTokens(nextTheme, effective, tokens, nextAccentMode, nextAccent);
    });
  }, []);

  const syncCustomCssFromStorage = useCallback(() => {
    const storedCss = localStorageAdapter.readString(STORAGE_KEY_CUSTOM_CSS) || '';
    setCustomCSS((prev) => (prev === storedCss ? prev : storedCss));
    applyCustomCssToDocument(storedCss);
  }, []);

  const rehydrateAllFromStorage = useCallback(() => {
    // Theme & appearance (already have helper)
    syncAppearanceFromStorage();
    syncCustomCssFromStorage();

    // UI Font
    const storedFont = readStoredString(STORAGE_KEY_UI_FONT_FAMILY);
    if (storedFont) setUiFontFamilyId(storedFont);

    // Language
    const storedLang = readStoredString(STORAGE_KEY_UI_LANGUAGE);
    if (storedLang) setUiLanguage(storedLang as UILanguage);

    void netcattyBridge.get()?.getAppLockSettings?.().then((next) => {
      if (next) setAppLockSettingsState(next);
    }).catch(() => {});

    // Terminal
    const storedTermTheme = readStoredString(STORAGE_KEY_TERM_THEME);
    if (storedTermTheme) setTerminalThemeId(storedTermTheme);
    // Cloud sync writes follow-app via applySyncableSettings; without this the
    // open window keeps the pre-sync flag while terminalThemeId updates, which
    // flickers between the local default theme and the synced one (#2757).
    const storedFollowAppTermTheme = readStoredString(STORAGE_KEY_TERM_FOLLOW_APP_THEME);
    if (storedFollowAppTermTheme === 'true' || storedFollowAppTermTheme === 'false') {
      setFollowAppTerminalThemeState(storedFollowAppTermTheme === 'true');
    }
    const storedTermThemeDark = readStoredString(STORAGE_KEY_TERM_THEME_DARK);
    if (storedTermThemeDark) setTerminalThemeDarkId(storedTermThemeDark);
    const storedTermThemeLight = readStoredString(STORAGE_KEY_TERM_THEME_LIGHT);
    if (storedTermThemeLight) setTerminalThemeLightId(storedTermThemeLight);
    const storedTermFont = readStoredString(STORAGE_KEY_TERM_FONT_FAMILY);
    const migratedTermFont = migrateIncomingTerminalFontId(storedTermFont);
    if (migratedTermFont) setTerminalFontFamilyId(migratedTermFont);
    const storedTermSize = readStoredString(STORAGE_KEY_TERM_FONT_SIZE);
    if (storedTermSize != null) applyIncomingTerminalFontSize(storedTermSize);
    const storedTermSettings = readStoredString(STORAGE_KEY_TERM_SETTINGS);
    if (storedTermSettings) {
      try {
        const parsed = JSON.parse(storedTermSettings);
        setTerminalSettings(parsed);
      } catch { /* ignore */ }
    }

    // Keyboard
    const storedKb = parseCustomKeyBindingsStorageRecord(
      localStorageAdapter.readString(STORAGE_KEY_CUSTOM_KEY_BINDINGS),
    );
    if (storedKb) {
      applyIncomingCustomKeyBindings(storedKb);
    }

    // Editor
    const storedWrap = readStoredString(STORAGE_KEY_EDITOR_WORD_WRAP);
    if (storedWrap === 'true' || storedWrap === 'false') setEditorWordWrapState(storedWrap === 'true');

    // SSH diagnostics
    const storedSshDebugLogsEnabled = readStoredString(STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED);
    if (storedSshDebugLogsEnabled === 'true' || storedSshDebugLogsEnabled === 'false') {
      setSshDebugLogsEnabled(storedSshDebugLogsEnabled === 'true');
    }
    const storedSshDeepLinkEnabled = localStorageAdapter.readBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED);
    applyIncomingSshDeepLinkEnabled(storedSshDeepLinkEnabled ?? DEFAULT_SSH_DEEP_LINK_ENABLED);
    const storedJmsDeepLinkEnabled = localStorageAdapter.readBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED);
    applyIncomingJmsDeepLinkEnabled(storedJmsDeepLinkEnabled ?? DEFAULT_JMS_DEEP_LINK_ENABLED);
    const storedExplorerContextMenuEnabled = localStorageAdapter.readBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED);
    applyIncomingExplorerContextMenuEnabled(storedExplorerContextMenuEnabled ?? DEFAULT_EXPLORER_CONTEXT_MENU_ENABLED);

    // SFTP
    const storedDblClick = readStoredString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR);
    if (storedDblClick === 'open' || storedDblClick === 'transfer') setSftpDoubleClickBehavior(storedDblClick);
    const storedAutoSync = readStoredString(STORAGE_KEY_SFTP_AUTO_SYNC);
    if (storedAutoSync === 'true' || storedAutoSync === 'false') setSftpAutoSync(storedAutoSync === 'true');
    const storedHidden = readStoredString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES);
    if (storedHidden === 'true' || storedHidden === 'false') setSftpShowHiddenFiles(storedHidden === 'true');
    const storedCompress = readStoredString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD);
    if (storedCompress === 'true' || storedCompress === 'false') setSftpUseCompressedUpload(storedCompress === 'true');
    const storedSkipUnchanged = localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_SKIP_UNCHANGED);
    if (storedSkipUnchanged != null) setSftpSkipUnchanged(storedSkipUnchanged);
    const storedAutoOpenSidebar = readStoredString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR);
    if (storedAutoOpenSidebar === 'true' || storedAutoOpenSidebar === 'false') setSftpAutoOpenSidebar(storedAutoOpenSidebar === 'true');
    const storedFollowTerminalCwd = readStoredString(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD);
    if (storedFollowTerminalCwd === 'true' || storedFollowTerminalCwd === 'false') {
      setSftpFollowTerminalCwd(storedFollowTerminalCwd === 'true');
    }
    const storedDefaultViewMode = readStoredString(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE);
    if (storedDefaultViewMode === 'list' || storedDefaultViewMode === 'tree') setSftpDefaultViewMode(storedDefaultViewMode);
    const storedShowRecentHosts = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_RECENT_HOSTS);
    setShowRecentHostsState(storedShowRecentHosts ?? DEFAULT_SHOW_RECENT_HOSTS);
    const storedHostClickBehavior = readStoredString(STORAGE_KEY_HOST_CLICK_BEHAVIOR);
    setHostClickBehaviorState(
      isHostClickBehavior(storedHostClickBehavior) ? storedHostClickBehavior : DEFAULT_HOST_CLICK_BEHAVIOR,
    );
    const storedShowOnlyUngroupedHostsInRoot = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT);
    setShowOnlyUngroupedHostsInRootState(storedShowOnlyUngroupedHostsInRoot ?? DEFAULT_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT);
    const storedShowSftpTab = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_SFTP_TAB);
    setShowSftpTabState(storedShowSftpTab ?? DEFAULT_SHOW_SFTP_TAB);
    const storedShowHostTreeSidebar = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR);
    setShowHostTreeSidebarState(storedShowHostTreeSidebar ?? DEFAULT_SHOW_HOST_TREE_SIDEBAR);
    const storedTerminalSidePanelAutoOpen = localStorageAdapter.readBoolean(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN);
    setTerminalSidePanelAutoOpenState(storedTerminalSidePanelAutoOpen ?? DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_ENABLED);
    const storedTerminalSidePanelAutoOpenTab = readStoredString(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB);
    setTerminalSidePanelAutoOpenTabState(
      isTerminalSidePanelAutoOpenTab(storedTerminalSidePanelAutoOpenTab)
        ? storedTerminalSidePanelAutoOpenTab
        : DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
    );
    const storedShellOnlyTabNumberShortcuts = localStorageAdapter.readBoolean(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS);
    setShellOnlyTabNumberShortcutsState(storedShellOnlyTabNumberShortcuts ?? DEFAULT_SHELL_ONLY_TAB_NUMBER_SHORTCUTS);
    const storedShowTabNumberBadges = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_TAB_NUMBER_BADGES);
    setShowTabNumberBadgesState(storedShowTabNumberBadges ?? DEFAULT_SHOW_TAB_NUMBER_BADGES);
    const storedDisableTerminalFontZoom = localStorageAdapter.readBoolean(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM);
    setDisableTerminalFontZoomState(storedDisableTerminalFontZoom ?? DEFAULT_DISABLE_TERMINAL_FONT_ZOOM);
    const storedRestorePreviousSession = localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION);
    setRestorePreviousSessionState(resolveRestorePreviousSessionSetting(storedRestorePreviousSession));
    const storedRestoreTerminalCwd = localStorageAdapter.readBoolean(STORAGE_KEY_RESTORE_TERMINAL_CWD);
    setRestoreTerminalCwdState(resolveRestoreTerminalCwdSetting(storedRestoreTerminalCwd));
    setStartupLandingState(resolveStartupLandingSetting(readStoredString(STORAGE_KEY_STARTUP_LANDING)));

    // Workspace focus style
    const storedFocusStyle = readStoredString(STORAGE_KEY_WORKSPACE_FOCUS_STYLE);
    if (storedFocusStyle === 'dim' || storedFocusStyle === 'border') setWorkspaceFocusStyleState(storedFocusStyle);

    // App-level HTTP(S) network proxy
    setHttpNetworkProxyState(
      normalizeHttpNetworkProxySettings(
        localStorageAdapter.read(STORAGE_KEY_HTTP_NETWORK_PROXY) ?? DEFAULT_HTTP_NETWORK_PROXY,
      ),
    );

    // Custom terminal themes
    customThemeStore.loadFromStorage();
  }, [applyIncomingCustomKeyBindings, applyIncomingExplorerContextMenuEnabled, applyIncomingJmsDeepLinkEnabled, applyIncomingSshDeepLinkEnabled, applyIncomingTerminalFontSize, syncAppearanceFromStorage, syncCustomCssFromStorage, setTerminalSettings]);

  useLayoutEffect(() => {
    const appearanceRender: AppearanceRenderSnapshot = {
      theme,
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      accentMode,
      customAccent,
      customAccentVersion: customAccentRecord.version,
    };
    // Capture previous snapshot before overwrite so we can notify only the
    // appearance fields that actually changed on this render.
    const previousAppearance = previousAppearanceRenderRef.current;
    const persistedAppearanceChanged = previousAppearance === null
      || hasPersistedAppearanceChanged(previousAppearance, appearanceRender);
    previousAppearanceRenderRef.current = appearanceRender;
    // Terminal leaves subscribe here so accent drag does not rebuild TerminalLayer.
    publishAppearanceChromeSnapshot({ accentMode, customAccent });
    const tokens = getUiThemeById(resolvedTheme, resolvedTheme === 'dark' ? darkUiThemeId : lightUiThemeId).tokens;
    const apply = () => applyThemeTokens(theme, resolvedTheme, tokens, accentMode, customAccent);
    const transitionMode = appearanceTransitionModeRef.current;
    appearanceTransitionModeRef.current = 'instant';
    if (persistMountedRef.current) {
      runThemeTransition(apply, { mode: transitionMode });
    } else {
      apply();
    }
    if (!persistedAppearanceChanged && persistMountedRef.current) return;
    localStorageAdapter.writeString(STORAGE_KEY_THEME, theme);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
    localStorageAdapter.writeString(STORAGE_KEY_ACCENT_MODE, accentMode);
    // Never let a stale effect overwrite a newer revision already on disk.
    const storedAccent = parseCustomAccentRecord(
      localStorageAdapter.readString(STORAGE_KEY_COLOR),
    );
    if (
      shouldApplyCustomAccentRecord(storedAccent, customAccentRecord)
      || storedAccent.version === customAccentRecord.version
    ) {
      localStorageAdapter.writeString(
        STORAGE_KEY_COLOR,
        serializeCustomAccentRecord(customAccentRecord),
      );
    }
    // Fix 1: Skip IPC broadcast on initial mount (values already match localStorage)
    if (!persistMountedRef.current) return;
    // Emit a keyed IPC notification for each changed appearance field so the
    // receiver can apply the payload value even if shared storage is still stale.
    // resolveAppearanceSyncState only trusts the announced key's value; other
    // fields fall back to storage, so every changed field must be announced.
    if (!previousAppearance || previousAppearance.theme !== theme) {
      notifySettingsChanged(STORAGE_KEY_THEME, theme);
    }
    if (!previousAppearance || previousAppearance.lightUiThemeId !== lightUiThemeId) {
      notifySettingsChanged(STORAGE_KEY_UI_THEME_LIGHT, lightUiThemeId);
    }
    if (!previousAppearance || previousAppearance.darkUiThemeId !== darkUiThemeId) {
      notifySettingsChanged(STORAGE_KEY_UI_THEME_DARK, darkUiThemeId);
    }
    if (!previousAppearance || previousAppearance.accentMode !== accentMode) {
      notifySettingsChanged(STORAGE_KEY_ACCENT_MODE, accentMode);
    }
    if (
      !previousAppearance
      || previousAppearance.customAccent !== customAccent
      || previousAppearance.customAccentVersion !== customAccentRecord.version
    ) {
      const decision = shouldBroadcastCustomAccentChange(
        customAccentMutationSourceRef.current,
        true,
      );
      customAccentMutationSourceRef.current = decision.nextSource;
      if (decision.shouldBroadcast) {
        notifySettingsChanged(STORAGE_KEY_COLOR, customAccentRecord);
      }
    }
  }, [theme, resolvedTheme, lightUiThemeId, darkUiThemeId, accentMode, customAccent, customAccentRecord, notifySettingsChanged]);

  // Listen for OS color scheme changes to keep systemPreference in sync
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setSystemPreference(e.matches ? 'dark' : 'light');
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useLayoutEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
    document.documentElement.lang = uiLanguage;
    netcattyBridge.get()?.setLanguage?.(uiLanguage);
    // Fix 1: Skip IPC broadcast on initial mount
    if (persistMountedRef.current) {
      notifySettingsChanged(STORAGE_KEY_UI_LANGUAGE, uiLanguage);
    }
  }, [uiLanguage, notifySettingsChanged]);

  // Apply and persist UI font family
  // Re-run when fonts finish loading to get correct family for local fonts
  useLayoutEffect(() => {
    const font = uiFontStore.getFontById(uiFontFamilyId);
    document.documentElement.style.setProperty('--font-sans', withWindowsEmojiFallback(font.family));
    localStorageAdapter.writeString(STORAGE_KEY_UI_FONT_FAMILY, uiFontFamilyId);
    // Fix 1: Skip IPC broadcast on initial mount
    if (persistMountedRef.current) {
      notifySettingsChanged(STORAGE_KEY_UI_FONT_FAMILY, uiFontFamilyId);
    }
  }, [uiFontFamilyId, uiFontsLoaded, notifySettingsChanged]);

  useSettingsIpcSync({
    enabled: enableSettingsSync,
    syncAppearanceFromStorage,
    syncCustomCssFromStorage,
    setUiLanguage,
    setUiFontFamilyId,
    setTerminalThemeId,
    setTerminalThemeDarkId,
    setTerminalThemeLightId,
    setFollowAppTerminalThemeState,
    setTerminalFontFamilyId,
    setTerminalFontSize: applyIncomingTerminalFontSize,
    mergeIncomingTerminalSettings,
    setEditorWordWrapState,
    setSessionLogsEnabled,
    setSessionLogsDir,
    setSessionLogsFormat,
    setSessionLogsTimestampsEnabled,
    setSshDebugLogsEnabled,
    setSshDeepLinkEnabledState: applyIncomingSshDeepLinkEnabled,
    setJmsDeepLinkEnabledState: applyIncomingJmsDeepLinkEnabled,
    setExplorerContextMenuEnabledState: applyIncomingExplorerContextMenuEnabled,
    setHotkeyScheme,
    applyIncomingCustomKeyBindings,
    setIsHotkeyRecordingState,
    setGlobalHotkeyEnabled,
    setWindowOpacity: applyIncomingWindowOpacity,
    setAppIconVariant,
    setAutoUpdateEnabled,
    setAutoLaunchEnabled,
    setHttpNetworkProxy,
    setSftpAutoOpenSidebar,
    setSftpFollowTerminalCwd,
    setSftpDefaultViewMode,
    setWorkspaceFocusStyleState,
    setShowHostTreeSidebarState,
    setTerminalSidePanelAutoOpenState,
    setTerminalSidePanelAutoOpenTabState,
    setDisableTerminalFontZoomState,
    setRestorePreviousSessionState,
    setRestoreTerminalCwdState,
    setStartupLandingState,
    setSftpTransferConcurrencyState,
    setSshTransportIdleTtlMsState,
  });

  useEffect(() => {
    if (!enableSettingsSync) return;
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
  }, [enableSettingsSync]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    let sawPushedSettings = false;

    const unsubscribe = bridge?.onAppLockSettingsChanged?.((next) => {
      sawPushedSettings = true;
      setAppLockSettingsState(next);
    }) ?? (() => {});

    void bridge?.getAppLockSettings?.().then((next) => {
      if (!next || sawPushedSettings) return;
      setAppLockSettingsState(next);
    }).catch(() => {});

    return () => {
      unsubscribe();
    };
  }, []);

  useSettingsStorageSync({
    enabled: enableSettingsSync,
    theme, lightUiThemeId, darkUiThemeId, accentMode, customAccent,
    customAccentVersion: customAccentRecord.version,
    customCSS, uiFontFamilyId, hotkeyScheme, uiLanguage,
    terminalThemeId, followAppTerminalTheme, terminalFontFamilyId, terminalFontSize,
    sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles,
    sftpUseCompressedUpload, sftpSkipUnchanged, sftpAutoOpenSidebar, sftpFollowTerminalCwd, sftpDefaultViewMode,
    showRecentHosts, hostClickBehavior, showOnlyUngroupedHostsInRoot, showSftpTab, showHostTreeSidebar, terminalSidePanelAutoOpen, terminalSidePanelAutoOpenTab, shellOnlyTabNumberShortcuts, showTabNumberBadges, disableTerminalFontZoom, restorePreviousSession, restoreTerminalCwd, startupLanding,
    editorWordWrap, sessionLogsEnabled, sessionLogsDir, sessionLogsFormat, sessionLogsTimestampsEnabled, sshDebugLogsEnabled, sshDeepLinkEnabled, jmsDeepLinkEnabled, explorerContextMenuEnabled,
    globalHotkeyEnabled, autoUpdateEnabled, windowOpacity, appIconVariant,
    setTheme, setLightUiThemeId, setDarkUiThemeId, setAccentMode,
    applyIncomingCustomAccent,
    setCustomCSS, setUiFontFamilyId, setHotkeyScheme, setUiLanguage,
    setTerminalThemeId, setTerminalThemeDarkId, setTerminalThemeLightId,
    setFollowAppTerminalThemeState, setTerminalFontFamilyId, setTerminalFontSize: applyIncomingTerminalFontSize,
    setSftpDoubleClickBehavior, setSftpAutoSync, setSftpShowHiddenFiles,
    setSftpUseCompressedUpload, setSftpSkipUnchanged, setSftpAutoOpenSidebar, setSftpFollowTerminalCwd, setSftpDefaultViewMode,
    setShowRecentHostsState, setHostClickBehaviorState, setShowOnlyUngroupedHostsInRootState, setShowSftpTabState, setShowHostTreeSidebarState, setTerminalSidePanelAutoOpenState, setTerminalSidePanelAutoOpenTabState, setShellOnlyTabNumberShortcutsState, setShowTabNumberBadgesState, setDisableTerminalFontZoomState, setRestorePreviousSessionState, setRestoreTerminalCwdState, setStartupLandingState,
    setEditorWordWrapState, setSessionLogsEnabled, setSessionLogsDir, setSessionLogsFormat, setSessionLogsTimestampsEnabled, setSshDebugLogsEnabled, setSshDeepLinkEnabledState: applyIncomingSshDeepLinkEnabled, setJmsDeepLinkEnabledState: applyIncomingJmsDeepLinkEnabled, setExplorerContextMenuEnabledState: applyIncomingExplorerContextMenuEnabled,
    setGlobalHotkeyEnabled, setWindowOpacity: applyIncomingWindowOpacity, setAppIconVariant, setAutoUpdateEnabled, setWorkspaceFocusStyleState,
    setSftpTransferConcurrencyState, setSshTransportIdleTtlMsState,
    applyIncomingCustomKeyBindings, mergeIncomingTerminalSettings,
  });

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME, terminalThemeId);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERM_THEME, terminalThemeId);
  }, [terminalThemeId, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_FOLLOW_APP_THEME, String(followAppTerminalTheme));
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERM_FOLLOW_APP_THEME, String(followAppTerminalTheme));
  }, [followAppTerminalTheme, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME_DARK, terminalThemeDarkId);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERM_THEME_DARK, terminalThemeDarkId);
  }, [terminalThemeDarkId, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME_LIGHT, terminalThemeLightId);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERM_THEME_LIGHT, terminalThemeLightId);
  }, [terminalThemeLightId, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_FAMILY, terminalFontFamilyId);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERM_FONT_FAMILY, terminalFontFamilyId);
  }, [terminalFontFamilyId, notifySettingsChanged]);

  useEffect(() => {
    const resolution = resolveAuthoritativeTerminalFontSizeStorage(
      terminalFontSizeRecordRef,
      localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_SIZE),
    );
    // If another window already published a newer winner, adopt it instead of
    // displaying and broadcasting a local value that peers will reject.
    if (resolution.shouldAdopt) {
      terminalFontSizeMutationSourceRef.current = 'incoming';
      terminalFontSizeRecordRef.current = resolution.record;
      setTerminalFontSizeRecord(resolution.record);
      return;
    }
    if (resolution.shouldPersist) {
      localStorageAdapter.writeString(
        STORAGE_KEY_TERM_FONT_SIZE,
        resolution.serializedRecord,
      );
    }
    const decision = shouldBroadcastTerminalFontSizeChange(
      terminalFontSizeMutationSourceRef.current,
      persistMountedRef.current,
    );
    terminalFontSizeMutationSourceRef.current = decision.nextSource;
    if (!decision.shouldBroadcast) return;
    notifySettingsChanged(STORAGE_KEY_TERM_FONT_SIZE, resolution.record);
  }, [terminalFontSizeRecord, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.write(STORAGE_KEY_TERM_SETTINGS, terminalSettings);
    if (!persistMountedRef.current) return;
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
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_HOTKEY_SCHEME, hotkeyScheme);
  }, [hotkeyScheme, notifySettingsChanged]);

  useEffect(() => {
    const payload = serializeCustomKeyBindingsStorageRecord({
      version: customKeyBindingsVersionRef.current,
      origin: customKeyBindingsOriginRef.current,
      bindings: customKeyBindings,
    });
    if (localStorageAdapter.readString(STORAGE_KEY_CUSTOM_KEY_BINDINGS) !== payload) {
      localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_KEY_BINDINGS, payload);
    }
    if (!persistMountedRef.current) return;
    if (customKeyBindingsMutationSourceRef.current === 'incoming') return;
    notifySettingsChanged(STORAGE_KEY_CUSTOM_KEY_BINDINGS, {
      version: customKeyBindingsVersionRef.current,
      origin: customKeyBindingsOriginRef.current,
      bindings: customKeyBindings,
    });
  }, [customKeyBindings, notifySettingsChanged]);

  const setIsHotkeyRecording = useCallback((isRecording: boolean) => {
    setIsHotkeyRecordingState(isRecording);
    notifySettingsChanged(STORAGE_KEY_HOTKEY_RECORDING, isRecording);
  }, [notifySettingsChanged]);

  const setShowRecentHosts = useCallback((enabled: boolean) => {
    setShowRecentHostsState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_RECENT_HOSTS, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHOW_RECENT_HOSTS, enabled);
  }, [notifySettingsChanged]);

  const setHostClickBehavior = useCallback((behavior: HostClickBehavior) => {
    setHostClickBehaviorState(behavior);
    localStorageAdapter.writeString(STORAGE_KEY_HOST_CLICK_BEHAVIOR, behavior);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_HOST_CLICK_BEHAVIOR, behavior);
  }, [notifySettingsChanged]);

  const setShowOnlyUngroupedHostsInRoot = useCallback((enabled: boolean) => {
    setShowOnlyUngroupedHostsInRootState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT, enabled);
  }, [notifySettingsChanged]);

  const setShowSftpTab = useCallback((enabled: boolean) => {
    setShowSftpTabState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_SFTP_TAB, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHOW_SFTP_TAB, enabled);
  }, [notifySettingsChanged]);

  const setShowHostTreeSidebar = useCallback((enabled: boolean) => {
    setShowHostTreeSidebarState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR, enabled);
  }, [notifySettingsChanged]);

  const setTerminalSidePanelAutoOpen = useCallback((enabled: boolean) => {
    setTerminalSidePanelAutoOpenState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN, enabled);
  }, [notifySettingsChanged]);

  const setTerminalSidePanelAutoOpenTab = useCallback((tab: TerminalSidePanelAutoOpenTab) => {
    const next = isTerminalSidePanelAutoOpenTab(tab) ? tab : DEFAULT_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB;
    setTerminalSidePanelAutoOpenTabState(next);
    localStorageAdapter.writeString(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB, next);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB, next);
  }, [notifySettingsChanged]);

  const setShellOnlyTabNumberShortcuts = useCallback((enabled: boolean) => {
    setShellOnlyTabNumberShortcutsState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS, enabled);
  }, [notifySettingsChanged]);

  const setShowTabNumberBadges = useCallback((enabled: boolean) => {
    setShowTabNumberBadgesState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_TAB_NUMBER_BADGES, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SHOW_TAB_NUMBER_BADGES, enabled);
  }, [notifySettingsChanged]);

  const setDisableTerminalFontZoom = useCallback((enabled: boolean) => {
    setDisableTerminalFontZoomState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM, enabled);
  }, [notifySettingsChanged]);

  const setRestorePreviousSession = useCallback((enabled: boolean) => {
    setRestorePreviousSessionState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION, enabled);
    if (!enabled) {
      sessionRestoreStorage.clear();
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_RESTORE_PREVIOUS_SESSION, enabled);
  }, [notifySettingsChanged]);

  const setRestoreTerminalCwd = useCallback((enabled: boolean) => {
    setRestoreTerminalCwdState(enabled);
    localStorageAdapter.writeBoolean(STORAGE_KEY_RESTORE_TERMINAL_CWD, enabled);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_RESTORE_TERMINAL_CWD, enabled);
  }, [notifySettingsChanged]);

  const setStartupLanding = useCallback((landing: StartupLanding) => {
    setStartupLandingState(landing);
    localStorageAdapter.writeString(STORAGE_KEY_STARTUP_LANDING, landing);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_STARTUP_LANDING, landing);
  }, [notifySettingsChanged]);

  // Apply and persist custom CSS
  useEffect(() => {
    applyCustomCssToDocument(customCSS);
    localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_CSS, customCSS);
    // Skip IPC on initial mount
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_CUSTOM_CSS, customCSS);
  }, [customCSS, notifySettingsChanged]);

  // Persist SFTP double-click behavior
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, sftpDoubleClickBehavior);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, sftpDoubleClickBehavior);
  }, [sftpDoubleClickBehavior, notifySettingsChanged]);

  // Persist SFTP auto-sync setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_SYNC, sftpAutoSync ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_AUTO_SYNC, sftpAutoSync);
  }, [sftpAutoSync, notifySettingsChanged]);

  // Persist SFTP show hidden files setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, sftpShowHiddenFiles ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, sftpShowHiddenFiles);
  }, [sftpShowHiddenFiles, notifySettingsChanged]);

  // Persist SFTP compressed upload setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, sftpUseCompressedUpload ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, sftpUseCompressedUpload);
  }, [sftpUseCompressedUpload, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeBoolean(STORAGE_KEY_SFTP_SKIP_UNCHANGED, sftpSkipUnchanged);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_SKIP_UNCHANGED, sftpSkipUnchanged);
  }, [sftpSkipUnchanged, notifySettingsChanged]);

  // Persist SFTP auto-open sidebar setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR, sftpAutoOpenSidebar ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR, sftpAutoOpenSidebar);
  }, [sftpAutoOpenSidebar, notifySettingsChanged]);

  // Persist SFTP follow terminal cwd setting
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD, sftpFollowTerminalCwd ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD, sftpFollowTerminalCwd);
  }, [sftpFollowTerminalCwd, notifySettingsChanged]);

  // Persist SFTP default view mode
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE, sftpDefaultViewMode);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE, sftpDefaultViewMode);
  }, [sftpDefaultViewMode, notifySettingsChanged]);

  // Persist Session Logs settings
  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_ENABLED, sessionLogsEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_ENABLED, sessionLogsEnabled);
  }, [sessionLogsEnabled, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_DIR, sessionLogsDir);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_DIR, sessionLogsDir);
  }, [sessionLogsDir, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_FORMAT, sessionLogsFormat);
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_FORMAT, sessionLogsFormat);
  }, [sessionLogsFormat, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED, sessionLogsTimestampsEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED, sessionLogsTimestampsEnabled);
  }, [sessionLogsTimestampsEnabled, notifySettingsChanged]);

  useEffect(() => {
    localStorageAdapter.writeString(STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED, sshDebugLogsEnabled ? 'true' : 'false');
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED, sshDebugLogsEnabled);
  }, [sshDebugLogsEnabled, notifySettingsChanged]);

  useEffect(() => {
    sshDeepLinkEnabledRef.current = sshDeepLinkEnabled;
  }, [sshDeepLinkEnabled]);

  useEffect(() => {
    let cancelled = false;
    const requestIdAtStart = sshDeepLinkSetRequestIdRef.current;
    const bridge = netcattyBridge.get();
    if (!bridge?.getSshDeepLinkEnabled) return;
    void bridge.getSshDeepLinkEnabled().then((enabled) => {
      if (cancelled || typeof enabled !== 'boolean') return;
      if (sshDeepLinkSetRequestIdRef.current !== requestIdAtStart) return;
      sshDeepLinkMutationSourceRef.current = 'incoming';
      setSshDeepLinkEnabledState((prev) => (prev === enabled ? prev : enabled));
      localStorageAdapter.writeBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED, enabled);
    }).catch(() => {
      // The renderer can still use its cached setting when the bridge is unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSshDeepLinkEnabled = useCallback((enabled: boolean) => {
    const previous = sshDeepLinkEnabledRef.current;
    const requestId = sshDeepLinkSetRequestIdRef.current + 1;
    sshDeepLinkSetRequestIdRef.current = requestId;
    sshDeepLinkMutationSourceRef.current = 'local';
    setSshDeepLinkEnabledState(enabled);

    const bridge = netcattyBridge.get();
    if (!bridge?.setSshDeepLinkEnabled) return;
    void bridge.setSshDeepLinkEnabled(enabled).then((result) => {
      if (sshDeepLinkSetRequestIdRef.current !== requestId) return;
      const success = typeof result === 'object' ? result.success : result;
      if (success !== false) return;
      const finalEnabled = typeof result === 'object' && typeof result.enabled === 'boolean'
        ? result.enabled
        : previous;
      sshDeepLinkMutationSourceRef.current = 'incoming';
      setSshDeepLinkEnabledState(finalEnabled);
      localStorageAdapter.writeBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED, finalEnabled);
    }).catch(() => {
      if (sshDeepLinkSetRequestIdRef.current !== requestId) return;
      sshDeepLinkMutationSourceRef.current = 'incoming';
      setSshDeepLinkEnabledState(previous);
      localStorageAdapter.writeBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED, previous);
    });
  }, []);

  useEffect(() => {
    localStorageAdapter.writeBoolean(STORAGE_KEY_SSH_DEEP_LINK_ENABLED, sshDeepLinkEnabled);
    if (sshDeepLinkMutationSourceRef.current === 'incoming') {
      sshDeepLinkMutationSourceRef.current = 'local';
      return;
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_SSH_DEEP_LINK_ENABLED, sshDeepLinkEnabled);
  }, [sshDeepLinkEnabled, notifySettingsChanged]);

  useEffect(() => {
    jmsDeepLinkEnabledRef.current = jmsDeepLinkEnabled;
  }, [jmsDeepLinkEnabled]);

  useEffect(() => {
    let cancelled = false;
    const requestIdAtStart = jmsDeepLinkSetRequestIdRef.current;
    const bridge = netcattyBridge.get();
    if (!bridge?.getJmsDeepLinkEnabled) return;
    void bridge.getJmsDeepLinkEnabled().then((enabled) => {
      if (cancelled || typeof enabled !== 'boolean') return;
      if (jmsDeepLinkSetRequestIdRef.current !== requestIdAtStart) return;
      jmsDeepLinkMutationSourceRef.current = 'incoming';
      setJmsDeepLinkEnabledState((prev) => (prev === enabled ? prev : enabled));
      localStorageAdapter.writeBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED, enabled);
    }).catch(() => {
      // The renderer can still use its cached setting when the bridge is unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setJmsDeepLinkEnabled = useCallback((enabled: boolean) => {
    const previous = jmsDeepLinkEnabledRef.current;
    const requestId = jmsDeepLinkSetRequestIdRef.current + 1;
    jmsDeepLinkSetRequestIdRef.current = requestId;
    jmsDeepLinkMutationSourceRef.current = 'local';
    setJmsDeepLinkEnabledState(enabled);

    const bridge = netcattyBridge.get();
    if (!bridge?.setJmsDeepLinkEnabled) return;
    void bridge.setJmsDeepLinkEnabled(enabled).then((result) => {
      if (jmsDeepLinkSetRequestIdRef.current !== requestId) return;
      const success = typeof result === 'object' ? result.success : result;
      if (success !== false) return;
      const finalEnabled = typeof result === 'object' && typeof result.enabled === 'boolean'
        ? result.enabled
        : previous;
      jmsDeepLinkMutationSourceRef.current = 'incoming';
      setJmsDeepLinkEnabledState(finalEnabled);
      localStorageAdapter.writeBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED, finalEnabled);
    }).catch(() => {
      if (jmsDeepLinkSetRequestIdRef.current !== requestId) return;
      jmsDeepLinkMutationSourceRef.current = 'incoming';
      setJmsDeepLinkEnabledState(previous);
      localStorageAdapter.writeBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED, previous);
    });
  }, []);

  useEffect(() => {
    localStorageAdapter.writeBoolean(STORAGE_KEY_JMS_DEEP_LINK_ENABLED, jmsDeepLinkEnabled);
    if (jmsDeepLinkMutationSourceRef.current === 'incoming') {
      jmsDeepLinkMutationSourceRef.current = 'local';
      return;
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_JMS_DEEP_LINK_ENABLED, jmsDeepLinkEnabled);
  }, [jmsDeepLinkEnabled, notifySettingsChanged]);

  useEffect(() => {
    explorerContextMenuEnabledRef.current = explorerContextMenuEnabled;
  }, [explorerContextMenuEnabled]);

  useEffect(() => {
    let cancelled = false;
    const requestIdAtStart = explorerContextMenuSetRequestIdRef.current;
    const bridge = netcattyBridge.get();
    if (!bridge?.getExplorerContextMenuEnabled) return;
    void bridge.getExplorerContextMenuEnabled().then((result) => {
      if (cancelled) return;
      if (explorerContextMenuSetRequestIdRef.current !== requestIdAtStart) return;
      const enabled = typeof result === 'object' && result
        ? result.enabled
        : result;
      const supported = typeof result === 'object' && result
        ? result.supported === true
        : false;
      setExplorerContextMenuSupported(supported);
      if (typeof enabled !== 'boolean') return;
      explorerContextMenuMutationSourceRef.current = 'incoming';
      setExplorerContextMenuEnabledState((prev) => (prev === enabled ? prev : enabled));
      localStorageAdapter.writeBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED, enabled);
    }).catch(() => {
      // Keep the cached renderer value when the bridge is unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setExplorerContextMenuEnabled = useCallback((enabled: boolean) => {
    const previous = explorerContextMenuEnabledRef.current;
    const requestId = explorerContextMenuSetRequestIdRef.current + 1;
    explorerContextMenuSetRequestIdRef.current = requestId;
    explorerContextMenuMutationSourceRef.current = 'local';
    setExplorerContextMenuEnabledState(enabled);

    const bridge = netcattyBridge.get();
    if (!bridge?.setExplorerContextMenuEnabled) return;
    void bridge.setExplorerContextMenuEnabled(enabled).then((result) => {
      if (explorerContextMenuSetRequestIdRef.current !== requestId) return;
      const success = typeof result === 'object' ? result.success : result;
      if (success !== false) return;
      const finalEnabled = typeof result === 'object' && typeof result.enabled === 'boolean'
        ? result.enabled
        : previous;
      explorerContextMenuMutationSourceRef.current = 'incoming';
      setExplorerContextMenuEnabledState(finalEnabled);
      localStorageAdapter.writeBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED, finalEnabled);
    }).catch(() => {
      if (explorerContextMenuSetRequestIdRef.current !== requestId) return;
      explorerContextMenuMutationSourceRef.current = 'incoming';
      setExplorerContextMenuEnabledState(previous);
      localStorageAdapter.writeBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED, previous);
    });
  }, []);

  useEffect(() => {
    localStorageAdapter.writeBoolean(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED, explorerContextMenuEnabled);
    if (explorerContextMenuMutationSourceRef.current === 'incoming') {
      explorerContextMenuMutationSourceRef.current = 'local';
      return;
    }
    if (!persistMountedRef.current) return;
    notifySettingsChanged(STORAGE_KEY_EXPLORER_CONTEXT_MENU_ENABLED, explorerContextMenuEnabled);
  }, [explorerContextMenuEnabled, notifySettingsChanged]);

  useSystemSettingsEffects({
    enabled: enableSystemEffects,
    toggleWindowHotkey,
    globalHotkeyEnabled,
    closeToTray,
    autoLaunchEnabled,
    windowOpacityRecord,
    windowOpacityMutationSourceRef,
    appIconVariant,
    autoUpdateEnabled,
    httpNetworkProxy,
    persistMountedRef,
    setHotkeyRegistrationError,
    setAutoUpdateEnabled,
    setAppIconVariant,
    setAutoLaunchEnabled,
    setAutoLaunchSupported,
    notifySettingsChanged,
  });

  // Mark persist effects mounted AFTER all persist useEffects so React runs
  // this last (declaration order). Cleanup clears the latch for remount.
  useEffect(() => {
    persistMountedRef.current = true;
    return () => {
      persistMountedRef.current = false;
    };
  }, []);

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
    setCustomKeyBindings(prev => updateCustomKeyBindingRecord(prev, bindingId, scheme, newKey));
  }, [setCustomKeyBindings]);

  // Reset a key binding to default
  const resetKeyBinding = useCallback((bindingId: string, scheme?: 'mac' | 'pc') => {
    setCustomKeyBindings(prev => resetCustomKeyBinding(prev, bindingId, scheme));
  }, [setCustomKeyBindings]);

  // Reset all key bindings to defaults
  const resetAllKeyBindings = useCallback(() => {
    setCustomKeyBindings({});
  }, [setCustomKeyBindings]);

  const updateSyncConfig = useCallback((config: SyncConfig | null) => {
    setSyncConfig(config);
    localStorageAdapter.write(STORAGE_KEY_SYNC, config);
  }, []);

  // Subscribe to custom theme changes so editing in-place triggers re-render
  const customThemes = useCustomThemes();

  const settledTerminalTheme = useMemo(() => resolveGlobalTerminalAppearance({
    userIntent: idleThemeUserIntent(),
    settings: {
      terminalThemeId,
      terminalThemeDarkId,
      terminalThemeLightId,
      followAppTerminalTheme,
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      accentMode,
      customAccent,
    },
    customThemes,
  }).theme, [terminalThemeId, terminalThemeDarkId, terminalThemeLightId, customThemes,
      followAppTerminalTheme, resolvedTheme, lightUiThemeId, darkUiThemeId,
      accentMode, customAccent]);

  const currentTerminalTheme = settledTerminalTheme;

  const updateTerminalSetting = useCallback(<K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K]
  ) => {
    setTerminalSettings(prev => ({ ...prev, [key]: value }));
  }, [setTerminalSettings]);

  const applyAppTheme = useCallback(() => {
    const tokens = getUiThemeById(resolvedTheme, resolvedTheme === 'dark' ? darkUiThemeId : lightUiThemeId).tokens;
    applyThemeTokens(theme, resolvedTheme, tokens, accentMode, customAccent);
  }, [theme, resolvedTheme, lightUiThemeId, darkUiThemeId, accentMode, customAccent]);

  const setEditorWordWrap = useCallback((enabled: boolean) => {
    setEditorWordWrapState(enabled);
    localStorageAdapter.writeString(STORAGE_KEY_EDITOR_WORD_WRAP, String(enabled));
    notifySettingsChanged(STORAGE_KEY_EDITOR_WORD_WRAP, enabled);
  }, [notifySettingsChanged]);

  // Main-window chrome subscribes to this slice instead of receiving the whole
  // settings object through the App domain bags. The store dedupes field by
  // field, so unrelated settings churn never notifies chrome consumers.
  useLayoutEffect(() => {
    publishSettingsChromeSnapshot({
      theme,
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      uiLanguage,
      windowOpacity,
      showSftpTab,
      showHostTreeSidebar,
      showRecentHosts,
      hostClickBehavior,
      showOnlyUngroupedHostsInRoot,
      dynamicTabTitleMode: terminalSettings.dynamicTabTitleMode,
      disableTerminalFontZoom,
      hotkeyScheme,
      shellOnlyTabNumberShortcuts,
      showTabNumberBadges,
      restoreTerminalCwd,
      terminalSidePanelAutoOpen,
      terminalSidePanelAutoOpenTab,
    });
  }, [
    darkUiThemeId,
    disableTerminalFontZoom,
    hostClickBehavior,
    hotkeyScheme,
    lightUiThemeId,
    resolvedTheme,
    restoreTerminalCwd,
    shellOnlyTabNumberShortcuts,
    showHostTreeSidebar,
    showOnlyUngroupedHostsInRoot,
    showRecentHosts,
    showSftpTab,
    showTabNumberBadges,
    terminalSettings.dynamicTabTitleMode,
    terminalSidePanelAutoOpen,
    terminalSidePanelAutoOpenTab,
    theme,
    uiLanguage,
    windowOpacity,
  ]);

  useLayoutEffect(() => {
    registerSettingsChromeActions({ setTheme, setWindowOpacity });
    return () => {
      registerSettingsChromeActions(null);
    };
  }, [setTheme, setWindowOpacity]);

  // TerminalHost / terminal domain bags subscribe here instead of receiving
  // settings through the App mega-subscriber.
  useLayoutEffect(() => {
    publishTerminalSettingsSnapshot({
      terminalThemeId,
      terminalThemeDarkId,
      terminalThemeLightId,
      followAppTerminalTheme,
      terminalFontFamilyId,
      terminalFontSize,
      terminalSettings,
      hotkeyScheme,
      keyBindings,
      isHotkeyRecording,
      sftpDoubleClickBehavior,
      sftpAutoSync,
      sftpShowHiddenFiles,
      sftpUseCompressedUpload,
      sftpAutoOpenSidebar,
      sftpFollowTerminalCwd,
      sftpDefaultViewMode,
      editorWordWrap,
      sessionLogsEnabled,
      sessionLogsDir,
      sessionLogsFormat,
      sessionLogsTimestampsEnabled,
      sshDebugLogsEnabled,
    });
  }, [
    editorWordWrap,
    followAppTerminalTheme,
    hotkeyScheme,
    isHotkeyRecording,
    keyBindings,
    sessionLogsDir,
    sessionLogsEnabled,
    sessionLogsFormat,
    sessionLogsTimestampsEnabled,
    sftpAutoOpenSidebar,
    sftpAutoSync,
    sftpDefaultViewMode,
    sftpDoubleClickBehavior,
    sftpFollowTerminalCwd,
    sftpShowHiddenFiles,
    sftpUseCompressedUpload,
    sshDebugLogsEnabled,
    terminalFontFamilyId,
    terminalFontSize,
    terminalSettings,
    terminalThemeDarkId,
    terminalThemeId,
    terminalThemeLightId,
  ]);

  useLayoutEffect(() => {
    registerTerminalSettingsActions({
      setTerminalThemeId,
      setTerminalThemeDarkId,
      setTerminalThemeLightId,
      setFollowAppTerminalTheme: setFollowAppTerminalThemeState,
      setTerminalFontFamilyId,
      setTerminalFontSize,
      updateTerminalSetting,
      setSftpFollowTerminalCwd,
      setEditorWordWrap,
      applyAppTheme,
    });
    return () => {
      registerTerminalSettingsActions(null);
    };
  }, [
    applyAppTheme,
    setEditorWordWrap,
    setSftpFollowTerminalCwd,
    setTerminalFontFamilyId,
    setTerminalFontSize,
    setTerminalThemeDarkId,
    setTerminalThemeId,
    setTerminalThemeLightId,
    updateTerminalSetting,
  ]);

  return {
    theme,
    setTheme,
    resolvedTheme,
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
    appLockSettings,
    setAppLockTimeoutMinutes,
    requestAppLockEnable,
    requestAppLockDisable,
    requestAppLockPasswordChange,
    setAppLockSystemUnlockEnabled,
    terminalThemeId,
    setTerminalThemeId,
    followAppTerminalTheme,
    setFollowAppTerminalTheme: setFollowAppTerminalThemeState,
    terminalThemeDarkId,
    setTerminalThemeDarkId,
    terminalThemeLightId,
    setTerminalThemeLightId,
    currentTerminalTheme,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
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
    sftpSkipUnchanged,
    setSftpSkipUnchanged,
    sftpAutoOpenSidebar,
    setSftpAutoOpenSidebar,
    sftpFollowTerminalCwd,
    setSftpFollowTerminalCwd,
    sftpDefaultViewMode,
    setSftpDefaultViewMode,
    showRecentHosts,
    setShowRecentHosts,
    hostClickBehavior,
    setHostClickBehavior,
    showOnlyUngroupedHostsInRoot,
    setShowOnlyUngroupedHostsInRoot,
    showSftpTab,
    setShowSftpTab,
    showHostTreeSidebar,
    setShowHostTreeSidebar,
    terminalSidePanelAutoOpen,
    setTerminalSidePanelAutoOpen,
    terminalSidePanelAutoOpenTab,
    setTerminalSidePanelAutoOpenTab,
    shellOnlyTabNumberShortcuts,
    setShellOnlyTabNumberShortcuts,
    showTabNumberBadges,
    setShowTabNumberBadges,
    disableTerminalFontZoom,
    setDisableTerminalFontZoom,
    restorePreviousSession,
    setRestorePreviousSession,
    restoreTerminalCwd,
    setRestoreTerminalCwd,
    startupLanding,
    setStartupLanding,
    sftpTransferConcurrency,
    setSftpTransferConcurrency,
    sshTransportIdleTtlMs,
    setSshTransportIdleTtlMs,
    // Editor Settings
    editorWordWrap,
    setEditorWordWrap,
    // Session Logs
    sessionLogsEnabled,
    setSessionLogsEnabled,
    sessionLogsDir,
    setSessionLogsDir,
    sessionLogsFormat,
    setSessionLogsFormat,
    sessionLogsTimestampsEnabled,
    setSessionLogsTimestampsEnabled,
    sshDebugLogsEnabled,
    setSshDebugLogsEnabled,
    sshDeepLinkEnabled,
    setSshDeepLinkEnabled,
    jmsDeepLinkEnabled,
    setJmsDeepLinkEnabled,
    explorerContextMenuEnabled,
    setExplorerContextMenuEnabled,
    explorerContextMenuSupported,
    // Global Toggle Window (Quake Mode)
    toggleWindowHotkey,
    setToggleWindowHotkey,
    closeToTray,
    setCloseToTray,
    autoLaunchEnabled,
    setAutoLaunchEnabled,
    autoLaunchSupported,
    httpNetworkProxy,
    setHttpNetworkProxy,
    autoUpdateEnabled,
    setAutoUpdateEnabled,
    hotkeyRegistrationError,
    globalHotkeyEnabled,
    setGlobalHotkeyEnabled,
    windowOpacity,
    setWindowOpacity,
    appIconVariant,
    setAppIconVariant,
    rehydrateAllFromStorage,
    applyAppTheme,
    workspaceFocusStyle,
    setWorkspaceFocusStyle,
    // Opaque version that changes when any synced setting changes, used by useAutoSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    settingsVersion: useMemo(() => Math.random(), [
      theme, lightUiThemeId, darkUiThemeId, accentMode,
      uiFontFamilyId, uiLanguage, customCSS,
      terminalThemeId, terminalFontFamilyId, terminalFontSize, terminalSettings,
      customKeyBindings, editorWordWrap,
      sftpDoubleClickBehavior, sftpAutoSync, sftpShowHiddenFiles, sftpUseCompressedUpload, sftpSkipUnchanged, sftpAutoOpenSidebar, sftpFollowTerminalCwd, sftpDefaultViewMode,
      showRecentHosts, hostClickBehavior, showOnlyUngroupedHostsInRoot, showSftpTab, showHostTreeSidebar, terminalSidePanelAutoOpen, terminalSidePanelAutoOpenTab, shellOnlyTabNumberShortcuts, showTabNumberBadges, disableTerminalFontZoom,
      customThemes, workspaceFocusStyle, sessionLogsTimestampsEnabled, sshDebugLogsEnabled, sshDeepLinkEnabled, jmsDeepLinkEnabled, explorerContextMenuEnabled,
    ]),
  };
};
