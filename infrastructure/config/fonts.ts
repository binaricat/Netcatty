/**
 * Terminal Fonts Configuration
 *
 * `family` is the raw CSS font-family string for the Latin glyphs only.
 * CJK and icon fallbacks are composed at runtime by composeFontFamilyStack()
 * in cjkFonts.ts, which lets users pick the CJK font independently or have
 * one chosen automatically per Latin font.
 */

export interface TerminalFont {
  id: string;
  name: string;
  family: string;
  description: string;
  category: 'monospace' | 'proportional';
}

const BASE_TERMINAL_FONTS: TerminalFont[] = [
  // Existing Latin monospace fonts (ids unchanged for sync compatibility)
  { id: 'menlo',            name: 'Menlo',            family: 'Menlo, monospace',                description: 'macOS system font, clean and professional', category: 'monospace' },
  { id: 'monaco',           name: 'Monaco',           family: 'Monaco, monospace',               description: 'Classic monospace, excellent readability', category: 'monospace' },
  { id: 'consolas',         name: 'Consolas',         family: 'Consolas, monospace',             description: 'Windows-style monospace, clear and compact', category: 'monospace' },
  { id: 'courier-new',      name: 'Courier New',      family: '"Courier New", monospace',        description: 'Classic typewriter style, universal support', category: 'monospace' },
  { id: 'source-code-pro',  name: 'Source Code Pro',  family: '"Source Code Pro", monospace',    description: "Adobe's professional programming font", category: 'monospace' },
  { id: 'fira-code',        name: 'Fira Code',        family: '"Fira Code", monospace',          description: 'Monospace font with programming ligatures', category: 'monospace' },
  { id: 'fira-mono',        name: 'Fira Mono',        family: '"Fira Mono", monospace',          description: 'Clean monospace without ligatures', category: 'monospace' },
  { id: 'inconsolata',      name: 'Inconsolata',      family: 'Inconsolata, monospace',          description: 'Elegant and readable monospace font', category: 'monospace' },
  { id: 'dejavu-sans-mono', name: 'DejaVu Sans Mono', family: '"DejaVu Sans Mono", monospace',   description: 'Wide character support, very readable', category: 'monospace' },
  { id: 'liberation-mono',  name: 'Liberation Mono',  family: '"Liberation Mono", monospace',    description: 'Open source monospace font, Courier alternative', category: 'monospace' },
  { id: 'jetbrains-mono',   name: 'JetBrains Mono',   family: '"JetBrains Mono", monospace',     description: 'Professional font designed for IDEs', category: 'monospace' },
  { id: 'victor-mono',      name: 'Victor Mono',      family: '"Victor Mono", monospace',        description: 'Stylish monospace with italic support', category: 'monospace' },
  { id: 'cascadia-code',    name: 'Cascadia Code',    family: '"Cascadia Code", monospace',      description: "Microsoft's modern monospace font", category: 'monospace' },
  { id: 'cascadia-mono',    name: 'Cascadia Mono',    family: '"Cascadia Mono", monospace',      description: 'Cascadia without ligatures', category: 'monospace' },
  { id: 'droid-sans-mono',  name: 'Droid Sans Mono',  family: '"Droid Sans Mono", monospace',    description: "Google's Droid monospace font", category: 'monospace' },
  { id: 'ubuntu-mono',      name: 'Ubuntu Mono',      family: '"Ubuntu Mono", monospace',        description: "Ubuntu's official monospace font", category: 'monospace' },
  { id: 'roboto-mono',      name: 'Roboto Mono',      family: '"Roboto Mono", monospace',        description: "Google's Roboto monospace variant", category: 'monospace' },
  { id: 'ibm-plex-mono',    name: 'IBM Plex Mono',    family: '"IBM Plex Mono", monospace',      description: "IBM's professional monospace font", category: 'monospace' },
  { id: 'space-mono',       name: 'Space Mono',       family: '"Space Mono", monospace',         description: 'Geometric monospace with strong personality', category: 'monospace' },
  { id: 'input-mono',       name: 'Input Mono',       family: '"Input Mono", monospace',         description: 'Designed specifically for coding', category: 'monospace' },
  { id: 'hack',             name: 'Hack',             family: 'Hack, monospace',                 description: 'Designed for source code, excellent in terminals', category: 'monospace' },
  { id: 'anonymous-pro',    name: 'Anonymous Pro',    family: '"Anonymous Pro", monospace',      description: 'Designed for coding and terminal use', category: 'monospace' },
  { id: 'programmer-fonts', name: 'Programmer Fonts', family: '"Programmer Fonts", monospace',   description: 'Optimized for programming with clear glyphs', category: 'monospace' },
  { id: 'pt-mono',          name: 'PT Mono',          family: '"PT Mono", monospace',            description: "ParaType's monospace font", category: 'monospace' },
  { id: 'iosevka',          name: 'Iosevka',          family: 'Iosevka, monospace',              description: 'Highly customizable monospace font', category: 'monospace' },
  { id: 'ioskeley-mono',    name: 'Ioskeley Mono',    family: '"Ioskeley Mono", monospace',      description: 'Iosevka variant mimicking Berkeley Mono style', category: 'monospace' },
  { id: 'mononoki',         name: 'Mononoki',         family: 'Mononoki, monospace',             description: 'Crisp and clear monospace with ligatures', category: 'monospace' },
  { id: 'go-mono',          name: 'Go Mono',          family: '"Go Mono", monospace',            description: "Google Go's monospace font", category: 'monospace' },
  { id: 'overpass-mono',    name: 'Overpass Mono',    family: '"Overpass Mono", monospace',      description: 'Open source monospace with good coverage', category: 'monospace' },

  // True monospace CJK-coverage fonts only. PingFang SC and Microsoft
  // YaHei UI (the OS system fonts) are deliberately omitted — they are
  // proportional sans-serif designs whose Latin glyphs render with
  // variable widths and whose CJK glyphs don't fit a terminal's 2x cell
  // grid. Picking one as the primary font produced visibly bloated
  // spacing for ASCII characters in #931.
  { id: 'sarasa-mono-sc',   name: 'Sarasa Mono SC',   family: '"Sarasa Mono SC", monospace',   description: 'Iosevka + Source Han Sans (Simplified Chinese), 2:1 monospace', category: 'monospace' },
  { id: 'sarasa-mono-tc',   name: 'Sarasa Mono TC',   family: '"Sarasa Mono TC", monospace',   description: 'Iosevka + Source Han Sans (Traditional Chinese), 2:1 monospace', category: 'monospace' },
  { id: 'maple-mono-cn',    name: 'Maple Mono CN',    family: '"Maple Mono CN", monospace',    description: 'Maple Mono with unified Latin + Simplified Chinese metrics', category: 'monospace' },
  { id: 'lxgw-wenkai-mono', name: 'LXGW WenKai Mono', family: '"LXGW WenKai Mono", monospace', description: 'Monospace Kaishu (regular-script) derived from Fontworks Klee One', category: 'monospace' },
];

