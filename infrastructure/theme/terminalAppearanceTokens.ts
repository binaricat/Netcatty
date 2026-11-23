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

type RgbColor = { red: number; green: number; blue: number };

const parseHexColor = (value: string): RgbColor | null => {
  const normalized = value.trim().replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
  };
};

const mixRgb = (foreground: RgbColor, background: RgbColor, foregroundRatio: number): RgbColor => ({
  red: foreground.red * foregroundRatio + background.red * (1 - foregroundRatio),
  green: foreground.green * foregroundRatio + background.green * (1 - foregroundRatio),
  blue: foreground.blue * foregroundRatio + background.blue * (1 - foregroundRatio),
});

const rgbToHslToken = ({ red, green, blue }: RgbColor): string => {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta > 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * (((b - r) / delta) + 2);
    else hue = 60 * (((r - g) / delta) + 4);
  }

  if (hue < 0) hue += 360;
  const format = (value: number) => Number(value.toFixed(2));
  return `${format(hue)} ${format(saturation * 100)}% ${format(lightness * 100)}%`;
};

const relativeLuminance = ({ red, green, blue }: RgbColor): number => {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
};

const contrastRatio = (first: RgbColor, second: RgbColor): number => {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

const BLACK_RGB: RgbColor = { red: 0, green: 0, blue: 0 };
const WHITE_RGB: RgbColor = { red: 255, green: 255, blue: 255 };
const SAFE_TEXT_CONTRAST = 4.55;

const readableForegroundRgb = (background: RgbColor, preferred?: RgbColor): RgbColor => {
  if (preferred && contrastRatio(preferred, background) >= SAFE_TEXT_CONTRAST) return preferred;
  return contrastRatio(WHITE_RGB, background) >= contrastRatio(BLACK_RGB, background)
    ? WHITE_RGB
    : BLACK_RGB;
};

const minimumContrastRatio = (foreground: RgbColor, backgrounds: RgbColor[]): number => (
  Math.min(...backgrounds.map((background) => contrastRatio(foreground, background)))
);

const ensureReadableRgb = (
  preferred: RgbColor,
  backgrounds: RgbColor[],
  fallbackCandidates: RgbColor[] = [BLACK_RGB, WHITE_RGB],
): RgbColor => {
  if (minimumContrastRatio(preferred, backgrounds) >= SAFE_TEXT_CONTRAST) return preferred;

  const fallback = fallbackCandidates.reduce((best, candidate) => (
    minimumContrastRatio(candidate, backgrounds) > minimumContrastRatio(best, backgrounds)
      ? candidate
      : best
  ));

  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixRgb(fallback, preferred, step / 100);
    if (minimumContrastRatio(candidate, backgrounds) >= SAFE_TEXT_CONTRAST) return candidate;
  }
  return fallback;
};

const keepSurfaceReadableBy = (
  preferredSurface: RgbColor,
  background: RgbColor,
  foreground: RgbColor,
): RgbColor => {
  if (contrastRatio(foreground, preferredSurface) >= SAFE_TEXT_CONTRAST) return preferredSurface;
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixRgb(background, preferredSurface, step / 100);
    if (contrastRatio(foreground, candidate) >= SAFE_TEXT_CONTRAST) return candidate;
  }
  return background;
};

export type TerminalSidePanelCssVars = Record<
  | '--background'
  | '--foreground'
  | '--card'
  | '--card-foreground'
  | '--popover'
  | '--popover-foreground'
  | '--primary'
  | '--primary-foreground'
  | '--secondary'
  | '--secondary-foreground'
  | '--muted'
  | '--muted-foreground'
  | '--accent'
  | '--accent-foreground'
  | '--destructive'
  | '--destructive-foreground'
  | '--border'
  | '--input'
  | '--ring',
  string
>;

export function buildTerminalSidePanelCssVars(theme: TerminalTheme): TerminalSidePanelCssVars {
  const backgroundRgb = parseHexColor(theme.colors.background) ?? BLACK_RGB;
  const preferredForegroundRgb = parseHexColor(theme.colors.foreground) ?? WHITE_RGB;
  const foregroundRgb = readableForegroundRgb(backgroundRgb, preferredForegroundRgb);
  const preferredCursorRgb = parseHexColor(theme.colors.cursor) ?? foregroundRgb;
  const preferredRedRgb = parseHexColor(theme.colors.red) ?? { red: 220, green: 38, blue: 38 };
  const cursorRgb = ensureReadableRgb(preferredCursorRgb, [backgroundRgb], [foregroundRgb, BLACK_RGB, WHITE_RGB]);
  const redRgb = ensureReadableRgb(preferredRedRgb, [backgroundRgb], [foregroundRgb, BLACK_RGB, WHITE_RGB]);
  const secondaryRgb = keepSurfaceReadableBy(
    mixRgb(foregroundRgb, backgroundRgb, 0.12),
    backgroundRgb,
    foregroundRgb,
  );
  const mutedRgb = keepSurfaceReadableBy(
    mixRgb(foregroundRgb, backgroundRgb, 0.08),
    backgroundRgb,
    foregroundRgb,
  );
  const preferredMutedForegroundRgb = mixRgb(foregroundRgb, backgroundRgb, 0.58);
  const mutedForegroundRgb = ensureReadableRgb(
    preferredMutedForegroundRgb,
    [backgroundRgb, mutedRgb],
    [foregroundRgb, BLACK_RGB, WHITE_RGB],
  );
  const secondaryForegroundRgb = ensureReadableRgb(
    foregroundRgb,
    [secondaryRgb],
    [BLACK_RGB, WHITE_RGB],
  );
  const accentRgb = mixRgb(foregroundRgb, backgroundRgb, 0.16);
  const borderRgb = mixRgb(foregroundRgb, backgroundRgb, 0.12);
  const background = rgbToHslToken(backgroundRgb);
  const foreground = rgbToHslToken(foregroundRgb);
  const primary = rgbToHslToken(cursorRgb);
  const secondary = rgbToHslToken(secondaryRgb);
  const muted = rgbToHslToken(mutedRgb);
  const mutedForeground = rgbToHslToken(mutedForegroundRgb);
  const accent = rgbToHslToken(accentRgb);
  const accentForeground = rgbToHslToken(readableForegroundRgb(accentRgb, foregroundRgb));
  const border = rgbToHslToken(borderRgb);
  const destructive = rgbToHslToken(redRgb);

  return {
    '--background': background,
    '--foreground': foreground,
    '--card': background,
    '--card-foreground': foreground,
    '--popover': background,
    '--popover-foreground': foreground,
    '--primary': primary,
    '--primary-foreground': rgbToHslToken(readableForegroundRgb(cursorRgb)),
    '--secondary': secondary,
    '--secondary-foreground': rgbToHslToken(secondaryForegroundRgb),
    '--muted': muted,
    '--muted-foreground': mutedForeground,
    '--accent': accent,
    '--accent-foreground': accentForeground,
    '--destructive': destructive,
    '--destructive-foreground': rgbToHslToken(readableForegroundRgb(redRgb)),
    '--border': border,
    '--input': border,
    '--ring': primary,
  };
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
