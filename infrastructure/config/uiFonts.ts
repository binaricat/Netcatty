/**
 * UI Fonts Configuration
 * Includes general-purpose fonts suitable for application interface
 */

export interface UIFont {
  id: string;
  name: string;
  family: string;
}

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

const BASE_UI_FONTS: UIFont[] = [
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

export const DEFAULT_UI_FONT_ID = 'space-grotesk';
