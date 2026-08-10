/**
 * Terminal cell-column width for autocomplete / ghost positioning.
 *
 * When an xterm instance is available, prefer its active Unicode provider
 * (`15-graphemes` via UnicodeGraphemesAddon) so emoji / VS-16 clusters match
 * the cursor advance. Fall back to a small East-Asian-Width-style classifier
 * for unit fakes that lack `_core.unicodeService`.
 */

import type { Terminal as XTerm } from "@xterm/xterm";

type UnicodeServiceLike = {
  getStringCellWidth?: (s: string) => number;
};

type TermWithUnicodeService = {
  _core?: {
    unicodeService?: UnicodeServiceLike;
  };
};

const unicodeMarkPattern = /\p{Mark}/u;

function codePointCellWidth(cp: number): number {
  // Zero-width joiners / format / variation selectors / marks — xterm
  // folds these into the surrounding grapheme (wcwidth 0 or shouldJoin).
  if (
    cp === 0x00ad ||
    cp === 0x200d ||                       // ZWJ
    (cp >= 0x200b && cp <= 0x200f) ||     // ZWSP..RLM
    (cp >= 0x202a && cp <= 0x202e) ||     // bidi overrides
    (cp >= 0x2060 && cp <= 0x206f) ||     // word joiner, invisible ops
    (cp >= 0xfe00 && cp <= 0xfe0f) ||     // Variation Selectors
    cp === 0xfeff ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||   // Emoji skin-tone modifiers
    (cp >= 0xe0100 && cp <= 0xe01ef) ||   // Variation Selectors Supplement
    unicodeMarkPattern.test(String.fromCodePoint(cp))
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||   // Hiragana, Katakana, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK Extension B-F, G
  ) {
    return 2;
  }
  return 1;
}

function graphemeCellWidth(grapheme: string): number {
  let max = 0;
  for (const ch of grapheme) {
    const w = codePointCellWidth(ch.codePointAt(0) ?? 0);
    if (w > max) max = w;
  }
  return max;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function fallbackStringCellWidth(s: string): number {
  if (graphemeSegmenter) {
    let w = 0;
    for (const { segment } of graphemeSegmenter.segment(s)) {
      w += graphemeCellWidth(segment);
    }
    return w;
  }
  // Fallback without Segmenter: sum code-point widths (ZWJ/marks already 0).
  let w = 0;
  for (const ch of s) {
    w += codePointCellWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/** Terminal cell columns occupied by `s` (wide glyphs / grapheme clusters). */
export function stringCellWidth(
  s: string,
  term?: XTerm | TermWithUnicodeService | null,
): number {
  if (!s) return 0;
  const unicodeService = (term as TermWithUnicodeService | null | undefined)
    ?._core?.unicodeService;
  const getWidth = unicodeService?.getStringCellWidth;
  if (typeof getWidth === "function") {
    return getWidth.call(unicodeService, s);
  }
  return fallbackStringCellWidth(s);
}
