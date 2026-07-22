/**
 * Sync Payload Builders — Single source of truth for constructing and applying
 * the encrypted cloud-sync payload.
 *
 * Both the main window (App.tsx) and the settings window (SettingsSyncTab.tsx)
 * must use these helpers to guarantee every field is included and no data is
 * silently dropped.
 */

import type {
  GroupConfig,
  Host,
  Identity,
  KnownHost,
  PortForwardingRule,
  ProxyProfile,
  SftpBookmark,
  Snippet,
  SSHKey,
  VaultNote,
} from '../domain/models';
import {
  CLOUD_SYNC_PAYLOAD_ENTITY_KEYS,
  SYNC_PAYLOAD_ENTITY_KEYS,
  hasSyncPayloadEntityData,
  type SyncPayload,
} from '../domain/sync';
import { migrateHostsFromLegacyLineTimestamps } from '../domain/host';
import {
  nextCustomKeyBindingsSyncVersion,
  parseCustomKeyBindingsStorageRecord,
  serializeCustomKeyBindingsStorageRecord,
} from '../domain/customKeyBindings';
import { isEncryptedCredentialPlaceholder } from '../domain/credentials';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';
import { decryptField, encryptField } from '../infrastructure/persistence/secureFieldAdapter';
import { sanitizeQuickMessages } from '../infrastructure/ai/quickMessages';
import { emitAIStateChanged } from './state/aiStateEvents';
import { rehydrateGlobalSftpBookmarks } from './state/sftp/globalSftpBookmarks';
import {
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_THEME_LIGHT,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_COLOR,
  STORAGE_KEY_UI_FONT_FAMILY,
  STORAGE_KEY_UI_LANGUAGE,
  STORAGE_KEY_CUSTOM_CSS,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_TERM_FOLLOW_APP_THEME,
  STORAGE_KEY_TERM_THEME_DARK,
  STORAGE_KEY_TERM_THEME_LIGHT,
  STORAGE_KEY_TERM_FONT_FAMILY,
  STORAGE_KEY_TERM_FONT_SIZE,
  STORAGE_KEY_TERM_SETTINGS,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  STORAGE_KEY_CUSTOM_KEY_BINDINGS,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR,
  STORAGE_KEY_SFTP_AUTO_SYNC,
  STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES,
  STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD,
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD,
  STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE,
  STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS,
  STORAGE_KEY_CUSTOM_THEMES,
  STORAGE_KEY_SHOW_RECENT_HOSTS,
  STORAGE_KEY_HOST_CLICK_BEHAVIOR,
  STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
  STORAGE_KEY_SHOW_SFTP_TAB,
  STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR,
  STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS,
  STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM,
  STORAGE_KEY_WORKSPACE_FOCUS_STYLE,
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_TOOL_INTEGRATION_MODE,
  STORAGE_KEY_AI_HOST_PERMISSIONS,
  STORAGE_KEY_AI_DEFAULT_AGENT,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_COMMAND_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
  STORAGE_KEY_AI_QUICK_MESSAGES,
  STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
  STORAGE_KEY_PORT_FORWARDING,
} from '../infrastructure/config/storageKeys';
import { isTerminalSidePanelAutoOpenTab } from '../domain/terminalSidePanelAutoOpen';
import { prepareRestoredPayloadConvergentWrites } from './convergentSyncReplica';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

const CUSTOM_KEY_BINDINGS_SYNC_PAYLOAD_ORIGIN = 'sync-payload';

/** Vault-owned data. Some fields are local-only and excluded from cloud sync. */
export interface SyncableVaultData {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  proxyProfiles?: ProxyProfile[];
  snippets: Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  notes?: VaultNote[];
  noteGroups?: string[];
  /** Local trust records. Kept in local backups, excluded from cloud sync. */
  knownHosts: KnownHost[];
  groupConfigs?: GroupConfig[];
}

/**
 * Returns true when the payload contains any meaningful user data worth
 * protecting or syncing.
 */
export function hasMeaningfulSyncData(payload: SyncPayload): boolean {
  if (hasSyncPayloadEntityData(payload, SYNC_PAYLOAD_ENTITY_KEYS)) return true;

  return Boolean(
    payload.settings && Object.values(payload.settings).some((value) => value !== undefined),
  );
}

/**
 * Returns true when a payload contains cloud-sync data.
 * Local-only trust records are intentionally ignored.
 */
export function hasMeaningfulCloudSyncData(payload: SyncPayload): boolean {
  if (hasSyncPayloadEntityData(payload, CLOUD_SYNC_PAYLOAD_ENTITY_KEYS)) return true;

  return Boolean(
    payload.settings && Object.values(payload.settings).some((value) => value !== undefined),
  );
}

/**
 * Returns true only when the payload contains synced vault entities.
 * Settings are intentionally ignored so default settings written on first
 * launch do not make a new device look non-empty during cloud restore checks.
 */
export function hasCloudSyncEntityData(payload: SyncPayload): boolean {
  return hasSyncPayloadEntityData(payload, CLOUD_SYNC_PAYLOAD_ENTITY_KEYS);
}

export function shouldPromptCloudVaultRecovery(
  localPayload: SyncPayload,
  remotePayload: SyncPayload,
): boolean {
  return !hasCloudSyncEntityData(localPayload) && hasCloudSyncEntityData(remotePayload);
}

export function sanitizePortForwardingRulesForSync(
  rules: PortForwardingRule[] | undefined,
): PortForwardingRule[] | undefined {
  if (!rules) return rules;
  return rules.map((rule) => ({
    ...rule,
    status: 'inactive' as const,
    error: undefined,
    lastUsedAt: undefined,
  }));
}

