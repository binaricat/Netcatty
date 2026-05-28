import type { TerminalTheme } from '../../domain/models';
import { classicTerminalThemes } from './terminalThemes/classic';
import { coreTerminalThemes } from './terminalThemes/core';
import { extraTerminalThemes } from './terminalThemes/extra';
import { modernTerminalThemes } from './terminalThemes/modern';
import { uiMatchTerminalThemes } from './terminalThemes/uiMatch';

// Re-export for convenience
export type TerminalThemeConfig = TerminalTheme;

const UI_MATCH_TERMINAL_THEME_IDS = new Set([
  'ui-snow',
  'ui-pure-white',
  'ui-ivory',
  'ui-mist',
  'ui-mint',
  'ui-sand',
  'ui-lavender',
  'ui-pure-black',
  'ui-midnight',
  'ui-deep-blue',
  'ui-vscode',
  'ui-graphite',
  'ui-obsidian',
  'ui-forest',
]);

export const TERMINAL_THEMES: TerminalTheme[] = [
  ...coreTerminalThemes,
  ...uiMatchTerminalThemes,
  ...modernTerminalThemes,
  ...classicTerminalThemes,
  ...extraTerminalThemes,
];


export const isUiMatchTerminalThemeId = (themeId: string): boolean =>
  UI_MATCH_TERMINAL_THEME_IDS.has(themeId);

export const USER_VISIBLE_TERMINAL_THEMES: TerminalTheme[] = TERMINAL_THEMES.filter(
  (theme) => !isUiMatchTerminalThemeId(theme.id),
);
