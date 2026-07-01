import type { TerminalTheme } from '../../domain/models';

export const TERMINAL_APPEARANCE_VAR_KEYS = [
  '--nc-term-bg',
  '--nc-term-fg',
  '--nc-term-cursor',
  '--nc-term-border',
  '--nc-term-muted',
  '--nc-term-hover',
  '--nc-term-active',
  '--nc-term-panel-bg',
  '--nc-term-panel-fg',
  '--nc-term-panel-muted',
  '--nc-term-panel-border',
  '--nc-term-panel-hover',
  '--nc-term-panel-active',
  '--nc-term-host-tree-bg',
  '--nc-term-host-tree-fg',
  '--nc-term-host-tree-muted',
  '--nc-term-host-tree-separator',
  '--nc-term-host-tree-hover-bg',
  '--nc-term-host-tree-active-bg',
  '--nc-term-host-tree-drop-bg',
  '--nc-term-host-tree-folder-fg',
  '--nc-term-tabs-bg',
  '--nc-term-tabs-fg',
  '--nc-term-tabs-muted',
  '--nc-term-tabs-active-bg',
  '--nc-term-tabs-accent',
  '--nc-term-toolbar-btn',
  '--nc-term-toolbar-btn-hover',
  '--nc-term-toolbar-btn-active',
] as const;

export type TerminalAppearanceCssVarKey = (typeof TERMINAL_APPEARANCE_VAR_KEYS)[number];
export type TerminalAppearanceCssVars = Record<TerminalAppearanceCssVarKey, string>;

function mix(fg: string, bg: string, fgPercent: number): string {
  return `color-mix(in srgb, ${fg} ${fgPercent}%, ${bg} ${100 - fgPercent}%)`;
}

export function buildTerminalAppearanceCssVars(theme: TerminalTheme): TerminalAppearanceCssVars {
  const bg = theme.colors.background;
  const fg = theme.colors.foreground;
  const cursor = theme.colors.cursor;
  const muted = mix(fg, bg, 58);
  const hover = mix(fg, bg, 12);
  const active = mix(fg, bg, 16);
  const border = mix(fg, bg, 12);
  const panelMuted = mix(fg, bg, 58);
  const panelHover = mix(fg, bg, 12);
  const panelActive = mix(fg, bg, 16);
  const panelBorder = mix(fg, bg, 12);
  const hostMuted = mix(fg, bg, 55);
  const hostSeparator = mix(fg, bg, 10);
  const hostHover = mix(fg, bg, 8);
  const hostActive = mix(fg, bg, 14);
  const hostDrop = mix(fg, bg, 20);
  const hostFolder = mix(fg, bg, 75);
  const toolbarBtn = mix(bg, fg, 12);
  const toolbarBtnHover = mix(bg, fg, 22);
  const toolbarBtnActive = mix(cursor, bg, 22);

  return {
    '--nc-term-bg': bg,
    '--nc-term-fg': fg,
    '--nc-term-cursor': cursor,
    '--nc-term-border': border,
    '--nc-term-muted': muted,
    '--nc-term-hover': hover,
    '--nc-term-active': active,
    '--nc-term-panel-bg': bg,
    '--nc-term-panel-fg': fg,
    '--nc-term-panel-muted': panelMuted,
    '--nc-term-panel-border': panelBorder,
    '--nc-term-panel-hover': panelHover,
    '--nc-term-panel-active': panelActive,
    '--nc-term-host-tree-bg': bg,
    '--nc-term-host-tree-fg': fg,
    '--nc-term-host-tree-muted': hostMuted,
    '--nc-term-host-tree-separator': hostSeparator,
    '--nc-term-host-tree-hover-bg': hostHover,
    '--nc-term-host-tree-active-bg': hostActive,
    '--nc-term-host-tree-drop-bg': hostDrop,
    '--nc-term-host-tree-folder-fg': hostFolder,
    '--nc-term-tabs-bg': hover,
    '--nc-term-tabs-fg': fg,
    '--nc-term-tabs-muted': muted,
    '--nc-term-tabs-active-bg': bg,
    '--nc-term-tabs-accent': cursor,
    '--nc-term-toolbar-btn': toolbarBtn,
    '--nc-term-toolbar-btn-hover': toolbarBtnHover,
    '--nc-term-toolbar-btn-active': toolbarBtnActive,
  };
}

