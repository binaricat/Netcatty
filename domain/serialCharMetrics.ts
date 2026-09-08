/**
 * Character display-width, wire-byte-length, and surrogate-pair-safe
 * slicing utilities for serial terminals.
 *
 * Serial devices (MCUs, routers, embedded CLIs) process backspace at the
 * byte level: one 0x7F byte removes one byte from the input buffer.  For a
 * multi-byte CJK character this leaves orphan bytes that render as hidden
 * or garbled characters.  These helpers let the renderer side:
 *
 *  1. calculate how many backspace bytes to send so the device deletes a
 *     whole character, not just the trailing byte;
 *  2. generate a local-echo erase sequence that matches the glyph's cell
 *     width (a CJK ideograph occupies 2 cells, not 1);
 *  3. safely remove the last complete grapheme from a line buffer
 *     (handling UTF-16 surrogate pairs for supplementary characters,
 *     combining marks for decomposed accents, variation selectors, and
 *     ZWJ sequences).
 */

/* ------------------------------------------------------------------ */
/* Display width (East Asian Width)                                    */
/* ------------------------------------------------------------------ */

const unicodeMarkPattern = /\p{Mark}/u;

function isCombiningMark(char: string): boolean {
  const code = char.codePointAt(0);
  return code !== undefined && unicodeMarkPattern.test(String.fromCodePoint(code));
}

/**
 * Terminal cell columns occupied by a single character (1 or 2).
 *
 * Combining marks that follow a base character (e.g. diacritics) occupy 0
 * cells and are ignored here because they never appear as standalone buffer
 * entries — they are always part of the preceding character's grapheme.
 */
export function getCharDisplayWidth(char: string): number {
  if (!char) return 0;
  // Emoji-presentation graphemes (base + VS16 / U+FE0F) always render as
  // 2 cells.  The variation selector forces emoji presentation regardless
  // of the base character's default width — e.g. U+2764 (text heart)
  // becomes a 2-cell emoji, and keycap sequences (digit + VS16 + U+20E3)
  // also render wide.  xterm's 15-graphemes provider handles this via
  // getStringCellWidth; the pure fallback must detect VS16 explicitly.
  if (char.includes("\uFE0F")) return 2;
  // `for...of` handles surrogate pairs; char is a single grapheme.
  let max = 0;
  for (const ch of char) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isCombiningMark(ch)) continue; // wcwidth 0
    const w = codePointCellWidth(cp);
    if (w > max) max = w;
  }
  return max || 1;
}

/** Width of a single Unicode code point (1 or 2 cells). */
function codePointCellWidth(cp: number): number {
  // CJK / Hangul / fullwidth / emoji — all render as 2 terminal cells.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi Radicals, CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Halfwidth/Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)   // CJK Extension B-F, G
  ) {
    return 2;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Wire byte length                                                    */
/* ------------------------------------------------------------------ */

/**
 * Number of bytes a single character occupies on the wire for the given
 * terminal charset.
 *
 * Serial devices implement backspace at the byte level: one 0x7F removes
 * one byte.  Sending the right number of backspaces makes the device delete
 * the whole character instead of just the last byte.
 *
 *  - UTF-8: calculated exactly from the Unicode code point.
 *  - GB18030 / GBK / GB2312 / CP936: 1 byte for ASCII, 2 bytes for BMP
 *    non-ASCII, 4 bytes for supplementary-plane characters (CJK Extension B+).
 *  - Unknown / missing: falls back to UTF-8.
 */
export function getCharByteLength(char: string, charset?: string): number {
  if (!char) return 1;

  const encoding = resolveWireEncoding(charset);

  // UTF-8: exact calculation from code points.
  if (encoding === 'utf-8') {
    let total = 0;
    for (const ch of char) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      total += utf8ByteLength(cp);
    }
    return total || 1;
  }

  // GB18030 / GBK / GB2312 / CP936:
  //  1 byte for ASCII (0x00-0x7F)
  //  2 bytes for BMP non-ASCII (0x80-0xFFFF)
  //  4 bytes for supplementary-plane characters (> 0xFFFF)
  // The 4-byte GB18030 range covers CJK Extension B+ and some emoji,
  // which are representable but rare in serial terminals.
  if (encoding === 'gb18030') {
    for (const ch of char) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (cp >= 0x80) {
        // Supplementary plane → 4-byte GB18030 encoding.
        return cp > 0xffff ? 4 : 2;
      }
    }
    return 1;
  }

  // Unknown encoding — fall back to UTF-8 (most common).
  let total = 0;
  for (const ch of char) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    total += utf8ByteLength(cp);
  }
  return total || 1;
}