export function getEffectivePortForwardingRulesForSync(
  rules: PortForwardingRule[] | undefined,
): PortForwardingRule[] | undefined {
  let effectiveRules = rules;
  if (!effectiveRules || effectiveRules.length === 0) {
    const stored = localStorageAdapter.read<PortForwardingRule[]>(STORAGE_KEY_PORT_FORWARDING);
    if (Array.isArray(stored) && stored.length > 0) {
      effectiveRules = stored;
    }
  }

  return sanitizePortForwardingRulesForSync(effectiveRules);
}

/** Callbacks used by `applySyncPayload` to import data into local state. */
interface SyncPayloadImporters {
  /** Import vault data. Cloud sync excludes local-only known hosts by default. */
  importVaultData: (jsonString: string) => void | Promise<void>;
  /** Import port-forwarding rules (lives outside the vault hook). */
  importPortForwardingRules?: (rules: PortForwardingRule[]) => void;
  /** Called after synced settings have been written to localStorage. */
  onSettingsApplied?: () => void;
}

// ---------------------------------------------------------------------------
// Settings sync helpers
// ---------------------------------------------------------------------------

/** Terminal settings keys that are safe to sync (platform-agnostic). */
const SYNCABLE_TERMINAL_KEYS = [
  'startupCommandDelayMs',
  'scrollback', 'drawBoldInBrightColors', 'terminalEmulationType',
  'fontLigatures', 'fontSmoothing', 'fontWeight', 'fontWeightBold', 'fallbackFont',
  'linePadding', 'cursorShape', 'cursorBlink', 'minimumContrastRatio',
  'altAsMeta', 'optionArrowWordJump', 'shiftEnterNewlineEnabled', 'shiftEnterNewlineText',
  'kittyKeyboardProtocolEnabled',
  'scrollOnInput', 'scrollOnOutput', 'scrollOnKeyPress', 'scrollOnPaste',
  'smoothScrolling',
  'rightClickBehavior', 'middleClickBehavior', 'copyOnSelect', 'normalizeTextOnCopy', 'middleClickPaste', 'wordSeparators',
  'linkModifier', 'keywordHighlightEnabled', 'keywordHighlightRules',
  'keepaliveInterval', 'keepaliveCountMax', 'disableBracketedPaste', 'clearWipesScrollback',
  'preserveSelectionOnInput', 'forcePromptNewLine', 'osc52Clipboard', 'dynamicTabTitleMode',
  'autoCloseOnExit',
  'showHostInfoBar', 'showServerStats',
  'serverStatsRefreshInterval',
  'systemManagerProcessRefreshInterval', 'systemManagerTmuxRefreshInterval',
  'systemManagerDockerListRefreshInterval', 'systemManagerDockerStatsRefreshInterval',
  'rendererType',
  'autocompleteEnabled', 'autocompleteGhostText', 'autocompletePopupMenu',
  'autocompleteDebounceMs', 'autocompleteMinChars', 'autocompleteMaxSuggestions',
] as const;