export type HostTreeThemeColors = {
  termBg: string;
  termFg: string;
  mutedFg: string;
  separator: string;
  rowHoverBg: string;
  rowActiveBg: string;
  rowDropBg: string;
  folderFg: string;
};

export type SidePanelChromeTheme = {
  termBg: string;
  termFg: string;
  mutedFg: string;
  separator: string;
  accent: string;
};

export function buildSidePanelChromeThemeFromTerminalTheme(theme: TerminalTheme): SidePanelChromeTheme {
  const bg = theme.colors.background;
  const fg = theme.colors.foreground;
  return {
    termBg: bg,
    termFg: fg,
    mutedFg: mix(fg, bg, 58),
    separator: mix(fg, bg, 12),
    accent: theme.colors.cursor,
  };
}

export function buildHostTreeThemeFromTerminalTheme(theme: TerminalTheme): HostTreeThemeColors {
  const bg = theme.colors.background;
  const fg = theme.colors.foreground;
  return {
    termBg: bg,
    termFg: fg,
    mutedFg: mix(fg, bg, 55),
    separator: mix(fg, bg, 10),
    rowHoverBg: mix(fg, bg, 8),
    rowActiveBg: mix(fg, bg, 14),
    rowDropBg: mix(fg, bg, 20),
    folderFg: mix(fg, bg, 75),
  };
}

export const terminalAppearancePanelStyle = {
  backgroundColor: 'var(--nc-term-panel-bg, var(--background))',
  color: 'var(--nc-term-panel-fg, var(--foreground))',
  borderColor: 'var(--nc-term-panel-border, var(--border))',
} as const;

export const terminalAppearanceSidePanelStyle = {
  ['--terminal-sidepanel-bg' as const]: 'var(--nc-term-panel-bg, var(--background))',
  ['--terminal-sidepanel-fg' as const]: 'var(--nc-term-panel-fg, var(--foreground))',
  ['--terminal-sidepanel-accent' as const]: 'var(--nc-term-cursor, var(--accent))',
  ['--terminal-sidepanel-muted' as const]: 'var(--nc-term-panel-muted, var(--muted-foreground))',
  ['--terminal-sidepanel-border' as const]: 'var(--nc-term-panel-border, var(--border))',
  backgroundColor: 'var(--nc-term-panel-bg, var(--background))',
  color: 'var(--nc-term-panel-fg, var(--foreground))',
  borderColor: 'var(--nc-term-panel-border, var(--border))',
} as const;

export const terminalAppearanceThemePanelVars = {
  ['--terminal-panel-bg' as const]: 'var(--nc-term-panel-bg, var(--background))',
  ['--terminal-panel-fg' as const]: 'var(--nc-term-panel-fg, var(--foreground))',
  ['--terminal-panel-muted' as const]: 'var(--nc-term-panel-muted, var(--muted-foreground))',
  ['--terminal-panel-border' as const]: 'var(--nc-term-panel-border, var(--border))',
  ['--terminal-panel-hover' as const]: 'var(--nc-term-panel-hover, var(--accent))',
  ['--terminal-panel-active' as const]: 'var(--nc-term-panel-active, var(--accent))',
} as const;

export const terminalAppearanceHostTreeTheme = {
  termBg: 'var(--nc-term-host-tree-bg, var(--nc-term-bg, var(--background)))',
  termFg: 'var(--nc-term-host-tree-fg, var(--nc-term-fg, var(--foreground)))',
  mutedFg: 'var(--nc-term-host-tree-muted, var(--nc-term-muted, var(--muted-foreground)))',
  separator: 'var(--nc-term-host-tree-separator, var(--nc-term-border, var(--border)))',
  rowHoverBg: 'var(--nc-term-host-tree-hover-bg, var(--nc-term-hover, transparent))',
  rowActiveBg: 'var(--nc-term-host-tree-active-bg, var(--nc-term-active, transparent))',
  rowDropBg: 'var(--nc-term-host-tree-drop-bg, var(--nc-term-active, transparent))',
  folderFg: 'var(--nc-term-host-tree-folder-fg, var(--nc-term-fg, var(--foreground)))',
} as const;
