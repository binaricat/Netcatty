/**
 * Utility functions for xterm.js cell dimension access.
 * Centralizes access to xterm's internal renderer API to reduce upgrade risk.
 * Falls back to DOM measurement if the internal API is unavailable.
 */

import type { Terminal as XTerm } from "@xterm/xterm";

export interface CellDimensions {
  width: number;
  height: number;
}

// Cache to avoid repeated DOM measurements (invalidated on resize)
let cachedDims: CellDimensions | null = null;
let cachedTermId: number = 0;
let termIdCounter = 0;
const termIdMap = new WeakMap<XTerm, number>();

function getTermId(term: XTerm): number {
  let id = termIdMap.get(term);
  if (id === undefined) {
    id = ++termIdCounter;
    termIdMap.set(term, id);
  }
  return id;
}

/**
 * Get cell dimensions (width/height in CSS pixels) from an xterm instance.
 * Tries the internal renderer API first (fast path), falls back to DOM measurement.
 */
export function getXTermCellDimensions(term: XTerm): CellDimensions {
  // Try xterm core renderer API (fast path)
  const coreAccess = term as XTerm & {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: CellDimensions } } } };
  };
  const coreDims = coreAccess._core?._renderService?.dimensions?.css?.cell;
  if (coreDims && coreDims.width > 0 && coreDims.height > 0) {
    // Update cache while we have a good value
    const id = getTermId(term);
    cachedDims = { width: coreDims.width, height: coreDims.height };
    cachedTermId = id;
    return cachedDims;
  }

  // Check cache (same terminal instance)
  const id = getTermId(term);
  if (cachedDims && cachedTermId === id) {
    return cachedDims;
  }

  // Fallback: measure from DOM (triggers single reflow)
  const dims = measureCellFromDOM(term);
  cachedDims = dims;
  cachedTermId = id;
  return dims;
}

/**
 * Measure cell dimensions by inserting a temporary span into the terminal element.
 * Triggers a single reflow (reading offsetWidth + offsetHeight).
 */
function measureCellFromDOM(term: XTerm): CellDimensions {
  const element = term.element;
  if (!element) return { width: 8, height: 16 };

  const span = document.createElement("span");
  span.textContent = "W";
  Object.assign(span.style, {
    position: "absolute",
    visibility: "hidden",
    fontFamily: term.options.fontFamily || "monospace",
    fontSize: `${term.options.fontSize}px`,
    lineHeight: "normal",
  });
  element.appendChild(span);
  const width = span.offsetWidth || 8;
  const height = span.offsetHeight || 16;
  span.remove();
  return { width, height };
}

/**
 * Invalidate the cached cell dimensions (call on terminal resize).
 */
export function invalidateCellDimensionCache(): void {
  cachedDims = null;
}

/**
 * Minimal East-Asian-Width-style classifier: returns 2 for wide glyphs
 * (CJK ideographs, fullwidth forms, most emoji, hangul syllables), 0 for
 * common combining/format marks, and 1 otherwise. Not full wcwidth — just
 * enough to keep column math from drifting by one cell per CJK char.
 *
 * Prefer {@link stringCellWidth} for user-visible strings: xterm's
 * UnicodeGraphemesAddon measures grapheme clusters, so summing this per
 * code point over-counts emoji modifiers and ZWJ sequences.
 */
export function codePointCellWidth(cp: number): number {
  // Combining marks / zero-width format characters (not full Mn/Me coverage).
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    (cp >= 0x20d0 && cp <= 0x20f0) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // Variation Selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) || // Combining Half Marks
    cp === 0x200b || // Zero Width Space
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B-F, G
  ) {
    return 2;
  }
  return 1;
}

const isRegionalIndicator = (cp: number): boolean =>
  cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** Cell width of one grapheme cluster, matching xterm 15-graphemes join rules. */
function graphemeCellWidth(grapheme: string): number {
  let max = 0;
  let regionalCount = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isRegionalIndicator(cp)) regionalCount += 1;
    const w = codePointCellWidth(cp);
    if (w > max) max = w;
  }
  // xterm forces regional-indicator pairs (flags) to width 2 even though each
  // indicator is typically a narrow code point on its own.
  if (regionalCount >= 2) return 2;
  return max;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;

/**
 * Display-cell width of `s`, grapheme-aware like xterm's UnicodeGraphemesAddon.
 *
 * Emoji modifiers and ZWJ sequences form one wide glyph (2 cells), not a sum
 * of each emoji code point. Falls back to per-code-point widths only when
 * `Intl.Segmenter` is unavailable.
 */
export function stringCellWidth(s: string): number {
  if (!s) return 0;
  if (!graphemeSegmenter) {
    let w = 0;
    for (const ch of s) {
      w += codePointCellWidth(ch.codePointAt(0) ?? 0);
    }
    return w;
  }
  let w = 0;
  for (const { segment } of graphemeSegmenter.segment(s)) {
    w += graphemeCellWidth(segment);
  }
  return w;
}
