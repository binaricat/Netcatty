import bidiFactory from "bidi-js";
import rtlCharacterPattern from "../../../lib/terminalRtlCharacter.json";

/**
 * Display-only right-to-left support for xterm.js (issue #4261).
 *
 * xterm.js draws every cell on its own and in buffer (logical) order, so
 * Arabic, Persian and Hebrew words come out reversed, and Arabic letters are
 * drawn in their isolated forms. xterm.js has no bidi support of its own
 * (xtermjs/xterm.js#701).
 *
 * The DOM renderer draws joined ranges as one string, allowing the browser to
 * reorder and shape Arabic letters and mirror brackets. The WebGL addon also
 * supports joiners, but long joined RTL runs can exhaust its glyph texture,
 * so a pane that needs RTL shaping stays on DOM. The buffer is never changed, so selection, copy, search
 * and cursor positions keep working on the logical text. xterm.js also draws
 * a range cell by cell again while the cursor is inside it or a selection
 * only partly covers it, so editing an RTL word shows the logical cells.
 *
 * This joiner returns the parts of a line that the Unicode Bidirectional
 * Algorithm puts at a right-to-left (or number) embedding level when the
 * paragraph direction is left-to-right, which is the default for terminals
 * (https://terminal-wg.pages.freedesktop.org/bidi/). Runs separated by
 * left-to-right text therefore keep their left-to-right order, and lines are
 * not right-aligned.
 */

// RTL scripts and directional controls in the BMP and supplementary planes.
// The Unicode flag makes the supplementary bounds code points, not UTF-16
// lead surrogates (which would also match unrelated non-RTL characters).
const RTL_CHARACTER = new RegExp(rtlCharacterPattern, "u");
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

// bidi-js 1.0.3 looks up string[i] rather than a full code point. Project
// astral characters to BMP characters of the same bidi class for this
// calculation only. Two copies retain the original UTF-16 offsets expected
// by xterm; the actual glyphs (and terminal buffer) are never replaced.
const BIDI_CLASS_PROXY: Readonly<Record<string, string>> = {
  L: "a", R: "א", AL: "ا", EN: "0", AN: "٠", NSM: "\u0301",
  ON: "!", BN: "\u00ad", ET: "$", CS: ",", ES: "+",
};

let bidi: ReturnType<typeof bidiFactory> | null = null;

export function mightContainRightToLeft(text: string): boolean {
  return RTL_CHARACTER.test(text);
}

export function findRightToLeftRuns(text: string): [number, number][] {
  if (!mightContainRightToLeft(text)) return [];

  bidi ??= bidiFactory();
  const classifier = bidi;
  const projected = text.replace(SURROGATE_PAIR, (character) =>
    (BIDI_CLASS_PROXY[classifier.getBidiCharTypeName(character)] ?? "!").repeat(2),
  );
  const { levels } = classifier.getEmbeddingLevels(projected, "ltr");

  const ranges: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const inRun = i < text.length && levels[i] > 0;
    if (inRun && start < 0) {
      start = i;
    } else if (!inRun && start >= 0) {
      // A single cell looks the same joined or not.
      if (i - start > 1) ranges.push([start, i]);
      start = -1;
    }
  }
  return ranges;
}

/** Keep wide RTL glyphs out of the WebGL atlas, without changing other panes. */
export function createPaneBidiJoiner(
  isWebglActive: () => boolean,
  stayOnDom: () => void,
): typeof findRightToLeftRuns {
  let requestedDom = false;
  return (text) => {
    const ranges = findRightToLeftRuns(text);
    if (ranges.length === 0) return ranges;

    if (!requestedDom) {
      requestedDom = true;
      // Do not dispose the current renderer from inside its render callback.
      queueMicrotask(stayOnDom);
    }
    return isWebglActive() ? [] : ranges;
  };
}
