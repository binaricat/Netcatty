// Whole-grapheme slicing for serial input buffers.
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
