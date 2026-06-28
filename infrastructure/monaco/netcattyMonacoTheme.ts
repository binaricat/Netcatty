/** Shared Monaco theme colors derived from app CSS variables. */

export interface NetcattyEditorColors {
  bg: string;
  fg: string;
  primary: string;
  card: string;
  mutedFg: string;
  border: string;
}

const hslToHex = (hslString: string): string => {
  const parts = hslString.trim().split(/\s+/);
  if (parts.length < 3) return '#1e1e1e';
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1].replace('%', '')) / 100;
  const l = parseFloat(parts[2].replace('%', '')) / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const getCssColor = (varName: string, fallback: string): string => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value ? hslToHex(value) : fallback;
};

export const getNetcattyEditorColors = (isDark: boolean): NetcattyEditorColors => ({
  bg: getCssColor('--background', isDark ? '#1e1e1e' : '#ffffff'),
  fg: getCssColor('--foreground', isDark ? '#d4d4d4' : '#1e1e1e'),
  primary: getCssColor('--primary', isDark ? '#569cd6' : '#0078d4'),
  card: getCssColor('--card', isDark ? '#252526' : '#f3f3f3'),
  mutedFg: getCssColor('--muted-foreground', '#858585'),
  border: getCssColor('--border', isDark ? '#3c3c3c' : '#d4d4d4'),
});

export const getNetcattyThemeSignal = (): string => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return '';
  }
  const root = document.documentElement;
  return root.dataset.activeChromeTheme
    ?? getComputedStyle(root).getPropertyValue('--background').trim();
};

export const NETCATTY_MONACO_THEME_DARK = 'netcatty-dark';
export const NETCATTY_MONACO_THEME_LIGHT = 'netcatty-light';

export const getNetcattyMonacoThemeName = (isDark: boolean): string => (
  isDark ? NETCATTY_MONACO_THEME_DARK : NETCATTY_MONACO_THEME_LIGHT
);

export const buildNetcattyMonacoThemeColors = (
  colors: NetcattyEditorColors,
): Record<string, string> => ({
  'editor.background': colors.bg,
  'editor.foreground': colors.fg,
  'editorCursor.foreground': colors.primary,
  'editor.selectionBackground': `${colors.primary}40`,
  'editor.inactiveSelectionBackground': `${colors.primary}25`,
  'editorLineNumber.foreground': colors.mutedFg,
  'editorLineNumber.activeForeground': colors.fg,
  'editor.lineHighlightBackground': `${colors.fg}08`,
  'editorWidget.background': colors.card,
  'editorWidget.foreground': colors.fg,
  'editorWidget.border': colors.border,
  'input.background': colors.card,
  'input.foreground': colors.fg,
  'input.border': colors.border,
});
