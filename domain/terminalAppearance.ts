import { Host, TerminalTheme } from './models';

const hasLegacyStringValue = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const hasLegacyNumberValue = (value: number | undefined): boolean =>
  typeof value === 'number' && !Number.isNaN(value);

const hasEffectiveOverride = (
  explicitOverride: boolean | undefined,
  legacyValuePresent: boolean,
): boolean => explicitOverride === true || (explicitOverride === undefined && legacyValuePresent);

export const hasHostThemeOverride = (host?: Pick<Host, 'themeOverride' | 'theme'> | null): boolean =>
  hasEffectiveOverride(host?.themeOverride, hasLegacyStringValue(host?.theme));

export const hasHostFontFamilyOverride = (host?: Pick<Host, 'fontFamilyOverride' | 'fontFamily'> | null): boolean =>
  hasEffectiveOverride(host?.fontFamilyOverride, hasLegacyStringValue(host?.fontFamily));

export const hasHostFontSizeOverride = (host?: Pick<Host, 'fontSizeOverride' | 'fontSize'> | null): boolean =>
  hasEffectiveOverride(host?.fontSizeOverride, hasLegacyNumberValue(host?.fontSize));

export const clearHostThemeOverride = (host: Host): Host => ({
  ...host,
  theme: undefined,
  themeOverride: false,
});

export const clearHostFontFamilyOverride = (host: Host): Host => ({
  ...host,
  fontFamily: undefined,
  fontFamilyOverride: false,
});

export const clearHostFontSizeOverride = (host: Host): Host => ({
  ...host,
  fontSize: undefined,
  fontSizeOverride: false,
});

export const resolveHostTerminalThemeId = (host: Host | null | undefined, defaultThemeId: string): string =>
  hasHostThemeOverride(host) && host?.theme ? host.theme : defaultThemeId;

/**
 * Map a UI theme preset ID to the terminal theme whose background matches
 * it exactly. Used when "Follow Application Theme" is enabled so the
 * terminal blends seamlessly with the app chrome. Returns undefined if no
 * match exists (caller should fall back to the global terminal theme).
 */
const UI_TO_TERMINAL_THEME: Record<string, string> = {
  // Light
  'snow': 'ui-snow',
  'pure-white': 'ui-pure-white',
  'ivory': 'ui-ivory',
  'mist': 'ui-mist',
  'mint': 'ui-mint',
  'sand': 'ui-sand',
  'lavender': 'ui-lavender',
  // Dark
  'pure-black': 'ui-pure-black',
  'midnight': 'ui-midnight',
  'deep-blue': 'ui-deep-blue',
  'vscode': 'ui-vscode',
  'graphite': 'ui-graphite',
  'obsidian': 'ui-obsidian',
  'forest': 'ui-forest',
};

export const getTerminalThemeForUiTheme = (uiThemeId: string): string | undefined =>
  UI_TO_TERMINAL_THEME[uiThemeId];

type ParsedHslToken = {
  hue: number;
  saturation: number;
  lightness: number;
};

const parseHslToken = (value: string): ParsedHslToken | null => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return null;

  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const lightness = Number(match[3]);
  if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(lightness)) return null;
  if (saturation < 0 || saturation > 100 || lightness < 0 || lightness > 100) return null;

  return {
    hue: ((hue % 360) + 360) % 360,
    saturation,
    lightness,
  };
};

const toHexChannel = (value: number): string =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');

const hslToHex = ({ hue, saturation, lightness }: ParsedHslToken): string => {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const m = l - c / 2;
  return `#${toHexChannel((r + m) * 255)}${toHexChannel((g + m) * 255)}${toHexChannel((b + m) * 255)}`;
};

const terminalSelectionFromAccent = (accent: ParsedHslToken, type: TerminalTheme['type']): ParsedHslToken => ({
  ...accent,
  lightness: type === 'dark'
    ? Math.max(18, Math.min(32, accent.lightness * 0.55))
    : Math.max(72, Math.min(88, accent.lightness + 42)),
});

export const applyCustomAccentToTerminalTheme = (
  theme: TerminalTheme,
  accentMode: 'theme' | 'custom',
  customAccent: string,
): TerminalTheme => {
  if (accentMode !== 'custom') return theme;

  const accent = parseHslToken(customAccent);
  if (!accent) return theme;

  return {
    ...theme,
    colors: {
      ...theme.colors,
      cursor: hslToHex(accent),
      selection: hslToHex(terminalSelectionFromAccent(accent, theme.type)),
    },
  };
};

export const resolveHostTerminalFontFamilyId = (host: Host | null | undefined, defaultFontFamilyId: string): string =>
  hasHostFontFamilyOverride(host) && host?.fontFamily ? host.fontFamily : defaultFontFamilyId;

export const resolveHostTerminalFontSize = (host: Host | null | undefined, defaultFontSize: number): number =>
  hasHostFontSizeOverride(host) && host?.fontSize != null ? host.fontSize : defaultFontSize;

export const hasHostFontWeightOverride = (host?: Pick<Host, 'fontWeightOverride' | 'fontWeight'> | null): boolean =>
  hasEffectiveOverride(host?.fontWeightOverride, hasLegacyNumberValue(host?.fontWeight));

export const clearHostFontWeightOverride = (host: Host): Host => ({
  ...host,
  fontWeight: undefined,
  fontWeightOverride: false,
});

export const resolveHostTerminalFontWeight = (host: Host | null | undefined, defaultFontWeight: number): number =>
  hasHostFontWeightOverride(host) && host?.fontWeight != null ? host.fontWeight : defaultFontWeight;
