/**
 * Terminal Fonts Configuration
 * Includes programming and shell-friendly monospace fonts
 */

export interface TerminalFont {
  id: string;
  name: string;
  family: string;
  description: string;
  category: 'monospace' | 'proportional';
}

// Fonts that hint the browser to pick a CJK-capable fallback when the primary
// monospace font lacks Chinese glyphs. Kept ASCII-only and ordered so that the
// generic monospace fallback remains earlier in the stack (important for cell
// width stability in xterm.js).
const CJK_FALLBACK_FONTS = [
  '"Sarasa Mono SC"',
  '"Noto Sans Mono CJK SC"',
  '"Noto Sans Mono CJK"',
  '"Source Han Mono SC"',
  '"WenQuanYi Zen Hei Mono"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"SimSun"',
];

// Nerd Font symbol-only fallback. Appended after CJK fallbacks so the browser
// can locate Private Use Area glyphs (powerline / devicons / etc.) when the
// primary font does not ship them — without forcing the user to pick a Nerd
// Font variant manually. Mono variants come first to preserve cell width.
const NERD_FONT_FALLBACK_FONTS = [
  '"Symbols Nerd Font Mono"',
  '"Symbols Nerd Font"',
];

const CJK_FALLBACK_STACK = CJK_FALLBACK_FONTS.join(', ');
const NERD_FONT_FALLBACK_STACK = NERD_FONT_FALLBACK_FONTS.join(', ');