export const TERMINAL_FONTS: TerminalFont[] = BASE_TERMINAL_FONTS;

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;

// Font ids that earlier versions of netcatty exposed in the primary font
// dropdown but that are proportional (non-monospace) and produce broken
// cell-grid alignment when used as a terminal font. Reads should migrate
// these to a sane default.
const DEPRECATED_PRIMARY_FONT_IDS = new Set<string>([
  'pingfang-sc',
  'microsoft-yahei',
  'comic-sans-ms',
]);

export function isDeprecatedPrimaryFontId(fontId: string | null | undefined): boolean {
  return !!fontId && DEPRECATED_PRIMARY_FONT_IDS.has(fontId);
}

/**
 * In-place migration for any object carrying `fontFamily` /
 * `fontFamilyOverride` (Host, GroupConfig). When the saved id is one
 * we've since removed from TERMINAL_FONTS, drop the override so the
 * record inherits the global default rather than silently rendering
 * "fallback to fonts[0]" while still claiming an override is active.
 *
 * Returns the (possibly new) value to assign back. Caller decides
 * whether to mutate or copy; both are safe with this shape.
 */
export function migrateDeprecatedFontOverride<
  T extends { fontFamily?: string; fontFamilyOverride?: boolean },
>(record: T): T {
  if (!isDeprecatedPrimaryFontId(record.fontFamily)) return record;
  const next = { ...record };
  delete next.fontFamily;
  if (next.fontFamilyOverride === true) {
    next.fontFamilyOverride = false;
  }
  return next;
}
