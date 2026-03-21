/**
 * Sync Payload Builders — Single source of truth for constructing and applying
 * the encrypted cloud-sync payload.
 *
 * Both the main window (App.tsx) and the settings window (SettingsSyncTab.tsx)
 * must use these helpers to guarantee every field is included and no data is
 * silently dropped.
 */

import type {
  Host,
  Identity,
  KnownHost,
  PortForwardingRule,
  Snippet,
  SSHKey,
} from './models';
import type { SyncPayload } from './sync';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';
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
  STORAGE_KEY_TERM_FONT_FAMILY,
  STORAGE_KEY_TERM_FONT_SIZE,
  STORAGE_KEY_TERM_SETTINGS,
  STORAGE_KEY_CUSTOM_KEY_BINDINGS,
  STORAGE_KEY_EDITOR_WORD_WRAP,
  STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR,
  STORAGE_KEY_SFTP_AUTO_SYNC,
  STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES,
  STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD,
  STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR,
  STORAGE_KEY_CUSTOM_THEMES,
} from '../infrastructure/config/storageKeys';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** All vault-owned data that participates in cloud sync. */
export interface SyncableVaultData {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  knownHosts: KnownHost[];
}

/** Callbacks used by `applySyncPayload` to import data into local state. */
interface SyncPayloadImporters {
  /** Import vault data (hosts, keys, identities, snippets, customGroups, snippetPackages, knownHosts). */
  importVaultData: (jsonString: string) => void;
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
  'scrollback', 'drawBoldInBrightColors', 'fontLigatures', 'fontWeight', 'fontWeightBold',
  'linePadding', 'cursorShape', 'cursorBlink', 'minimumContrastRatio',
  'scrollOnInput', 'scrollOnOutput', 'scrollOnKeyPress', 'scrollOnPaste',
  'rightClickBehavior', 'copyOnSelect', 'middleClickPaste', 'wordSeparators',
  'linkModifier', 'keywordHighlightEnabled', 'keywordHighlightRules',
  'keepaliveInterval', 'disableBracketedPaste', 'osc52Clipboard',
] as const;

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
  const termFont = localStorageAdapter.readString(STORAGE_KEY_TERM_FONT_FAMILY);
  if (termFont) settings.terminalFontFamily = termFont;
  const termSize = localStorageAdapter.readNumber(STORAGE_KEY_TERM_FONT_SIZE);
  if (termSize != null) settings.terminalFontSize = termSize;

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
    try {
      settings.customKeyBindings = JSON.parse(kb);
    } catch { /* ignore */ }
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

  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Apply synced settings to localStorage. Merges terminal settings
 * to preserve platform-specific fields.
 */
function applySyncableSettings(settings: NonNullable<SyncPayload['settings']>): void {
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
  if (settings.terminalFontFamily != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_FAMILY, settings.terminalFontFamily);
  if (settings.terminalFontSize != null) localStorageAdapter.writeString(STORAGE_KEY_TERM_FONT_SIZE, String(settings.terminalFontSize));

  // Terminal settings — merge with existing to preserve platform-specific keys
  if (settings.terminalSettings) {
    let existing: Record<string, unknown> = {};
    const raw = localStorageAdapter.readString(STORAGE_KEY_TERM_SETTINGS);
    if (raw) {
      try { existing = JSON.parse(raw); } catch { /* ignore */ }
    }
    const merged = { ...existing };
    for (const key of SYNCABLE_TERMINAL_KEYS) {
      if (key in settings.terminalSettings) {
        merged[key] = settings.terminalSettings[key];
      }
    }
    localStorageAdapter.writeString(STORAGE_KEY_TERM_SETTINGS, JSON.stringify(merged));
  }

  // Custom terminal themes
  if (settings.customTerminalThemes != null) {
    localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_THEMES, JSON.stringify(settings.customTerminalThemes));
  }

  // Keyboard
  if (settings.customKeyBindings != null) {
    localStorageAdapter.writeString(STORAGE_KEY_CUSTOM_KEY_BINDINGS, JSON.stringify(settings.customKeyBindings));
  }

  // Editor
  if (settings.editorWordWrap != null) localStorageAdapter.writeString(STORAGE_KEY_EDITOR_WORD_WRAP, String(settings.editorWordWrap));

  // SFTP
  if (settings.sftpDoubleClickBehavior != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR, settings.sftpDoubleClickBehavior);
  if (settings.sftpAutoSync != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_SYNC, String(settings.sftpAutoSync));
  if (settings.sftpShowHiddenFiles != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES, String(settings.sftpShowHiddenFiles));
  if (settings.sftpUseCompressedUpload != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD, String(settings.sftpUseCompressedUpload));
  if (settings.sftpAutoOpenSidebar != null) localStorageAdapter.writeString(STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR, String(settings.sftpAutoOpenSidebar));
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
    snippets: vault.snippets,
    customGroups: vault.customGroups,
    snippetPackages: vault.snippetPackages,
    knownHosts: vault.knownHosts,
    portForwardingRules,
    settings: collectSyncableSettings(),
    syncedAt: Date.now(),
  };
}

/**
 * Apply a downloaded `SyncPayload` to local state via the provided importers.
 *
 * This ensures both vault data and port-forwarding rules are imported
 * consistently across windows.
 */
export function applySyncPayload(
  payload: SyncPayload,
  importers: SyncPayloadImporters,
): void {
  // Build the vault import object.  knownHosts is only included when the
  // payload explicitly carries the field (even if it's []).  Legacy cloud
  // snapshots may omit it entirely — in that case we leave the local
  // known-hosts list untouched rather than destructively wiping it.
  const vaultImport: Record<string, unknown> = {
    hosts: payload.hosts,
    keys: payload.keys,
    identities: payload.identities,
    snippets: payload.snippets,
    customGroups: payload.customGroups,
  };
  if (payload.snippetPackages !== undefined) {
    vaultImport.snippetPackages = payload.snippetPackages;
  }
  if (payload.knownHosts !== undefined) {
    vaultImport.knownHosts = payload.knownHosts;
  }

  importers.importVaultData(JSON.stringify(vaultImport));

  // Only import port-forwarding rules when the payload explicitly carries
  // them.  Absent field = "payload was created before this feature existed",
  // so local rules are preserved.  Explicitly present [] = "remote has no
  // rules, clear local state".
  if (payload.portForwardingRules !== undefined && importers.importPortForwardingRules) {
    importers.importPortForwardingRules(payload.portForwardingRules);
  }

  // Apply synced settings
  if (payload.settings) {
    applySyncableSettings(payload.settings);
    importers.onSettingsApplied?.();
  }
}
