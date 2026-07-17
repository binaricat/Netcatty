export type SupportedPlatform = 'darwin' | 'win32' | 'linux' | (string & {});

// True monospace CJK fonts only. Proportional fonts (PingFang SC,
// Microsoft YaHei UI, Hiragino Sans GB) render at non-2x widths in a
// terminal grid — including them here visibly broke alignment for users
// whose primary font lacked CJK glyphs. They are intentionally absent.
const CJK_SYSTEM_FALLBACK_FONTS = [
  '"Sarasa Mono SC"',
  '"Sarasa Mono TC"',
  '"Maple Mono CN"',
  '"LXGW WenKai Mono"',
  '"Noto Sans Mono CJK SC"',
  '"Source Han Mono SC"',
  '"NSimSun"',
  '"SimSun"',
];

export const CJK_SYSTEM_FALLBACK_STACK = CJK_SYSTEM_FALLBACK_FONTS.join(', ');

const NERD_FONT_FALLBACK_FONTS = [
  '"Symbols Nerd Font Mono"',
  '"Symbols Nerd Font"',
];

// Per-OS default CJK font when user hasn't explicitly set fallbackFont
// AND the current Latin font has no recommended pairing.
// All choices are TRUE monospace fonts that keep the terminal grid
// aligned. macOS has no system-installed monospace CJK font, so we
// reference Sarasa Mono SC which netcatty bundles as a webfont.
export function getDefaultCjkFallback(platform: SupportedPlatform): string {
  if (platform === 'win32') return 'SimSun';
  if (platform === 'darwin') return 'Sarasa Mono SC';
  return 'Noto Sans Mono CJK SC';
}

// Every entry must point at a TRUE monospace CJK font. Sarasa Mono SC
// is the safest universal choice because netcatty bundles it via
// @font-face, so it works even on machines without other CJK monospace
// fonts installed.
const PER_FONT_CJK_PAIRING: Record<string, string> = {
  'fira-code':       'Sarasa Mono SC',
  'fira-mono':       'Sarasa Mono SC',
  'jetbrains-mono':  'Sarasa Mono SC',
  'cascadia-code':   'Sarasa Mono SC',
  'cascadia-mono':   'Sarasa Mono SC',
  'source-code-pro': 'Source Han Mono SC',
  'ibm-plex-mono':   'Sarasa Mono SC',
  'iosevka':         'Sarasa Mono SC',
  'ioskeley-mono':   'Sarasa Mono SC',
  'mononoki':        'Sarasa Mono SC',
  'menlo':           'Sarasa Mono SC',
  'monaco':          'Sarasa Mono SC',
  'consolas':        'Sarasa Mono SC',
  'courier-new':     'Sarasa Mono SC',
  'dejavu-sans-mono':'Noto Sans Mono CJK SC',
  'liberation-mono': 'Noto Sans Mono CJK SC',
  'inconsolata':     'Noto Sans Mono CJK SC',
  'victor-mono':     'Sarasa Mono SC',
  'roboto-mono':     'Noto Sans Mono CJK SC',
  'space-mono':      'Sarasa Mono SC',
  'hack':            'Sarasa Mono SC',
  'ubuntu-mono':     'Noto Sans Mono CJK SC',
  'go-mono':         'Sarasa Mono SC',
};

export function getRecommendedCjkFor(
  latinFontId: string,
  platform: SupportedPlatform,
): string | null {
  void platform;
  return PER_FONT_CJK_PAIRING[latinFontId] ?? null;
}

/**
 * Split a CSS font-family list on commas that are OUTSIDE quoted family
 * names. CSS permits commas inside quoted family names (e.g.
 * `"Foo, Inc. Mono"`); a naive `string.split(',')` would tokenize that
 * into broken pieces like `"Foo` and `Inc. Mono"`. Exported so other
 * font-parsing call sites (extractPrimaryFamily, etc.) share the same
 * rules.
 */
export function splitFontFamilyList(css: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < css.length) {
        buf += css[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      buf += c;
      quote = c;
      continue;
    }
    if (c === ',') {
      const trimmed = buf.trim();
      if (trimmed) tokens.push(trimmed);
      buf = '';
      continue;
    }
    buf += c;
  }
  const tail = buf.trim();
  if (tail) tokens.push(tail);
  return tokens;
}

const CSS_GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

function quoteIfNeeded(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return '';
  if (CSS_GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed;
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

interface ComposeArgs {
  primaryFamily: string;
  userFallback: string;
  latinFontId: string;
  platform: SupportedPlatform;
}

export function composeFontFamilyStack(args: ComposeArgs): string {
  const { primaryFamily, userFallback, latinFontId, platform } = args;

  const userFallbackQuoted = userFallback.trim() ? quoteIfNeeded(userFallback) : null;

  const recommended = userFallbackQuoted
    ? null
    : (getRecommendedCjkFor(latinFontId, platform) ?? getDefaultCjkFallback(platform));
  const recommendedQuoted = recommended ? quoteIfNeeded(recommended) : null;

  const seen = new Set<string>();
  const pieces: string[] = [];
  const push = (item: string | null | undefined) => {
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pieces.push(item);
  };

  // Quote-aware split so a family name like `"Foo, Inc. Mono"` keeps
  // its comma intact instead of being shredded into `"Foo` / `Inc. Mono"`.
  for (const p of splitFontFamilyList(primaryFamily)) {
    if (p.toLowerCase() === 'monospace') continue;
    push(p);
  }

  // Latin-only fallback (bundled via @fontsource/jetbrains-mono in
  // index.tsx). Catches Latin glyphs when the primary font isn't
  // installed without intercepting CJK glyphs the way the bare
  // `monospace` generic would on macOS Chrome (where the generic
  // monospace pulls in PingFang via system CJK fallback, masking the
  // user's CJK font choice).
  //
  // Per-glyph CSS fallback then behaves as intended:
  //   - Latin chars: primary (if installed) → JetBrains Mono. Cells
  //     stay aligned because JetBrains Mono is true monospace.
  //   - CJK chars: primary (no) → JetBrains Mono (no CJK glyphs) →
  //     user-chosen CJK font (or per-Latin-font recommendation) →
  //     system CJK stack.
  //   - Nerd PUA: all of the above (none have PUA) → Nerd Font stack.
  push('"JetBrains Mono"');

  push(userFallbackQuoted);
  push(recommendedQuoted);

  for (const sys of CJK_SYSTEM_FALLBACK_FONTS) push(sys);
  for (const nerd of NERD_FONT_FALLBACK_FONTS) push(nerd);

  // Final safety net only — should rarely be reached because JetBrains
  // Mono covers Latin and the CJK stack covers Chinese glyphs. Kept
  // for the edge case where bundled fonts fail to load.
  push('monospace');

  return pieces.join(', ');
}
