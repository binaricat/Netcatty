/**
 * UI Fonts Configuration
 * Includes general-purpose fonts suitable for application interface
 */

export interface UIFont {
  id: string;
  name: string;
  family: string;
}

export type UiPlatform = 'darwin' | 'win32' | 'linux';

/**
 * Bundled Noto Color Emoji subset (regional indicators U+1F1E6–1F1FF).
 * Windows system fonts omit flag glyphs and show ISO country codes instead —
 * see #1589, #1604.
 */
export const WINDOWS_FLAG_EMOJI_FONT = '"Noto Color Emoji Flags"';

/**
 * Windows bundles UI fonts via @font-face. Their regional-indicator glyphs
 * render as separate letters instead of composed flag emoji unless a color
 * emoji font is consulted first — see #1589.
 */
export const WINDOWS_UI_EMOJI_FONTS = WINDOWS_FLAG_EMOJI_FONT;

/**
 * Fallback fonts for CJK (Chinese, Japanese, Korean) support
 */
const CJK_FALLBACK_FONTS = [
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  'sans-serif',
];

const CJK_FALLBACK_STACK = CJK_FALLBACK_FONTS.join(', ');

export const withUiCjkFallback = (family: string) => {
  const trimmed = family.trim();
  // Avoid double-appending if a custom stack already includes one of these fonts.
  if (CJK_FALLBACK_FONTS.some((f) => trimmed.includes(f.replace(/"/g, '')))) {
    return trimmed;
  }
  return `${trimmed}, ${CJK_FALLBACK_STACK}`;
};

export function detectUiPlatform(userAgent: string): UiPlatform {
  if (/Win/i.test(userAgent)) return 'win32';
  if (/Mac|iPod|iPhone|iPad/i.test(userAgent)) return 'darwin';
  return 'linux';
}

export function withWindowsEmojiFallback(
  family: string,
  platform: UiPlatform = typeof navigator !== 'undefined'
    ? detectUiPlatform(navigator.userAgent)
    : 'linux',
): string {
  if (platform !== 'win32') return family;
  const trimmed = family.trim();
  if (trimmed.includes('Noto Color Emoji Flags') || trimmed.includes('Segoe UI Emoji')) {
    return trimmed;
  }
  return `${WINDOWS_UI_EMOJI_FONTS}, ${trimmed}, "Segoe UI Emoji", "Segoe UI Symbol"`;
}

const BASE_UI_FONTS: UIFont[] = [
  {
    id: 'mona-sans',
    name: 'Mona Sans',
    family: '"Mona Sans", system-ui',
  },
  {
    id: 'space-grotesk',
    name: 'Space Grotesk',
    family: '"Space Grotesk", system-ui',
  },
  {
    id: 'system-ui',
    name: 'System UI',
    family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial',
  },
  {
    id: 'inter',
    name: 'Inter',
    family: '"Inter", system-ui',
  },
  {
    id: 'roboto',
    name: 'Roboto',
    family: '"Roboto", system-ui',
  },
  {
    id: 'open-sans',
    name: 'Open Sans',
    family: '"Open Sans", system-ui',
  },
  {
    id: 'lato',
    name: 'Lato',
    family: '"Lato", system-ui',
  },
  {
    id: 'nunito',
    name: 'Nunito',
    family: '"Nunito", system-ui',
  },
  {
    id: 'poppins',
    name: 'Poppins',
    family: '"Poppins", system-ui',
  },
  {
    id: 'source-sans-pro',
    name: 'Source Sans Pro',
    family: '"Source Sans Pro", system-ui',
  },
  {
    id: 'ubuntu',
    name: 'Ubuntu',
    family: '"Ubuntu", system-ui',
  },
  {
    id: 'noto-sans',
    name: 'Noto Sans',
    family: '"Noto Sans", system-ui',
  },
  {
    id: 'work-sans',
    name: 'Work Sans',
    family: '"Work Sans", system-ui',
  },
  {
    id: 'dm-sans',
    name: 'DM Sans',
    family: '"DM Sans", system-ui',
  },
  {
    id: 'montserrat',
    name: 'Montserrat',
    family: '"Montserrat", system-ui',
  },
  {
    id: 'raleway',
    name: 'Raleway',
    family: '"Raleway", system-ui',
  },
  {
    id: 'quicksand',
    name: 'Quicksand',
    family: '"Quicksand", system-ui',
  },
  {
    id: 'ibm-plex-sans',
    name: 'IBM Plex Sans',
    family: '"IBM Plex Sans", system-ui',
  },
  {
    id: 'outfit',
    name: 'Outfit',
    family: '"Outfit", system-ui',
  },
  {
    id: 'plus-jakarta-sans',
    name: 'Plus Jakarta Sans',
    family: '"Plus Jakarta Sans", system-ui',
  },
  {
    id: 'segoe-ui',
    name: 'Segoe UI',
    family: '"Segoe UI", system-ui',
  },
  {
    id: 'sf-pro',
    name: 'SF Pro',
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui',
  },
];

export const UI_FONTS: UIFont[] = BASE_UI_FONTS.map((font) => ({
  ...font,
  family: withUiCjkFallback(font.family),
}));

export const DEFAULT_UI_FONT_ID = 'mona-sans';