export const SYNCABLE_SETTING_STORAGE_KEYS = [
  STORAGE_KEY_THEME,
  STORAGE_KEY_UI_THEME_LIGHT,
  STORAGE_KEY_UI_THEME_DARK,
  STORAGE_KEY_ACCENT_MODE,
  STORAGE_KEY_COLOR,
  STORAGE_KEY_UI_FONT_FAMILY,
  STORAGE_KEY_UI_LANGUAGE,
  STORAGE_KEY_CUSTOM_CSS,
  STORAGE_KEY_TERM_THEME,
  STORAGE_KEY_TERM_FOLLOW_APP_THEME,
  STORAGE_KEY_TERM_THEME_DARK,
  STORAGE_KEY_TERM_THEME_LIGHT,
  STORAGE_KEY_TERM_FONT_FAMILY,
  STORAGE_KEY_TERM_FONT_SIZE,
  STORAGE_KEY_TERM_SETTINGS,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
  STORAGE_KEY_CUSTOM_THEMES,
  STORAGE_KEY_CUSTOM_KEY_BINDINGS,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR,
  STORAGE_KEY_SFTP_AUTO_SYNC,
  STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES,
  STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD,
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD,
  STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE,
  STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS,
  STORAGE_KEY_SHOW_RECENT_HOSTS,
  STORAGE_KEY_HOST_CLICK_BEHAVIOR,
  STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
  STORAGE_KEY_SHOW_SFTP_TAB,
  STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS,
  STORAGE_KEY_WORKSPACE_FOCUS_STYLE,
  STORAGE_KEY_AI_PROVIDERS,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_PERMISSION_MODE,
  STORAGE_KEY_AI_TOOL_INTEGRATION_MODE,
  STORAGE_KEY_AI_HOST_PERMISSIONS,
  STORAGE_KEY_AI_DEFAULT_AGENT,
  STORAGE_KEY_AI_COMMAND_BLOCKLIST,
  STORAGE_KEY_AI_COMMAND_TIMEOUT,
  STORAGE_KEY_AI_MAX_ITERATIONS,
  STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP,
  STORAGE_KEY_AI_WEB_SEARCH,
  STORAGE_KEY_AI_QUICK_MESSAGES,
  STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readArraySetting = <T = Record<string, unknown>>(key: string): T[] | null => {
  const value = localStorageAdapter.read<T[]>(key);
  return Array.isArray(value) ? value : null;
};

const readRecordSetting = <T extends Record<string, unknown> = Record<string, unknown>>(key: string): T | null => {
  const value = localStorageAdapter.read<T>(key);
  return isRecord(value) ? value as T : null;
};

const stripDeviceBoundApiKey = <T extends Record<string, unknown>>(value: T): T => {
  if (!isEncryptedCredentialPlaceholder(value.apiKey as string | undefined)) return value;
  const next = { ...value };
  delete next.apiKey;
  return next;
};

const getApiKeyLabel = (value: Record<string, unknown>): string => {
  if (typeof value.name === 'string' && value.name.trim()) return value.name;
  if (typeof value.id === 'string' && value.id.trim()) return value.id;
  if (typeof value.providerId === 'string' && value.providerId.trim()) return value.providerId;
  return 'configured provider';
};

const withPortableApiKey = async <T extends Record<string, unknown>>(value: T): Promise<T> => {
  const apiKey = value.apiKey;
  if (typeof apiKey !== 'string' || !isEncryptedCredentialPlaceholder(apiKey)) return value;

  const decrypted = await decryptField(apiKey).catch(() => undefined);
  if (!decrypted || decrypted === apiKey || isEncryptedCredentialPlaceholder(decrypted)) {
    throw new Error(`Unable to decrypt AI API key for ${getApiKeyLabel(value)}. Sync was stopped to avoid removing the key from cloud sync.`);
  }
  return { ...value, apiKey: decrypted };
};

const withLocalEncryptedApiKey = async <T extends Record<string, unknown>>(value: T): Promise<T> => {
  const apiKey = value.apiKey;
  if (typeof apiKey !== 'string' || isEncryptedCredentialPlaceholder(apiKey)) return value;

  const encrypted = await encryptField(apiKey).catch(() => undefined);
  return { ...value, apiKey: encrypted ?? apiKey };
};

/**
 * `collectSyncableSettings` strips device-bound encrypted apiKeys before upload,
 * so an incoming providers array typically has no apiKey for providers that
 * already exist locally. Re-attach the local apiKey by id; without this merge,
 * applying any synced settings change would silently wipe credentials on the
 * receiving device.
 */
const mergeAiProvidersPreservingLocalApiKeys = (
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  const local = readArraySetting(STORAGE_KEY_AI_PROVIDERS) ?? [];
  const localById = new Map<string, Record<string, unknown>>();
  for (const provider of local) {
    if (typeof provider?.id === 'string') localById.set(provider.id, provider);
  }
  return incoming.map((provider) => {
    if (provider.apiKey != null) return provider;
    const id = typeof provider.id === 'string' ? provider.id : undefined;
    const localProvider = id != null ? localById.get(id) : undefined;
    if (localProvider && typeof localProvider.apiKey === 'string') {
      return { ...provider, apiKey: localProvider.apiKey };
    }
    return provider;
  });
};

/**
 * Same rationale as `mergeAiProvidersPreservingLocalApiKeys`. Only restores the
 * local apiKey when the incoming config still points at the same providerId —
 * switching providers must not silently leak a key meant for a different one.
 */
const mergeWebSearchConfigPreservingLocalApiKey = (
  incoming: Record<string, unknown>,
): Record<string, unknown> => {
  if (incoming.apiKey != null) return incoming;
  const local = readRecordSetting(STORAGE_KEY_AI_WEB_SEARCH);
  if (!local || typeof local.apiKey !== 'string') return incoming;
  if (local.providerId !== incoming.providerId) return incoming;
  return { ...incoming, apiKey: local.apiKey };
};

/**
 * Collect all syncable settings from localStorage.
 */
export function collectSyncableSettings(): SyncPayload['settings'] {
  const settings: SyncPayload['settings'] = {};

  // Theme & Appearance
  const theme = localStorageAdapter.readString(STORAGE_KEY_THEME);
  if (theme === 'light' || theme === 'dark' || theme === 'system') settings.theme = theme;
  const lightUi = localStorageAdapter.readString(STORAGE_KEY_UI_THEME_LIGHT);
  if (lightUi) settings.lightUiThemeId = lightUi;
  const darkUi = localStorageAdapter.readString(STORAGE_KEY_UI_THEME_DARK);
  if (darkUi) settings.darkUiThemeId = darkUi;
  const accentMode = localStorageAdapter.readString(STORAGE_KEY_ACCENT_MODE);
  if (accentMode === 'theme' || accentMode === 'custom') settings.accentMode = accentMode;
  const accent = localStorageAdapter.readString(STORAGE_KEY_COLOR);
  if (accent) settings.customAccent = accent;
  const uiFont = localStorageAdapter.readString(STORAGE_KEY_UI_FONT_FAMILY);
  if (uiFont) settings.uiFontFamilyId = uiFont;
  const lang = localStorageAdapter.readString(STORAGE_KEY_UI_LANGUAGE);
  if (lang) settings.uiLanguage = lang;
  const css = localStorageAdapter.readString(STORAGE_KEY_CUSTOM_CSS);
  if (css != null) settings.customCSS = css;

  // Terminal
  const termTheme = localStorageAdapter.readString(STORAGE_KEY_TERM_THEME);
  if (termTheme) settings.terminalTheme = termTheme;
  const followAppTermTheme = localStorageAdapter.readString(STORAGE_KEY_TERM_FOLLOW_APP_THEME);
  if (followAppTermTheme === 'true' || followAppTermTheme === 'false') {
    settings.followAppTerminalTheme = followAppTermTheme === 'true';
  }
  const termThemeDark = localStorageAdapter.readString(STORAGE_KEY_TERM_THEME_DARK);
  if (termThemeDark) settings.terminalThemeDark = termThemeDark;
  const termThemeLight = localStorageAdapter.readString(STORAGE_KEY_TERM_THEME_LIGHT);
  if (termThemeLight) settings.terminalThemeLight = termThemeLight;
  const termFont = localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_FAMILY);
  if (termFont) settings.terminalFontFamily = termFont;
  const termSize = localStorageAdapter.readNumber(STORAGE_KEY_TERM_FONT_SIZE);
  if (termSize != null) settings.terminalFontSize = termSize;
  const terminalSidePanelAutoOpen = localStorageAdapter.readBoolean(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN);
  if (terminalSidePanelAutoOpen != null) settings.terminalSidePanelAutoOpen = terminalSidePanelAutoOpen;
  const terminalSidePanelAutoOpenTab = localStorageAdapter.readString(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB);
  if (isTerminalSidePanelAutoOpenTab(terminalSidePanelAutoOpenTab)) {
    settings.terminalSidePanelAutoOpenTab = terminalSidePanelAutoOpenTab;
  }

  // Terminal settings (syncable subset only)
  const termSettingsRaw = localStorageAdapter.readString(STORAGE_KEY_TERM_SETTINGS);
  if (termSettingsRaw) {
    try {
      const full = JSON.parse(termSettingsRaw);
      const subset: Record<string, unknown> = {};
      for (const key of SYNCABLE_TERMINAL_KEYS) {
        if (key in full) subset[key] = full[key];
      }
      if (Object.keys(subset).length > 0) settings.terminalSettings = subset;
    } catch { /* ignore corrupt data */ }
  }

  // Custom terminal themes
  const customThemesRaw = localStorageAdapter.readString(STORAGE_KEY_CUSTOM_THEMES);
  if (customThemesRaw) {
    try {
      const parsed = JSON.parse(customThemesRaw);
      if (Array.isArray(parsed)) settings.customTerminalThemes = parsed;
    } catch { /* ignore */ }
  }

  // Keyboard
  const kb = localStorageAdapter.readString(STORAGE_KEY_CUSTOM_KEY_BINDINGS);
  if (kb) {
    const parsed = parseCustomKeyBindingsStorageRecord(kb);
    if (parsed) settings.customKeyBindings = parsed.bindings;
  }

  // Editor
  const wordWrap = localStorageAdapter.readString(STORAGE_KEY_EDITOR_WORD_WRAP);
  if (wordWrap === 'true' || wordWrap === 'false') settings.editorWordWrap = wordWrap === 'true';

  // SFTP
  const dblClick = localStorageAdapter.readString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR);
  if (dblClick === 'open' || dblClick === 'transfer') settings.sftpDoubleClickBehavior = dblClick;
  const autoSync = localStorageAdapter.readString(STORAGE_KEY_SFTP_AUTO_SYNC);
  if (autoSync === 'true' || autoSync === 'false') settings.sftpAutoSync = autoSync === 'true';
  const hidden = localStorageAdapter.readString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES);
  if (hidden === 'true' || hidden === 'false') settings.sftpShowHiddenFiles = hidden === 'true';
  const compress = localStorageAdapter.readString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD);
  if (compress === 'true' || compress === 'false') settings.sftpUseCompressedUpload = compress === 'true';
  const autoOpenSidebar = localStorageAdapter.readString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR);
  if (autoOpenSidebar === 'true' || autoOpenSidebar === 'false') settings.sftpAutoOpenSidebar = autoOpenSidebar === 'true';
  const followTerminalCwd = localStorageAdapter.readString(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD);
  if (followTerminalCwd === 'true' || followTerminalCwd === 'false') settings.sftpFollowTerminalCwd = followTerminalCwd === 'true';
  const defaultViewMode = localStorageAdapter.readString(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE);
  if (defaultViewMode === 'list' || defaultViewMode === 'tree') settings.sftpDefaultViewMode = defaultViewMode;

  // SFTP Bookmarks (global only — local bookmarks are device-specific)
  const globalBookmarks = localStorageAdapter.read<SftpBookmark[]>(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS);
  if (globalBookmarks && Array.isArray(globalBookmarks)) settings.sftpGlobalBookmarks = globalBookmarks;


  const showRecent = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_RECENT_HOSTS);
  if (showRecent != null) settings.showRecentHosts = showRecent;
  const hostClickBehavior = localStorageAdapter.readString(STORAGE_KEY_HOST_CLICK_BEHAVIOR);
  if (hostClickBehavior === 'connect' || hostClickBehavior === 'select') {
    settings.hostClickBehavior = hostClickBehavior;
  }
  const showOnlyUngroupedHostsInRoot = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT);
  if (showOnlyUngroupedHostsInRoot != null) settings.showOnlyUngroupedHostsInRoot = showOnlyUngroupedHostsInRoot;
  const showSftpTab = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_SFTP_TAB);
  if (showSftpTab != null) settings.showSftpTab = showSftpTab;
  const shellOnlyTabNumberShortcuts = localStorageAdapter.readBoolean(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS);
  if (shellOnlyTabNumberShortcuts != null) settings.shellOnlyTabNumberShortcuts = shellOnlyTabNumberShortcuts;
  const disableTerminalFontZoom = localStorageAdapter.readBoolean(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM);
  if (disableTerminalFontZoom != null) settings.disableTerminalFontZoom = disableTerminalFontZoom;
  const showHostTreeSidebar = localStorageAdapter.readBoolean(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR);
  if (showHostTreeSidebar != null) settings.showHostTreeSidebar = showHostTreeSidebar;
  const workspaceFocusStyle = localStorageAdapter.readString(STORAGE_KEY_WORKSPACE_FOCUS_STYLE);
  if (workspaceFocusStyle === 'dim' || workspaceFocusStyle === 'border') {
    settings.workspaceFocusStyle = workspaceFocusStyle;
  }

  const ai: NonNullable<SyncPayload['settings']>['ai'] = {};
  const providers = readArraySetting(STORAGE_KEY_AI_PROVIDERS);
  if (providers) ai.providers = providers.map(stripDeviceBoundApiKey);
  const activeProviderId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER);
  if (activeProviderId != null) ai.activeProviderId = activeProviderId;
  const activeModelId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL);
  if (activeModelId != null) ai.activeModelId = activeModelId;
  const permissionMode = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
  if (permissionMode === 'observer' || permissionMode === 'confirm' || permissionMode === 'auto') {
    ai.globalPermissionMode = permissionMode;
  }
  const toolIntegrationMode = localStorageAdapter.readString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE);
  if (toolIntegrationMode === 'mcp' || toolIntegrationMode === 'skills') {
    ai.toolIntegrationMode = toolIntegrationMode;
  }
  const hostPermissions = readArraySetting(STORAGE_KEY_AI_HOST_PERMISSIONS);
  if (hostPermissions) ai.hostPermissions = hostPermissions;
  // externalAgents intentionally not collected: command/args/env are device-local.
  const defaultAgentId = localStorageAdapter.readString(STORAGE_KEY_AI_DEFAULT_AGENT);
  if (defaultAgentId != null) ai.defaultAgentId = defaultAgentId;
  const commandBlocklist = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (Array.isArray(commandBlocklist)) ai.commandBlocklist = commandBlocklist;
  const commandTimeout = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT);
  if (commandTimeout != null && Number.isFinite(commandTimeout)) ai.commandTimeout = commandTimeout;
  const maxIterations = localStorageAdapter.readNumber(STORAGE_KEY_AI_MAX_ITERATIONS);
  if (maxIterations != null && Number.isFinite(maxIterations)) ai.maxIterations = maxIterations;
  const agentModelMap = readRecordSetting<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP);
  if (agentModelMap) ai.agentModelMap = agentModelMap;
  const agentProviderMap = readRecordSetting<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP);
  if (agentProviderMap) ai.agentProviderMap = agentProviderMap;
  const webSearchConfig = readRecordSetting(STORAGE_KEY_AI_WEB_SEARCH);
  if (webSearchConfig) ai.webSearchConfig = stripDeviceBoundApiKey(webSearchConfig);
  const quickMessages = readArraySetting(STORAGE_KEY_AI_QUICK_MESSAGES);
  if (quickMessages) ai.quickMessages = sanitizeQuickMessages(quickMessages) as unknown as Array<Record<string, unknown>>;
  const showTerminalSelectionAction = localStorageAdapter.readBoolean(STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION);
  if (showTerminalSelectionAction != null) {
    ai.showTerminalSelectionAction = showTerminalSelectionAction;
  }
  if (Object.keys(ai).length > 0) settings.ai = ai;

  return Object.keys(settings).length > 0 ? settings : undefined;
}