export const withCjkFallback = (family: string) => {
  const trimmed = family.trim();
  const segments: string[] = [trimmed];

  if (
    CJK_FALLBACK_STACK &&
    !CJK_FALLBACK_FONTS.some((f) => trimmed.includes(f.replace(/"/g, '')))
  ) {
    segments.push(CJK_FALLBACK_STACK);
  }

  if (
    NERD_FONT_FALLBACK_STACK &&
    !NERD_FONT_FALLBACK_FONTS.some((f) => trimmed.includes(f.replace(/"/g, '')))
  ) {
    segments.push(NERD_FONT_FALLBACK_STACK);
  }

  return segments.join(', ');
};

const BASE_TERMINAL_FONTS: TerminalFont[] = [
  {
    id: 'menlo',
    name: 'Menlo',
    family: 'Menlo, monospace',
    description: 'macOS system font, clean and professional',
    category: 'monospace',
  },
  {
    id: 'monaco',
    name: 'Monaco',
    family: 'Monaco, monospace',
    description: 'Classic monospace, excellent readability',
    category: 'monospace',
  },
  {
    id: 'consolas',
    name: 'Consolas',
    family: 'Consolas, monospace',
    description: 'Windows-style monospace, clear and compact',
    category: 'monospace',
  },
  {
    id: 'courier-new',
    name: 'Courier New',
    family: '"Courier New", monospace',
    description: 'Classic typewriter style, universal support',
    category: 'monospace',
  },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    family: '"Source Code Pro", monospace',
    description: 'Adobe\'s professional programming font',
    category: 'monospace',
  },
  {
    id: 'fira-code',
    name: 'Fira Code',
    family: '"Fira Code", monospace',
    description: 'Monospace font with programming ligatures',
    category: 'monospace',
  },
  {
    id: 'fira-mono',
    name: 'Fira Mono',
    family: '"Fira Mono", monospace',
    description: 'Clean monospace without ligatures',
    category: 'monospace',
  },
  {
    id: 'inconsolata',
    name: 'Inconsolata',
    family: 'Inconsolata, monospace',
    description: 'Elegant and readable monospace font',
    category: 'monospace',
  },
  {
    id: 'dejavu-sans-mono',
    name: 'DejaVu Sans Mono',
    family: '"DejaVu Sans Mono", monospace',
    description: 'Wide character support, very readable',
    category: 'monospace',
  },
  {
    id: 'liberation-mono',
    name: 'Liberation Mono',
    family: '"Liberation Mono", monospace',
    description: 'Open source monospace font, Courier alternative',
    category: 'monospace',
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    family: '"JetBrains Mono", monospace',
    description: 'Professional font designed for IDEs',
    category: 'monospace',
  },
  {
    id: 'victor-mono',
    name: 'Victor Mono',
    family: '"Victor Mono", monospace',
    description: 'Stylish monospace with italic support',
    category: 'monospace',
  },
  {
    id: 'cascadia-code',
    name: 'Cascadia Code',
    family: '"Cascadia Code", monospace',
    description: 'Microsoft\'s modern monospace font',
    category: 'monospace',
  },
  {
    id: 'cascadia-mono',
    name: 'Cascadia Mono',
    family: '"Cascadia Mono", monospace',
    description: 'Cascadia without ligatures',
    category: 'monospace',
  },
  {
    id: 'droid-sans-mono',
    name: 'Droid Sans Mono',
    family: '"Droid Sans Mono", monospace',
    description: 'Google\'s Droid monospace font',
    category: 'monospace',
  },
  {
    id: 'ubuntu-mono',
    name: 'Ubuntu Mono',
    family: '"Ubuntu Mono", monospace',
    description: 'Ubuntu\'s official monospace font',
    category: 'monospace',
  },
  {
    id: 'roboto-mono',
    name: 'Roboto Mono',
    family: '"Roboto Mono", monospace',
    description: 'Google\'s Roboto monospace variant',
    category: 'monospace',
  },
  {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    family: '"IBM Plex Mono", monospace',
    description: 'IBM\'s professional monospace font',
    category: 'monospace',
  },
  {
    id: 'space-mono',
    name: 'Space Mono',
    family: '"Space Mono", monospace',
    description: 'Geometric monospace with strong personality',
    category: 'monospace',
  },
  {
    id: 'input-mono',
    name: 'Input Mono',
    family: '"Input Mono", monospace',
    description: 'Designed specifically for coding',
    category: 'monospace',
  },
  {
    id: 'hack',
    name: 'Hack',
    family: 'Hack, monospace',
    description: 'Designed for source code, excellent in terminals',
    category: 'monospace',
  },
  {
    id: 'anonymous-pro',
    name: 'Anonymous Pro',
    family: '"Anonymous Pro", monospace',
    description: 'Designed for coding and terminal use',
    category: 'monospace',
  },
  {
    id: 'programmer-fonts',
    name: 'Programmer Fonts',
    family: '"Programmer Fonts", monospace',
    description: 'Optimized for programming with clear glyphs',
    category: 'monospace',
  },
  {
    id: 'pt-mono',
    name: 'PT Mono',
    family: '"PT Mono", monospace',
    description: 'ParaType\'s monospace font',
    category: 'monospace',
  },
  {
    id: 'iosevka',
    name: 'Iosevka',
    family: 'Iosevka, monospace',
    description: 'Highly customizable monospace font',
    category: 'monospace',
  },
  {
    id: 'ioskeley-mono',
    name: 'Ioskeley Mono',
    family: '"Ioskeley Mono", monospace',
    description: 'Iosevka variant mimicking Berkeley Mono style',
    category: 'monospace',
  },
  {
    id: 'mononoki',
    name: 'Mononoki',
    family: 'Mononoki, monospace',
    description: 'Crisp and clear monospace with ligatures',
    category: 'monospace',
  },
  {
    id: 'go-mono',
    name: 'Go Mono',
    family: '"Go Mono", monospace',
    description: 'Google Go\'s monospace font',
    category: 'monospace',
  },
  {
    id: 'overpass-mono',
    name: 'Overpass Mono',
    family: '"Overpass Mono", monospace',
    description: 'Open source monospace with good coverage',
    category: 'monospace',
  },
  {
    id: 'comic-sans-ms',
    name: 'Comic Sans MS',
    family: '"Comic Sans MS", monospace',
    description: 'Casual, non-traditional terminal font',
    category: 'monospace',
  },
];

export const TERMINAL_FONTS: TerminalFont[] = BASE_TERMINAL_FONTS.map((font) => ({
  ...font,
  family: withCjkFallback(font.family),
}));

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;
