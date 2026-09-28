import { useSyncExternalStore } from 'react';

import type { UILanguage } from '../../domain/models/connection';
import type { HotkeyScheme } from '../../domain/models/keyBindings';
import type { DynamicTabTitleMode } from '../../domain/models/terminal';
import type { HostClickBehavior } from '../../domain/hostClickBehavior';
import type { TerminalSidePanelAutoOpenTab } from '../../domain/terminalSidePanelAutoOpen';

type Listener = () => void;

export type SettingsChromeTheme = 'dark' | 'light' | 'system';

/**
 * Chrome-facing settings slice. Keep this aligned with what AppView / TopTabs /
 * HostTree actually read. Unrelated settings edits must not rebuild App chrome
 * domain bags — leaves subscribe here instead of receiving the whole settings
 * object through domain props.
 */
export type SettingsChromeSnapshot = {
  theme: SettingsChromeTheme;
  resolvedTheme: 'light' | 'dark';
  lightUiThemeId: string;
  darkUiThemeId: string;
  uiLanguage: UILanguage;
  windowOpacity: number;
  showSftpTab: boolean;
  showHostTreeSidebar: boolean;
  showRecentHosts: boolean;
  hostClickBehavior: HostClickBehavior;
  showOnlyUngroupedHostsInRoot: boolean;
  dynamicTabTitleMode: DynamicTabTitleMode;
  disableTerminalFontZoom: boolean;
  hotkeyScheme: HotkeyScheme;
  shellOnlyTabNumberShortcuts: boolean;
  showTabNumberBadges: boolean;
  restoreTerminalCwd: boolean;
  terminalSidePanelAutoOpen: boolean;
  terminalSidePanelAutoOpenTab: TerminalSidePanelAutoOpenTab;
  localShellSidePanelAutoOpen: boolean;
  localShellSidePanelAutoOpenTab: TerminalSidePanelAutoOpenTab;
};

/**
 * Setters chrome leaves need. Kept on a separate slot from the value snapshot:
 * `useSettingsState` rebuilds these callbacks on its own cadence, and that must
 * never invalidate the value snapshot.
 */
export type SettingsChromeActions = {
  setTheme: (theme: SettingsChromeTheme) => void;
  setWindowOpacity: (opacity: number) => void;
};

export const DEFAULT_SETTINGS_CHROME_SNAPSHOT: SettingsChromeSnapshot = Object.freeze({
  theme: 'system',
  resolvedTheme: 'dark',
  lightUiThemeId: 'default',
  darkUiThemeId: 'default',
  uiLanguage: 'en',
  windowOpacity: 1,
  showSftpTab: true,
  showHostTreeSidebar: true,
  showRecentHosts: true,
  hostClickBehavior: 'connect',
  showOnlyUngroupedHostsInRoot: false,
  dynamicTabTitleMode: 'off',
  disableTerminalFontZoom: false,
  hotkeyScheme: 'pc',
  shellOnlyTabNumberShortcuts: false,
  showTabNumberBadges: true,
  restoreTerminalCwd: true,
  terminalSidePanelAutoOpen: false,
  terminalSidePanelAutoOpenTab: 'ai',
  localShellSidePanelAutoOpen: false,
  localShellSidePanelAutoOpenTab: 'scripts',
} satisfies SettingsChromeSnapshot);

export function settingsChromeSnapshotsEqual(
  a: SettingsChromeSnapshot,
  b: SettingsChromeSnapshot,
): boolean {
  return a.theme === b.theme
    && a.resolvedTheme === b.resolvedTheme
    && a.lightUiThemeId === b.lightUiThemeId
    && a.darkUiThemeId === b.darkUiThemeId
    && a.uiLanguage === b.uiLanguage
    && a.windowOpacity === b.windowOpacity
    && a.showSftpTab === b.showSftpTab
    && a.showHostTreeSidebar === b.showHostTreeSidebar
    && a.showRecentHosts === b.showRecentHosts
    && a.hostClickBehavior === b.hostClickBehavior
    && a.showOnlyUngroupedHostsInRoot === b.showOnlyUngroupedHostsInRoot
    && a.dynamicTabTitleMode === b.dynamicTabTitleMode
    && a.disableTerminalFontZoom === b.disableTerminalFontZoom
    && a.hotkeyScheme === b.hotkeyScheme
    && a.shellOnlyTabNumberShortcuts === b.shellOnlyTabNumberShortcuts
    && a.showTabNumberBadges === b.showTabNumberBadges
    && a.restoreTerminalCwd === b.restoreTerminalCwd
    && a.terminalSidePanelAutoOpen === b.terminalSidePanelAutoOpen
    && a.terminalSidePanelAutoOpenTab === b.terminalSidePanelAutoOpenTab
    && a.localShellSidePanelAutoOpen === b.localShellSidePanelAutoOpen
    && a.localShellSidePanelAutoOpenTab === b.localShellSidePanelAutoOpenTab;
}

class SettingsChromeStore {
  private snapshot: SettingsChromeSnapshot = DEFAULT_SETTINGS_CHROME_SNAPSHOT;
  private actions: SettingsChromeActions | null = null;
  private listeners = new Set<Listener>();
  private actionListeners = new Set<Listener>();

  getSnapshot = (): SettingsChromeSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: SettingsChromeSnapshot): void {
    if (settingsChromeSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  getActions = (): SettingsChromeActions | null => this.actions;

  subscribeActions = (listener: Listener): (() => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  setActions(next: SettingsChromeActions | null): void {
    if (this.actions === next) return;
    this.actions = next;
    for (const listener of this.actionListeners) {
      listener();
    }
  }
}

export const settingsChromeStore = new SettingsChromeStore();

export function publishSettingsChromeSnapshot(
  snapshot: SettingsChromeSnapshot,
): void {
  settingsChromeStore.setSnapshot(snapshot);
}

export function getSettingsChromeSnapshot(): SettingsChromeSnapshot {
  return settingsChromeStore.getSnapshot();
}

export function subscribeSettingsChrome(listener: Listener): () => void {
  return settingsChromeStore.subscribe(listener);
}

export function registerSettingsChromeActions(
  actions: SettingsChromeActions | null,
): void {
  settingsChromeStore.setActions(actions);
}

export function getSettingsChromeActions(): SettingsChromeActions | null {
  return settingsChromeStore.getActions();
}

export function subscribeSettingsChromeActions(listener: Listener): () => void {
  return settingsChromeStore.subscribeActions(listener);
}

export function useSettingsChromeStore(): SettingsChromeSnapshot {
  return useSyncExternalStore(
    subscribeSettingsChrome,
    getSettingsChromeSnapshot,
    getSettingsChromeSnapshot,
  );
}

const noopSetTheme: SettingsChromeActions['setTheme'] = () => {};
const noopSetWindowOpacity: SettingsChromeActions['setWindowOpacity'] = () => {};

/** Chrome setters, safe to call before `useSettingsState` has registered. */
export function useSettingsChromeActions(): SettingsChromeActions {
  const actions = useSyncExternalStore(
    subscribeSettingsChromeActions,
    getSettingsChromeActions,
    getSettingsChromeActions,
  );
  return {
    setTheme: actions?.setTheme ?? noopSetTheme,
    setWindowOpacity: actions?.setWindowOpacity ?? noopSetWindowOpacity,
  };
}