export async function collectCloudSyncableSettings(): Promise<SyncPayload['settings']> {
  const settings = collectSyncableSettings();

  const providers = readArraySetting(STORAGE_KEY_AI_PROVIDERS);
  const webSearchConfig = readRecordSetting(STORAGE_KEY_AI_WEB_SEARCH);
  if (!providers && !webSearchConfig) return settings;

  const nextSettings: SyncPayload['settings'] = settings ? { ...settings } : {};
  const ai: NonNullable<SyncPayload['settings']>['ai'] = {
    ...(settings?.ai ?? {}),
  };

  if (providers) {
    ai.providers = await Promise.all(providers.map(withPortableApiKey));
  }
  if (webSearchConfig) {
    ai.webSearchConfig = await withPortableApiKey(webSearchConfig);
  }

  nextSettings.ai = ai;
  return Object.keys(nextSettings).length > 0 ? nextSettings : undefined;
}

function collectLocalBackupSettings(): SyncPayload['settings'] {
  const settings = collectSyncableSettings();

  const providers = readArraySetting(STORAGE_KEY_AI_PROVIDERS);
  const webSearchConfig = readRecordSetting(STORAGE_KEY_AI_WEB_SEARCH);
  if (!providers && !webSearchConfig) return settings;

  const nextSettings: SyncPayload['settings'] = settings ? { ...settings } : {};
  const ai: NonNullable<SyncPayload['settings']>['ai'] = {
    ...(settings?.ai ?? {}),
  };

  if (providers) {
    ai.providers = providers;
  }
  if (webSearchConfig) {
    ai.webSearchConfig = webSearchConfig;
  }

  nextSettings.ai = ai;
  return Object.keys(nextSettings).length > 0 ? nextSettings : undefined;
}

