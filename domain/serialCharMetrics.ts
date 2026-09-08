/**
 * Character display-width and wire-byte-length utilities for serial terminals.
 *
 * Serial devices (MCUs, routers, embedded CLIs) process backspace at the
 * byte level: one 0x7F byte removes one byte from the input buffer.  For a
 * multi-byte CJK character this leaves orphan bytes that render as hidden
 * or garbled characters.  These helpers let the renderer side:
 *
 *  1. calculate how many backspace bytes to send so the device deletes a
 *     whole character, not just the trailing byte;
 *  2. generate a local-echo erase sequence that matches the glyph's cell
 *     width (a CJK ideograph occupies 2 cells, not 1).
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
 *  - GB18030 / GBK / GB2312 / CP936: 2 bytes for non-ASCII (most CJK is
 *    2 bytes; the 4-byte GB18030 range covers only rare Extension B+ chars
 *    that are essentially never typed in a terminal).
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

  // GB18030 / GBK / GB2312 / CP936: 1 byte for ASCII, 2 for non-ASCII.
  if (encoding === 'gb18030') {
    for (const ch of char) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && cp >= 0x80) return 2;
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
