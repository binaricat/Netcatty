import bidiFactory from "bidi-js";

/**
 * Display-only right-to-left support for xterm.js (issue #4261).
 *
 * xterm.js draws every cell on its own and in buffer (logical) order, so
 * Arabic, Persian and Hebrew words come out reversed, and Arabic letters are
 * drawn in their isolated forms. xterm.js has no bidi support of its own
 * (xtermjs/xterm.js#701).
 *
 * Both of its renderers (WebGL and DOM) do honour character joiners: a joined
 * range is drawn as one string by the browser's text engine, which reorders
 * the range (UAX #9), shapes Arabic letters into their joined forms and
 * mirrors brackets. The buffer is never changed, so selection, copy, search
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

// Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and the Arabic
// presentation forms, plus the RTL scripts outside the BMP. A cheap check that
// keeps the full algorithm off the hot path for left-to-right lines.
const RTL_CHARACTER = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|[\uD802\uD803\uD83A\uD83B]/;

let bidi: ReturnType<typeof bidiFactory> | null = null;

export function findRightToLeftRuns(text: string): [number, number][] {
  if (!RTL_CHARACTER.test(text)) return [];

  bidi ??= bidiFactory();
  const { levels } = bidi.getEmbeddingLevels(text, "ltr");

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