/**
 * Apply synced settings to localStorage. Merges terminal settings
 * to preserve platform-specific fields.
 */
async function applySyncableSettings(settings: NonNullable<SyncPayload['settings']>): Promise<void> {
  // Theme & Appearance
  if (settings.theme != null) localStorageAdapter.writeString(STORAGE_KEY_THEME, settings.theme);
  if (settings.lightUiThemeId != null) localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_LIGHT, settings.lightUiThemeId);
  if (settings.darkUiThemeId != null) localStorageAdapter.writeString(STORAGE_KEY_UI_THEME_DARK, settings.darkUiThemeId);
  if (settings.accentMode != null) localStorageAdapter.writeString(STORAGE_KEY_ACCENT_MODE, settings.accentMode);
  if (settings.customAccent != null) localStorageAdapter.writeString(STORAGE_KEY_COLOR, settings.customAccent);
  if (settings.uiFontFamilyId != null) localStorageAdapter.writeString(STORAGE_KEY_UI_FONT_FAMILY, settings.uiFontFamilyId);
  if (settings.uiLanguage != null) localStorageAdapter.writeString(STORAGE_KEY_UI_LANGUAGE, settings.uiLanguage);
  if (settings.customCSS != null) localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_CSS, settings.customCSS);

  // Terminal
  if (settings.terminalTheme != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME, settings.terminalTheme);
  if (settings.followAppTerminalTheme != null) {
    localStorageAdapter.writeString(STORAGE_KEY_TERM_FOLLOW_APP_THEME, String(settings.followAppTerminalTheme));
  }
  if (settings.terminalThemeDark != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME_DARK, settings.terminalThemeDark);
  if (settings.terminalThemeLight != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_THEME_LIGHT, settings.terminalThemeLight);
  if (settings.terminalFontFamily != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_FAMILY, settings.terminalFontFamily);
  if (settings.terminalFontSize != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_SIZE, String(settings.terminalFontSize));
  if (settings.terminalSidePanelAutoOpen != null) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN, settings.terminalSidePanelAutoOpen);
  }
  if (isTerminalSidePanelAutoOpenTab(settings.terminalSidePanelAutoOpenTab)) {
    localStorageAdapter.writeString(STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB, settings.terminalSidePanelAutoOpenTab);
  }

  // Terminal settings — merge with existing to preserve platform-specific keys
  if (settings.terminalSettings) {
    let existing: Record<string, unknown> = {};
    const raw = localStorageAdapter.readString(STORAGE_KEY_TERM_SETTINGS);
    if (raw) {
      try { existing = JSON.parse(raw); } catch { /* ignore */ }
    }
    const merged = { ...existing };
    const hasIncomingMiddleClickBehavior = 'middleClickBehavior' in settings.terminalSettings;
    const hasIncomingMiddleClickPaste = 'middleClickPaste' in settings.terminalSettings;
    for (const key of SYNCABLE_TERMINAL_KEYS) {
      if (key in settings.terminalSettings) {
        merged[key] = settings.terminalSettings[key];
      }
    }
    if (hasIncomingMiddleClickBehavior) {
      const behavior = settings.terminalSettings.middleClickBehavior;
      if (
        behavior === 'context-menu' ||
        behavior === 'paste' ||
        behavior === 'disabled'
      ) {
        merged.middleClickPaste = behavior === 'paste';
      }
    } else if (hasIncomingMiddleClickPaste) {
      merged.middleClickBehavior = settings.terminalSettings.middleClickPaste === false
        ? 'disabled'
        : 'paste';
    }
    localStorageAdapter.writeString(STORAGE_KEY_TERM_SETTINGS, JSON.stringify(merged));
  }

  // Custom terminal themes
  if (settings.customTerminalThemes != null) {
    localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_THEMES, JSON.stringify(settings.customTerminalThemes));
  }

  // Keyboard
  if (settings.customKeyBindings != null) {
    const previous = parseCustomKeyBindingsStorageRecord(
      localStorageAdapter.readString(STORAGE_KEY_CUSTOM_KEY_BINDINGS),
    );
    localStorageAdapter.writeString(
      STORAGE_KEY_CUSTOM_KEY_BINDINGS,
      serializeCustomKeyBindingsStorageRecord({
        version: nextCustomKeyBindingsSyncVersion(previous?.version || 0),
        origin: CUSTOM_KEY_BINDINGS_SYNC_PAYLOAD_ORIGIN,
        bindings: settings.customKeyBindings,
      }),
    );
  }

  // Editor
  if (settings.editorWordWrap != null) localStorageAdapter.writeString(STORAGE_KEY_EDITOR_WORD_WRAP, String(settings.editorWordWrap));

  // SFTP
  if (settings.sftpDoubleClickBehavior != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, settings.sftpDoubleClickBehavior);
  if (settings.sftpAutoSync != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_SYNC, String(settings.sftpAutoSync));
  if (settings.sftpShowHiddenFiles != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, String(settings.sftpShowHiddenFiles));
  if (settings.sftpUseCompressedUpload != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, String(settings.sftpUseCompressedUpload));
  if (settings.sftpAutoOpenSidebar != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR, String(settings.sftpAutoOpenSidebar));
  if (settings.sftpFollowTerminalCwd != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD, String(settings.sftpFollowTerminalCwd));
  if (settings.sftpDefaultViewMode != null) {
    localStorageAdapter.writeString(STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE, settings.sftpDefaultViewMode);
  }

  // SFTP Bookmarks (global only)
  if (settings.sftpGlobalBookmarks != null) localStorageAdapter.write(STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS, settings.sftpGlobalBookmarks);

  if (settings.showRecentHosts != null) localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_RECENT_HOSTS, settings.showRecentHosts);
  if (settings.hostClickBehavior === 'connect' || settings.hostClickBehavior === 'select') {
    localStorageAdapter.writeString(STORAGE_KEY_HOST_CLICK_BEHAVIOR, settings.hostClickBehavior);
  }
  if (settings.showOnlyUngroupedHostsInRoot != null) {
    localStorageAdapter.writeBoolean(
      STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT,
      settings.showOnlyUngroupedHostsInRoot,
    );
  }
  if (settings.showSftpTab != null) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_SFTP_TAB, settings.showSftpTab);
  }
  if (settings.shellOnlyTabNumberShortcuts != null) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS, settings.shellOnlyTabNumberShortcuts);
  }
  if (settings.disableTerminalFontZoom != null) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM, settings.disableTerminalFontZoom);
  }
  if (settings.showHostTreeSidebar != null) {
    localStorageAdapter.writeBoolean(STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR, settings.showHostTreeSidebar);
  }
  if (settings.workspaceFocusStyle != null) {
    localStorageAdapter.writeString(STORAGE_KEY_WORKSPACE_FOCUS_STYLE, settings.workspaceFocusStyle);
  }

  const ai = settings.ai;
  if (ai) {
    if (ai.providers != null) {
      const providers = await Promise.all(ai.providers.map(withLocalEncryptedApiKey));
      localStorageAdapter.write(
        STORAGE_KEY_AI_PROVIDERS,
        mergeAiProvidersPreservingLocalApiKeys(providers),
      );
    }
    if (ai.activeProviderId != null) localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_PROVIDER, ai.activeProviderId);
    if (ai.activeModelId != null) localStorageAdapter.writeString(STORAGE_KEY_AI_ACTIVE_MODEL, ai.activeModelId);
    if (ai.globalPermissionMode != null) localStorageAdapter.writeString(STORAGE_KEY_AI_PERMISSION_MODE, ai.globalPermissionMode);
    if (ai.toolIntegrationMode != null) localStorageAdapter.writeString(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE, ai.toolIntegrationMode);
    if (ai.hostPermissions != null) localStorageAdapter.write(STORAGE_KEY_AI_HOST_PERMISSIONS, ai.hostPermissions);
    // externalAgents intentionally not applied: device-local. Legacy snapshots
    // that still carry an `externalAgents` field are silently ignored.
    if (ai.defaultAgentId != null) localStorageAdapter.writeString(STORAGE_KEY_AI_DEFAULT_AGENT, ai.defaultAgentId);
    if (ai.commandBlocklist != null) localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, ai.commandBlocklist);
    if (ai.commandTimeout != null) localStorageAdapter.writeNumber(STORAGE_KEY_AI_COMMAND_TIMEOUT, ai.commandTimeout);
    if (ai.maxIterations != null) localStorageAdapter.writeNumber(STORAGE_KEY_AI_MAX_ITERATIONS, ai.maxIterations);
    if (ai.agentModelMap != null) localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, ai.agentModelMap);
    if (ai.agentProviderMap != null) localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, ai.agentProviderMap);
    if (ai.webSearchConfig !== undefined) {
      if (ai.webSearchConfig === null) {
        localStorageAdapter.remove(STORAGE_KEY_AI_WEB_SEARCH);
      } else {
        const webSearchConfig = await withLocalEncryptedApiKey(ai.webSearchConfig);
        localStorageAdapter.write(
          STORAGE_KEY_AI_WEB_SEARCH,
          mergeWebSearchConfigPreservingLocalApiKey(webSearchConfig),
        );
      }
    }
    if (ai.quickMessages != null) {
      localStorageAdapter.write(STORAGE_KEY_AI_QUICK_MESSAGES, sanitizeQuickMessages(ai.quickMessages));
    }
    if (ai.showTerminalSelectionAction != null) {
      localStorageAdapter.writeBoolean(
        STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
        ai.showTerminalSelectionAction,
      );
    }
    // After all AI writes, reconcile per-agent bindings against the final
    // provider list. Sync payloads can land with a new `providers` set but
    // no `agentProviderMap`, or with a stale `agentProviderMap` that
    // points at ids the synced provider set doesn't include — either way
    // we'd leak overrides bound to ghost providers. Mirrors the same
    // cleanup `removeProvider` does for explicit user deletes.
    pruneOrphanPerAgentBindings();
    // Nudge same-window AI state listeners. localStorage writes only fire
    // `storage` events in *other* windows; without this nudge the open
    // chat panel keeps showing pre-sync providers/bindings until reload.
    notifyAIStateAfterSync(ai);
  }
}

