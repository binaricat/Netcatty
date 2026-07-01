import { isActiveChromeThemeResolvable, resolveActiveChromeTheme } from '../app/activeChromeTheme';
import { clearTopTabsChromeThemeVars } from '../app/topTabsChromeTheme';
import type { TerminalAppearanceHostScope, ResolvedAppearance } from '../../domain/terminalAppearanceRuntime';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { activeTabStore } from './activeTabStore';
import type { EditorTab } from './editorTabStore';
import type { LogView } from './logViewState';
import { syncActiveChromeTheme } from './useActiveChromeTheme';

export type ActiveChromeThemeDeps = {
  accentMode: 'theme' | 'custom';
  applyAppTheme: () => void;
  currentTerminalTheme: TerminalTheme;
  customAccent: string;
  editorTabs: readonly EditorTab[];
  followAppTerminalTheme: boolean;
  hostById: Map<string, Host>;
  logViews: readonly LogView[];
  resolveSessionAppearance?: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  sessionById: Map<string, TerminalSession>;
  themeById: Map<string, TerminalTheme>;
  workspaceById: Map<string, Workspace>;
};

let depsRef: ActiveChromeThemeDeps | null = null;

export function updateActiveChromeThemeDeps(deps: ActiveChromeThemeDeps): void {
  depsRef = deps;
}

export function notifyActiveChromeThemeForTab(activeTabId: string): void {
  if (!depsRef || typeof document === 'undefined') return;
  if (activeTabId === 'vault' || activeTabId === 'sftp') {
    clearTopTabsChromeThemeVars();
  }
  if (!isActiveChromeThemeResolvable({ ...depsRef, activeTabId })) return;
  const activeTheme = resolveActiveChromeTheme({ ...depsRef, activeTabId });
  syncActiveChromeTheme(activeTheme, depsRef.applyAppTheme);
}

activeTabStore.subscribeSync(notifyActiveChromeThemeForTab);