/** Map a charset string (e.g. "utf-8", "gb18030", "GBK", "cp936") to a
 *  canonical encoding identifier.  Mirrors `normalizeTerminalEncoding`
 *  in `terminalEncoding.cjs` but lives in the renderer process. */
function resolveWireEncoding(charset?: string): 'utf-8' | 'gb18030' | 'unknown' {
  if (!charset) return 'utf-8';
  const raw = String(charset).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]/g, '');
  if (normalized === 'utf8') return 'utf-8';
  if (['gb18030', 'gbk', 'gb2312', 'cp936', 'ms936'].includes(normalized)) {
    return 'gb18030';
  }
  return 'unknown';
}

/** UTF-8 byte length of a single Unicode code point. */
function utf8ByteLength(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/* ------------------------------------------------------------------ */
/* Grapheme-safe string slicing                                        */
/* ------------------------------------------------------------------ */

/**
 * Shared grapheme segmenter for whole-grapheme slicing.
 *
 * Serial terminal backspace operates on whole rendered characters.  A
 * decomposed `e\u0301` (base + combining acute) is one visible character,
 * so the command buffer must remove it as one unit — not just the combining
 * mark.  `Intl.Segmenter` with grapheme granularity handles surrogate pairs
 * (emoji, CJK Ext B), combining marks, variation selectors, and ZWJ
 * sequences.  Grapheme boundaries are locale-independent.
 */
let graphemeSegmenter: Intl.Segmenter | undefined;

function getGraphemeSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter;
}

/**
 * Returns the last complete grapheme of `str`.
 *
 * Unlike `slice(-1)` — which returns a lone low surrogate for a
 * supplementary-plane character (e.g. emoji, CJK Extension B) or only a
 * combining mark for a decomposed grapheme — this returns the whole
 * rendered character.
 *
 * Returns an empty string for an empty input.
 */
export function getLastChar(str: string): string {
  if (!str) return "";
  const segments = Array.from(getGraphemeSegmenter().segment(str));
  const last = segments[segments.length - 1];
  return last ? last.segment : "";
}

/**
 * Returns `str` with the last complete grapheme removed.
 *
 * Unlike `slice(0, -1)` this correctly removes a full surrogate pair, a
 * combining sequence, or a ZWJ sequence — not just the trailing code unit.
 */
export function removeLastChar(str: string): string {
  if (!str) return "";
  const segments = Array.from(getGraphemeSegmenter().segment(str));
  const last = segments[segments.length - 1];
  return last ? str.slice(0, last.index) : "";
}

/* ------------------------------------------------------------------ */
/* Input classification                                                */
/* ------------------------------------------------------------------ */

/**
 * True when `data` represents a printable character or string that advances
 * the cursor (i.e. the remote line editor's cursor is likely at the end of
 * the typed buffer).
 *
 * False for escape sequences (cursor movements, special keys) and control
 * characters that do not add to the input buffer.  Used to decide whether
 * backspace byte expansion is safe — only expand when the last input was
 * a printable character, not a cursor movement.
 */
export function isPrintableInput(data: string): boolean {
  if (!data) return false;
  // Escape sequences (cursor movements, special keys, etc.)
  if (data.charCodeAt(0) === 0x1b) return false;
  // Control characters below 0x20 and DEL (0x7F)
  const cp = data.charCodeAt(0);
  if (cp < 0x20 || cp === 0x7f) return false;
  // Everything else is printable
  return true;
}