function notifyAIStateAfterSync(ai: NonNullable<SyncPayload['settings']>['ai']): void {
  if (!ai) return;
  // Every AI storage key that `applySyncableSettings` may have touched
  // gets a same-window nudge. `useAIState` listens for these and refreshes
  // the corresponding React state by re-reading localStorage.
  const touched: Array<string> = [];
  if (ai.providers != null) touched.push(STORAGE_KEY_AI_PROVIDERS);
  if (ai.activeProviderId != null) touched.push(STORAGE_KEY_AI_ACTIVE_PROVIDER);
  if (ai.activeModelId != null) touched.push(STORAGE_KEY_AI_ACTIVE_MODEL);
  if (ai.globalPermissionMode != null) touched.push(STORAGE_KEY_AI_PERMISSION_MODE);
  if (ai.toolIntegrationMode != null) touched.push(STORAGE_KEY_AI_TOOL_INTEGRATION_MODE);
  if (ai.hostPermissions != null) touched.push(STORAGE_KEY_AI_HOST_PERMISSIONS);
  if (ai.defaultAgentId != null) touched.push(STORAGE_KEY_AI_DEFAULT_AGENT);
  if (ai.commandBlocklist != null) touched.push(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (ai.commandTimeout != null) touched.push(STORAGE_KEY_AI_COMMAND_TIMEOUT);
  if (ai.maxIterations != null) touched.push(STORAGE_KEY_AI_MAX_ITERATIONS);
  if (ai.agentModelMap != null) touched.push(STORAGE_KEY_AI_AGENT_MODEL_MAP);
  // agentProviderMap is *always* potentially mutated because the reconcile
  // step may have pruned it even if the payload didn't ship one.
  touched.push(STORAGE_KEY_AI_AGENT_PROVIDER_MAP);
  // The reconcile may also have pruned saved models alongside provider
  // bindings, so always nudge the model map too.
  if (!touched.includes(STORAGE_KEY_AI_AGENT_MODEL_MAP)) {
    touched.push(STORAGE_KEY_AI_AGENT_MODEL_MAP);
  }
  if (ai.webSearchConfig !== undefined) touched.push(STORAGE_KEY_AI_WEB_SEARCH);
  if (ai.quickMessages != null) touched.push(STORAGE_KEY_AI_QUICK_MESSAGES);
  if (ai.showTerminalSelectionAction != null) {
    touched.push(STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION);
  }
  for (const key of touched) {
    emitAIStateChanged(key);
  }
}

function pruneOrphanPerAgentBindings(): void {
  const providers = localStorageAdapter.read<Array<{ id?: string }>>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  const validIds = new Set(
    providers
      .map((p) => p?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const providerMap = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_PROVIDER_MAP) ?? {};
  const modelMap = localStorageAdapter.read<Record<string, string>>(STORAGE_KEY_AI_AGENT_MODEL_MAP) ?? {};
  let providerChanged = false;
  let modelChanged = false;
  const nextProviderMap: Record<string, string> = {};
  const nextModelMap: Record<string, string> = { ...modelMap };
  for (const agentId of Object.keys(providerMap)) {
    const providerId = providerMap[agentId];
    if (providerId && validIds.has(providerId)) {
      nextProviderMap[agentId] = providerId;
    } else {
      providerChanged = true;
      // Drop the saved model too — that id belonged to the now-missing
      // provider and isn't trustworthy against any other binding.
      if (agentId in nextModelMap) {
        delete nextModelMap[agentId];
        modelChanged = true;
      }
    }
  }
  if (providerChanged) {
    localStorageAdapter.write(STORAGE_KEY_AI_AGENT_PROVIDER_MAP, nextProviderMap);
  }
  if (modelChanged) {
    localStorageAdapter.write(STORAGE_KEY_AI_AGENT_MODEL_MAP, nextModelMap);
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a complete `SyncPayload` from local data.
 *
 * Port-forwarding rules are optional because they are managed by a separate
 * state hook (`usePortForwardingState`).  Callers should strip transient
 * runtime fields (status, error, lastUsedAt) before passing them in.
 */
export function buildSyncPayload(
  vault: SyncableVaultData,
  portForwardingRules?: PortForwardingRule[],
): SyncPayload {
  return {
    hosts: vault.hosts,
    keys: vault.keys,
    identities: vault.identities,
    proxyProfiles: vault.proxyProfiles,
    snippets: vault.snippets,
    customGroups: vault.customGroups,
    snippetPackages: vault.snippetPackages,
    notes: vault.notes,
    noteGroups: vault.noteGroups,
    groupConfigs: vault.groupConfigs,
    portForwardingRules: sanitizePortForwardingRulesForSync(portForwardingRules),
    settings: collectSyncableSettings(),
    syncedAt: Date.now(),
  };
}

export async function buildCloudSyncPayload(
  vault: SyncableVaultData,
  portForwardingRules?: PortForwardingRule[],
): Promise<SyncPayload> {
  return {
    hosts: vault.hosts,
    keys: vault.keys,
    identities: vault.identities,
    proxyProfiles: vault.proxyProfiles,
    snippets: vault.snippets,
    customGroups: vault.customGroups,
    snippetPackages: vault.snippetPackages,
    notes: vault.notes,
    noteGroups: vault.noteGroups,
    groupConfigs: vault.groupConfigs,
    portForwardingRules: sanitizePortForwardingRulesForSync(portForwardingRules),
    settings: await collectCloudSyncableSettings(),
    syncedAt: Date.now(),
  };
}

/** Build a local backup/restore payload, including local-only trust records. */
export function buildLocalVaultPayload(
  vault: SyncableVaultData,
  portForwardingRules?: PortForwardingRule[],
): SyncPayload {
  return {
    ...buildSyncPayload(vault, portForwardingRules),
    settings: collectLocalBackupSettings(),
    knownHosts: vault.knownHosts,
  };
}

/**
 * Apply a downloaded `SyncPayload` to local state via the provided importers.
 *
 * This ensures both vault data and port-forwarding rules are imported
 * consistently across windows.
 */
function applyPayload(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
  options: { includeLocalOnlyData: boolean },
): Promise<void> {
  const legacyLineTimestampsEnabled = payload.settings?.terminalSettings?.showLineTimestamps === true;
  // Build the vault import object. Cloud sync intentionally ignores
  // local-only trust records even if legacy cloud snapshots still carry them.
  const vaultImport: Record<string, unknown> = {
    hosts: migrateHostsFromLegacyLineTimestamps(payload.hosts, legacyLineTimestampsEnabled),
    keys: payload.keys,
    identities: payload.identities,
    proxyProfiles: payload.proxyProfiles,
    snippets: payload.snippets,
    customGroups: payload.customGroups,
  };
  if (payload.snippetPackages !== undefined) {
    vaultImport.snippetPackages = payload.snippetPackages;
  }
  if (payload.notes !== undefined) {
    vaultImport.notes = payload.notes;
  }
  if (payload.noteGroups !== undefined) {
    vaultImport.noteGroups = payload.noteGroups;
  }
  if (options.includeLocalOnlyData && payload.knownHosts !== undefined) {
    vaultImport.knownHosts = payload.knownHosts;
  }
  if (Array.isArray(payload.groupConfigs)) {
    vaultImport.groupConfigs = payload.groupConfigs;
  }

  return Promise.resolve(importers.importVaultData(JSON.stringify(vaultImport))).then(async () => {
    // Only import port-forwarding rules when the payload explicitly carries
    // them.  Absent field = "payload was created before this feature existed",
    // so local rules are preserved.  Explicitly present [] = "remote has no
    // rules, clear local state".
    if (payload.portForwardingRules !== undefined && importers.importPortForwardingRules) {
      importers.importPortForwardingRules(payload.portForwardingRules);
    }

    // Apply synced settings
    if (payload.settings) {
      await applySyncableSettings(payload.settings);
      // Rehydrate in-memory bookmark snapshot after localStorage was updated
      if (payload.settings.sftpGlobalBookmarks != null) rehydrateGlobalSftpBookmarks();
      importers.onSettingsApplied?.();
    }
  });
}

export function applySyncPayload(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
): Promise<void> {
  return applyPayload(payload, importers, { includeLocalOnlyData: false });
}

export async function prepareLocalVaultPayloadApply(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
  dependencies: {
    prepareConvergentRestore?: (
      payload: SyncPayload,
    ) => Promise<() => Promise<void>>;
  } = {},
): Promise<() => Promise<void>> {
  const prepareConvergentRestore = dependencies.prepareConvergentRestore
    ?? prepareRestoredPayloadConvergentWrites;
  const commitConvergentRestore = await prepareConvergentRestore(payload);
  return async () => {
    await applyPayload(payload, importers, { includeLocalOnlyData: true });
    await commitConvergentRestore();
  };
}

export async function applyLocalVaultPayload(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
  dependencies: {
    prepareConvergentRestore?: (
      payload: SyncPayload,
    ) => Promise<() => Promise<void>>;
  } = {},
): Promise<void> {
  const applyPreparedPayload = await prepareLocalVaultPayloadApply(
    payload,
    importers,
    dependencies,
  );
  await applyPreparedPayload();
}
