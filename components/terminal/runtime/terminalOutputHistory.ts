import {
  sliceStringByCellColumns,
  stringCellWidth,
} from "../../terminal/autocomplete/terminalStringCellWidth";
import type { HistoryPreviewRow } from "./terminalHistoryScrollOverride";

const outputGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Plain-text transcript of what a session printed, used as the alternate-screen
 * history preview data source (#2516).
 *
 * Inside screen/vim/codex the app owns the alternate buffer, so xterm's normal
 * buffer has no scrollback and the preview has nothing to show. The output
 * stream is the only usable source, so every display chunk fed to the log
 * capture is reduced to plain lines here: row moves separate printed lines, a bare
 * `\r` overwrites the line it restarts (progress bars/spinners stay one line),
 * printable output wraps at the reported viewport width the way xterm's
 * deferred autowrap does, and the retained tail is bounded.
 *
 * Feed it the chunk *after* the programmatic command rewriter (masked commands
 * never reach the preview) but *before* the replay-safe sanitizer, which drops
 * alternate-screen output on purpose.
 */

const ESC = "\x1b";
const BEL = "\x07";
const C1_CSI = "\x9b";
const C1_ST = "\x9c";

// Cap on a partially received escape sequence, mirroring the replay sanitizer.
const MAX_PENDING_ESCAPE_CHARS = 4096;

export const DEFAULT_OUTPUT_HISTORY_MAX_LINES = 2000;
export const DEFAULT_OUTPUT_HISTORY_MAX_CHARS = 200_000;
/** xterm's default tab stop interval, used when expanding tabs for the preview. */
const TERMINAL_TAB_STOP_COLUMNS = 8;

// Bounded look-ahead windows keep long non-ASCII spans linear. The per-row
// piece and the deferred-wrap grapheme probe below otherwise slice/measure
// the whole unconsumed suffix once per viewport row they fill, making capture
// quadratic (and synchronously blocking the renderer) for large CJK chunks.
// The slack absorbs zero-width grapheme runs a row can also absorb; a
// grapheme longer than a window just costs one bounded fallback.
const WRAP_PROBE_UTF16_UNITS = 64;

// 8-bit (C1) control string introducers: DCS, SOS, OSC, PM, APC. Their
// payloads must be consumed with them, not left as transcript text.
const isC1ControlStringIntroducer = (ch: string): boolean =>
  ch === "\x90" || ch === "\x98" || ch === "\x9d" || ch === "\x9e" || ch === "\x9f";

const isEscapeIntroducer = (ch: string): boolean =>
  ch === ESC || ch === C1_CSI || isC1ControlStringIntroducer(ch);

const findEscapeIntroducer = (input: string, from: number): number => {
  for (let i = from; i < input.length; i += 1) {
    if (isEscapeIntroducer(input[i])) return i;
  }
  return -1;
};

const consumeCsiBody = (input: string, from: number): number | null => {
  for (let i = from; i < input.length; i += 1) {
    // Parameter/intermediate bytes are 0x20-0x3f; the final byte is 0x40-0x7e.
    if (input[i] >= "@" && input[i] <= "~") return i + 1;
  }
  return null;
};

const consumeControlString = (input: string, from: number): number | null => {
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === BEL) return i + 1;
    if (ch === ESC && input[i + 1] === "\\") return i + 2;
    if (ch === C1_ST) return i + 1;
  }
  return null;
};

const isControlStringIntroducer = (ch: string): boolean =>
  ch === "]" || ch === "P" || ch === "^" || ch === "_" || ch === "X";

/** Length of the introducer bytes of the escape sequence starting at `start`. */
const escapeIntroducerLength = (input: string, start: number): number => {
  if (input[start] !== ESC) return 1;
  const second = input[start + 1];
  return second === "[" || isControlStringIntroducer(second) ? 2 : 1;
};

/** Marks an erase-in-line the transcript must apply (kept in stripper output). */
const ERASE_TO_END_OF_LINE = "\x1f";
/** Marks `CSI 1 K` (erase from the line start through the cursor, inclusive). */
const ERASE_START_TO_CURSOR = "\x1e";
/** Marks `CSI 2 K` (erase the whole line). */
const ERASE_WHOLE_LINE = "\x1d";

/**
 * Marks a control sequence the stripper removed. xterm's grapheme provider
 * resets its preceding-join state at every control it parses, so a cluster's
 * base and continuation separated by one (an SGR between display chunks, say)
 * stay separate graphemes; the writer must not rejoin them across the gap.
 * A C0 byte the transcript filters (`keepTranscriptChars` drops \x06), so only
 * this marker can produce it in stripper output.
 */
const CONTROL_BOUNDARY = "\x06";

/**
 * The erase-in-line sequences progress lines use (`\r` + text + `\x1b[K`) must
 * be applied to the transcript, or the stale suffix of a shorter redraw shows
 * up as text. Returns the marker for the erase mode: every variant (default/0,
 * 1, 2) has a transcript equivalent, applied by the writer against its tracked
 * cursor.
 */
const eraseInLineMarkerFor = (input: string, start: number, end: number): string | null => {
  if (input[end - 1] !== "K") return null;
  const introducerLength = escapeIntroducerLength(input, start);
  const mode = input.slice(start + introducerLength, end - 1).split(";")[0];
  if (mode === "1") return ERASE_START_TO_CURSOR;
  if (mode === "2") return ERASE_WHOLE_LINE;
  return ERASE_TO_END_OF_LINE;
};

// ECMA-48 nF sequences: zero or more intermediates (0x20-0x2f) then one final
// byte (0x30-0x7e), e.g. `ESC ( B` (charset) or `ESC # 8` (DECALN).
const isEscapeIntermediateByte = (ch: string): boolean => ch >= " " && ch <= "/";
const isEscapeFinalByte = (ch: string): boolean => ch >= "0" && ch <= "~";

/** Index past the escape sequence at `start`, or null while it is incomplete. */
const consumeEscapeSequence = (input: string, start: number): number | null => {
  const introducer = input[start];
  if (introducer === C1_CSI) return consumeCsiBody(input, start + 1);
  if (isC1ControlStringIntroducer(introducer)) return consumeControlString(input, start + 1);
  const second = input[start + 1];
  if (second === undefined) return null;
  if (second === "[") return consumeCsiBody(input, start + 2);
  if (isControlStringIntroducer(second)) return consumeControlString(input, start + 2);
  let end = start + 1;
  while (end < input.length && isEscapeIntermediateByte(input[end])) end += 1;
  if (end >= input.length) return null;
  // No final byte: leave the trailing byte to the transcript filters, which
  // drop control characters, instead of eating a meaningful one.
  if (!isEscapeFinalByte(input[end])) return end;
  return end + 1;
};

/**
 * Keep the line-editing controls the transcript needs and printable text; drop
 * every other control character (BEL, SO/SI, NUL, stray C1 bytes, ...).
 */
const keepTranscriptChars = (span: string): string => {
  // Fast path: most spans are plain text with nothing to filter.
  let needsFiltering = false;
  for (let i = 0; i < span.length; i += 1) {
    const code = span.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      needsFiltering = true;
      break;
    }
  }
  if (!needsFiltering) return span;

  let kept = "";
  for (let i = 0; i < span.length; i += 1) {
    const code = span.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)) {
      kept += span[i];
    } else if (code === 8 || code === 9 || code === 10 || code === 13 || code === 31) {
      kept += span[i];
    }
  }
  return kept;
};

/**
 * A private-mode sequence is preserved when it carries a tracked mode (DECOM 6
 * or DECAWM 7), even alongside unrelated modes like `CSI ?6;25h`: xterm applies
 * every parameter and drops only the untracked ones during interpretation.
 */
const isTrackedDecPrivateModeSequence = (sequence: string): boolean => {
  const match = /^\?([0-9;]+)([hl])$/.exec(sequence);
  if (!match) return false;
  return match[1].split(";").some((p) => p === "6" || p === "7");
};

/**
 * Reduce a display chunk to plain text: escape sequences are removed while
 * `\n` / `\r` / `\b` / `\t` and the erase-in-line marker survive so the history
 * can track line edits.
 */
export const stripTerminalDisplayToPlainText = (
  chunk: string,
  pending: string = "",
  preserveRowControls = false,
): { text: string; pending: string } => {
  const input = pending + chunk;
  let output = "";
  let i = 0;
  while (i < input.length) {
    if (isEscapeIntroducer(input[i])) {
      const end = consumeEscapeSequence(input, i);
      if (end === null) {
        const rest = input.slice(i);
        if (rest.length <= MAX_PENDING_ESCAPE_CHARS) {
          return { text: output, pending: rest };
        }
        // Cap the retained tail but keep its introducer: without it the payload
        // of an oversized control string would be re-parsed as transcript text
        // on the next chunk.
        const introducerLength = escapeIntroducerLength(input, i);
        return {
          text: output,
          pending: rest.slice(0, introducerLength)
            + rest.slice(rest.length - (MAX_PENDING_ESCAPE_CHARS - introducerLength)),
        };
      }
      const sequence = input.slice(i + escapeIntroducerLength(input, i), end);
      // Only the history writer consumes cursor-row/column controls.
      // Standalone plain text stripping keeps its original contract. DEC
      // origin/autowrap mode changes, cursor save/restore, and RIS ride along
      // so rows resolve the way the terminal resolves them.
      const isCsi = input[i] === C1_CSI || input[i + 1] === "[";
      const passesRowControl = isCsi
        && (/^[0-9;]*[HfABCDEFdDrG]$/.test(sequence)
          || isTrackedDecPrivateModeSequence(sequence)
          || /^[su]$/.test(sequence));
      const isBareEscFinal = !isCsi
        && escapeIntroducerLength(input, i) === 1
        && /^[78cDEM]$/.test(sequence);
      const passes = preserveRowControls && (passesRowControl || isBareEscFinal);
      if (passes) output += input.slice(i, end);
      const eraseInLine = eraseInLineMarkerFor(input, i, end);
      if (eraseInLine) output += eraseInLine;
      else if (preserveRowControls && !passes) output += CONTROL_BOUNDARY;
      i = end;
      continue;
    }
    const next = findEscapeIntroducer(input, i + 1);
    const end = next === -1 ? input.length : next;
    const kept = keepTranscriptChars(input.slice(i, end));
    if (kept) output += kept;
    i = end;
  }
  return { text: output, pending: "" };
};

/**
 * The live xterm instance whose Unicode provider measures cell widths. The
 * configured `15-graphemes` runtime intentionally disagrees with the local
 * fallback for some graphemes (e.g. `terminalStringCellWidth.test.ts` records
 * `🖥` as one xterm cell while the fallback counts two), so every wrap /
 * overwrite decision here must measure the way the terminal measures.
 */
type WidthTerm = NonNullable<Parameters<typeof stringCellWidth>[1]>;

const isAsciiOnly = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
};

/** Cell columns a transcript span occupies (wide glyphs count twice). */
const pieceCellWidth = (text: string, term?: WidthTerm | null): number =>
  isAsciiOnly(text) ? text.length : stringCellWidth(text, term);

/** UTF-16 units of the first grapheme of `text` ("" when empty). */
const firstGraphemeUnits = (text: string): string =>
  outputGraphemeSegmenter.segment(text)[Symbol.iterator]().next().value?.segment ?? "";

/** UTF-16 units of the last grapheme of `text` ("" when empty). */
const lastGraphemeUnits = (text: string): string => {
  let last = "";
  for (const { segment } of outputGraphemeSegmenter.segment(text)) last = segment;
  return last;
};

/**
 * Start cell of the first grapheme that begins at or after `cell`. A wide
 * grapheme straddling `cell` is skipped, so a cell boundary that cuts into it
 * extends to the grapheme's end (xterm erases whole intersected cells).
 */
const firstGraphemeStartCellAtOrAfter = (
  text: string,
  cell: number,
  term?: WidthTerm | null,
): number => {
  if (isAsciiOnly(text)) return Math.min(cell, text.length);
  let startCell = 0;
  for (const { segment } of outputGraphemeSegmenter.segment(text)) {
    if (startCell >= cell) return startCell;
    startCell += pieceCellWidth(segment, term);
  }
  return startCell;
};

/**
 * Wrap one transcript line into viewport-sized rows. Continuation rows carry
 * the same `isWrapped` flag xterm uses so soft-wrapped selection joins keep
 * working (see joinHistoryPreviewSelectionText).
 */
export const wrapOutputHistoryLineToRows = (
  text: string,
  cols: number,
  term?: WidthTerm | null,
): string[] => {
  if (cols < 1) return [text];
  const ascii = isAsciiOnly(text);
  const width = ascii ? text.length : stringCellWidth(text, term);
  if (width <= cols) return [text];

  const rows: string[] = [];
  let startCell = 0;
  while (startCell < width) {
    // ASCII lines skip the grapheme segmenter; a transcript can hold long lines.
    const row = ascii
      ? text.slice(startCell, startCell + cols)
      : sliceStringByCellColumns(text, startCell, startCell + cols, term);
    if (!row) break;
    rows.push(row);
    startCell += ascii ? row.length : stringCellWidth(row, term);
  }
  return rows.length > 0 ? rows : [text];
};

const buildPreviewRows = (
  lines: readonly string[],
  lineStartsWrapped: readonly boolean[],
  cols: number,
  term?: WidthTerm | null,
): HistoryPreviewRow[] => {
  const rows: HistoryPreviewRow[] = [];
  // A line committed by an automatic wrap is itself the continuation row of
  // the previous one, so rejoin each soft-wrapped run before re-wrapping:
  // reflowing the segments independently would keep them on separate rows at
  // a widened preview, unlike xterm's single row after its resize reflow.
  let pending = "";
  let pendingStartsWrapped = false;
  let hasPending = false;
  const flush = () => {
    const wrapped = wrapOutputHistoryLineToRows(pending, cols, term);
    for (let row = 0; row < wrapped.length; row += 1) {
      // The run's first row keeps the join to the (possibly trimmed)
      // predecessor; the re-wrapped rows continue it.
      rows.push({
        isWrapped: row > 0 || (row === 0 && pendingStartsWrapped),
        text: wrapped[row],
      });
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const startsWrapped = lineStartsWrapped[index] ?? false;
    // An empty pending is a predecessor xterm erased to blank but still shows
    // as an occupied row (e.g. five columns, `abcde\x1b[2KX`): joining its
    // continuation here would drop that row and shift every later preview
    // row, so flush it as its own row before the run continues.
    if (startsWrapped && hasPending && pending !== "") {
      pending += lines[index];
    } else {
      if (hasPending) flush();
      hasPending = true;
      pending = lines[index];
      pendingStartsWrapped = startsWrapped;
    }
  }
  if (hasPending) flush();
  return rows;
};

export const clampOutputHistoryPreviewTop = (
  top: number,
  totalRows: number,
  rows: number,
): number => {
  const maxTop = Math.max(0, totalRows - Math.max(1, rows));
  return Math.max(0, Math.min(maxTop, top));
};

export const nextOutputHistoryPreviewTop = ({
  currentTop,
  lines,
  rows,
  totalRows,
}: {
  currentTop: number | null;
  lines: number;
  rows: number;
  totalRows: number;
}): number => clampOutputHistoryPreviewTop(
  clampOutputHistoryPreviewTop(
    currentTop ?? Math.max(0, totalRows - Math.max(1, rows)),
    totalRows,
    rows,
  ) + lines,
  totalRows,
  rows,
);

export interface OutputHistoryPreviewWindow {
  rows: HistoryPreviewRow[];
  totalRows: number;
}

export interface TerminalOutputHistoryPreview {
  append(chunk: string): void;
  clear(): void;
  /** Transcript lines, oldest first (the open last line included). */
  getLines(): readonly string[];
  /** Viewport rows the retained transcript wraps to at `cols` columns. */
  getPreviewRowCount(cols: number): number;
  getPreviewRows(params: { cols: number; rows: number; top: number }): OutputHistoryPreviewWindow;
  /**
   * Report the live terminal's viewport row count so cursor-row moves are
   * clamped the way the terminal clamps them: `CSI n B`/`E` and absolute
   * positions past the bottom row stay on it instead of registering as
   * historical row transitions. Unset (0) keeps the unclamped behavior.
   */
  setViewportRows(rows: number): void;
  /**
   * Report the live terminal's viewport column count so absolute cursor
   * columns past the last one clamp to it, exactly like xterm does. Unset
   * (0) keeps the unclamped behavior.
   */
  setViewportCols(cols: number): void;
  /** Synchronize an actual xterm resize, including its zero-based cursor after reflow. */
  syncViewportAfterResize(size: {
    cols: number; rows: number; cursorX: number; cursorY: number;
    cursorLine: string; isWrapped: boolean;
  }): void;
  /**
   * Report the live terminal so wrap decisions use its Unicode width provider
   * (the configured `15-graphemes` runtime) instead of the local fallback,
   * which disagrees with xterm for some graphemes. Unset keeps the fallback.
   */
  setWidthTerminal(term: WidthTerm | null): void;
}

export const createTerminalOutputHistoryPreview = (options?: {
  maxLines?: number;
  maxChars?: number;
}): TerminalOutputHistoryPreview => {
  const maxLines = Math.max(1, options?.maxLines ?? DEFAULT_OUTPUT_HISTORY_MAX_LINES);
  const maxChars = Math.max(1, options?.maxChars ?? DEFAULT_OUTPUT_HISTORY_MAX_CHARS);
  let lines: string[] = [];
  // lines[i] began as an automatic-wrap continuation (see wrapCursor), so the
  // preview's first row for it must carry xterm's isWrapped flag and join the
  // previous line's last row during selection.
  let lineWrapFlags: boolean[] = [];
  let currentStartsWrapped = false;
  let current = "";
  let cursor = 0;
  let cursorCell = 0;
  let screenRow = 1;
  let currentCellWidth = 0;
  let totalChars = 0;
  let pendingEscape = "";
  let viewportRows = 0;
  let viewportCols = 0;
  // The live xterm instance backing this transcript; its Unicode provider
  // measures the cell widths every wrap decision below commits to.
  let widthTerm: WidthTerm | null = null;
  // Active DECSTBM scroll margins (1-based rows); Infinity means "viewport bottom".
  let scrollTopMargin = 1;
  let scrollBottomMargin = Infinity;
  // DEC origin mode (DECOM): absolute rows become relative to the top margin
  // and clamp within the region.
  let originMode = false;
  // DECAWM: while off, printable characters never wrap to the next row; they
  // overwrite the last column instead.
  let autowrap = true;
  // Cursor saved by SC/DECSC (CSI s / ESC 7) for CSI u / ESC 8 to restore.
  let savedCursor: { row: number; cell: number; originMode: boolean; autowrap: boolean } | null = null;
  // UTF-16 units of the grapheme the last appending write left open at the
  // line tail, plus the cursor cell just past it. The backend can split a
  // grapheme across display chunks (base in one chunk, its ZWJ / combining
  // mark / trailing surrogate in the next) while xterm's grapheme provider
  // joins them across writes, so the next span must be able to rejoin it.
  let openGrapheme: string | null = null;
  let openGraphemeCell = 0;
  let cacheDirty = true;
  let cacheCols = -1;
  let cacheRows: HistoryPreviewRow[] = [];

  const commitCurrentLine = () => {
    lines.push(current);
    lineWrapFlags.push(currentStartsWrapped);
    totalChars += current.length;
    current = "";
    openGrapheme = null;
    currentCellWidth = 0;
    cursor = 0;
    cursorCell = 0;
    currentStartsWrapped = false;
    // Never trim away the last retained line.
    while (lines.length > maxLines || (totalChars > maxChars && lines.length > 1)) {
      const dropped = lines.shift();
      if (dropped === undefined) break;
      lineWrapFlags.shift();
      totalChars -= dropped.length;
    }
  };

  /**
   * Move the tracked cursor to the start of the next screen row the way xterm
   * does when printable output crosses the last column: the open line is
   * committed at the wrap column so a later cursor-addressed redraw targets
   * the row the terminal actually wrapped to.
   */
  const wrapCursor = () => {
    const screenBottom = viewportRows > 0 ? viewportRows : 1_000_000;
    const bottomLimit = screenRow <= scrollBottomMargin
      ? Math.min(scrollBottomMargin, screenBottom)
      : screenBottom;
    commitCurrentLine();
    // The continuation row xterm moved to is a soft wrap: mark the next
    // committed line so the preview keeps the wrapped-row join.
    currentStartsWrapped = true;
    screenRow = Math.min(bottomLimit, screenRow + 1);
    cursor = 0;
    cursorCell = 0;
    currentCellWidth = 0;
  };

  /**
   * Write one span at the open line's cursor. A cursor-addressed redraw
   * (cursor-home CSI stripped, no LF) would keep appending frames to the open
   * line forever, so the budget is enforced here: spans are written in bounded
   * pieces, committing a full line at the cap, so nothing is dropped and the
   * copy every write makes stays bounded. With a known viewport width, spans
   * are additionally capped at the remaining columns so xterm's deferred
   * autowrap splits the line where the terminal wraps it.
   */
  const writeSpan = (span: string) => {
    let offset = 0;
    let protectedFinalWideCell = false;
    // ASCII-ness is monotone under slicing; decide once so the per-row cap
    // below stays linear for long spans.
    let spanIsAscii = isAsciiOnly(span);
    // The previous chunk may have ended mid-grapheme (its base was written
    // while this span begins with the continuation: a ZWJ sequence, a
    // combining mark, or the trailing surrogate of a pair). xterm's grapheme
    // provider joins the cluster across writes, but segmenting this span
    // alone treats the continuation as a standalone grapheme: a leading ZWJ
    // sequence measures wrong and a trailing low surrogate slices a cell
    // mid-surrogate-pair. Rejoin instead: drop the provisional open grapheme
    // from the line tail and let the joined cluster be written in its place,
    // so the width and wrap decisions below match the terminal's.
    if (
      openGrapheme !== null
      && !spanIsAscii
      && current
      && cursor === current.length
      && cursorCell === openGraphemeCell
    ) {
      const probeEnd = Math.min(span.length, WRAP_PROBE_UTF16_UNITS);
      const head = openGrapheme + span.slice(0, probeEnd);
      let first = firstGraphemeUnits(head);
      if (
        first.length === head.length
        && probeEnd === WRAP_PROBE_UTF16_UNITS
        && span.length > probeEnd
      ) {
        // The probe filled its window and may continue past it; only then
        // pay for re-segmenting the full remaining span.
        first = firstGraphemeUnits(openGrapheme + span);
      }
      if (first.length > openGrapheme.length) {
        // The joined cluster replaces the open grapheme: subtract its width
        // so the joined grapheme below lands on exactly the same cells.
        const openWidth = pieceCellWidth(openGrapheme, widthTerm);
        current = current.slice(0, current.length - openGrapheme.length);
        cursor = current.length;
        cursorCell = Math.max(0, cursorCell - openWidth);
        currentCellWidth = Math.max(0, currentCellWidth - openWidth);
        span = first + span.slice(first.length - openGrapheme.length);
        spanIsAscii = false;
      }
    }
    // Cap each piece at about one row of cells (plus probe slack): the width
    // measurement and column slicing below cost O(piece), so an uncapped
    // piece would rescan the entire remaining span once per row it filled.
    // Iterating over more, smaller pieces appends the same characters in the
    // same order, so the transcript is unchanged. Without a viewport width
    // the whole span is consumed in a single pass, so no cap is needed.
    const pieceCap = viewportCols > 0
      ? viewportCols * 2 + WRAP_PROBE_UTF16_UNITS
      : Number.POSITIVE_INFINITY;
    while (offset < span.length) {
      if (!autowrap && viewportCols > 0) {
        // Xterm leaves the wide leading cell intact when overflow writes land
        // on its final continuation cell. A later print span starting on that
        // continuation cell can erase it, so keep this protection span-local.
        if (!protectedFinalWideCell && cursorCell >= viewportCols
          && currentCellWidth === viewportCols && !isAsciiOnly(current)) {
          const prefix = sliceStringByCellColumns(current, 0, viewportCols - 1, widthTerm);
          protectedFinalWideCell = pieceCellWidth(prefix, widthTerm) < viewportCols - 1;
        }
        if (protectedFinalWideCell) {
          const first = spanIsAscii ? span[offset] : firstGraphemeUnits(span.slice(offset));
          const width = spanIsAscii ? 1 : pieceCellWidth(first, widthTerm);
          cursorCell = width === 2 ? viewportCols - 1 : viewportCols;
          cursor = width === 2
            ? sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length
            : current.length;
          offset += first.length;
          continue;
        }
      }
      // xterm defers the wrap until the next printable character arrives; a
      // cursor move or carriage return in between cancels it instead.
      if (viewportCols > 0 && cursorCell >= viewportCols) {
        if (autowrap) {
          // A zero-width grapheme (a combining mark that arrived in a later
          // display chunk) joins the final cell of the current row instead of
          // starting the next one; the wrap stays deferred behind it. That
          // only holds while a valid preceding grapheme ends the row
          // (`openGrapheme` still set): a control xterm parsed reset its
          // preceding-join state, so a standalone mark must not attach to the
          // prior row's cell — xterm wraps and the mark begins the next row.
          const rest = spanIsAscii
            ? ""
            : span.slice(offset, offset + WRAP_PROBE_UTF16_UNITS);
          let first = rest
            ? outputGraphemeSegmenter.segment(rest)[Symbol.iterator]().next().value?.segment
            : undefined;
          if (
            first !== undefined
            && rest.length === WRAP_PROBE_UTF16_UNITS
            && first.length === rest.length
          ) {
            // The first grapheme fills the probe window and may continue past
            // it; only then pay for slicing the full remaining suffix.
            first = outputGraphemeSegmenter
              .segment(span.slice(offset))[Symbol.iterator]().next().value?.segment;
          }
          if (
            openGrapheme !== null
            && first !== undefined
            && stringCellWidth(first, widthTerm) === 0
            && cursor >= current.length
            && current.length < maxChars
          ) {
            current += first;
            cursor = current.length;
            // The tracked open grapheme no longer describes the tail (the
            // zero-width piece extends it in place); stop offering a join.
            openGrapheme = null;
            offset += first.length;
            continue;
          }
          wrapCursor();
        } else {
          // DECAWM disabled: keep writing on the current row, overwriting the
          // last column the way xterm does.
          cursorCell = viewportCols - 1;
          cursor = cursorCell === 0 ? 0
            : isAsciiOnly(current) ? cursorCell
              : sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length;
        }
      }
      if (current.length >= maxChars) commitCurrentLine();
      const width = currentCellWidth;
      if (cursorCell > width) {
        current += " ".repeat(cursorCell - width);
        cursor = current.length;
        // Track the materialized padding so a discarded glyph (a wide one that
        // cannot fit with DECAWM off) does not make the next character pad the
        // same gap a second time.
        currentCellWidth = Math.max(width, cursorCell);
      }
      // A span may open with a zero-width grapheme (a combining mark, or a ZWJ
      // whose base ended an earlier chunk after a control reset the
      // preceding-join state). Append it onto the open line directly, the way
      // the deferred-wrap path above does: column slicing drops a leading
      // zero-width cluster from a cut piece, which would desynchronize the
      // span offset and re-write the grapheme that follows it.
      if (!spanIsAscii && cursor >= current.length) {
        const rest = span.slice(offset, offset + WRAP_PROBE_UTF16_UNITS);
        let first = rest
          ? outputGraphemeSegmenter.segment(rest)[Symbol.iterator]().next().value?.segment
          : undefined;
        if (
          first !== undefined
          && rest.length === WRAP_PROBE_UTF16_UNITS
          && first.length === rest.length
        ) {
          // The probe filled its window and may continue past it; only then
          // pay for slicing the full remaining suffix.
          first = outputGraphemeSegmenter
            .segment(span.slice(offset))[Symbol.iterator]().next().value?.segment;
        }
        if (first !== undefined && stringCellWidth(first, widthTerm) === 0) {
          current += first;
          cursor = current.length;
          // The zero-width piece extends the tail in place; stop offering a join.
          openGrapheme = null;
          offset += first.length;
          continue;
        }
      }
      // The maxChars budget still wins when it is smaller (that slice keeps
      // the established behavior). Otherwise cut the piece at a grapheme
      // boundary: slicing mid-grapheme would regroup combining marks / ZWJ
      // clusters and corrupt the transcript, while a boundary-aligned cut
      // keeps every piece's segmentation identical to the span's.
      let pieceEnd = offset + (maxChars - current.length);
      if (pieceEnd - offset > pieceCap) {
        const window = span.slice(offset, offset + pieceCap + WRAP_PROBE_UTF16_UNITS);
        let cutLength = 0;
        let end = window.length;
        for (const { segment } of outputGraphemeSegmenter.segment(window)) {
          if (cutLength + segment.length > pieceCap) {
            // A single grapheme wider than the cap (a base character trailed
            // by many combining marks) cannot be split at a boundary; take the
            // whole first grapheme rather than an empty piece, which would
            // drop this grapheme and everything after it.
            end = cutLength > 0 ? cutLength : Math.min(segment.length, window.length);
            break;
          }
          cutLength += segment.length;
        }
        pieceEnd = offset + end;
      }
      const piece = span.slice(offset, pieceEnd);
      if (!piece) return;
      let fitting = piece;
      let fittingWidth: number | undefined;
      if (viewportCols > 0) {
        const room = viewportCols - cursorCell;
        if (spanIsAscii) {
          fitting = piece.slice(0, room);
        } else {
          const fullWidth = stringCellWidth(piece, widthTerm);
          if (fullWidth <= room) {
            fittingWidth = fullWidth;
          } else {
            fitting = sliceStringByCellColumns(piece, 0, room, widthTerm);
          }
        }
        if (!fitting) {
          if (cursorCell > 0) {
            if (autowrap) {
              // The next glyph is wider than the remaining columns; xterm wraps
              // and places it on the following row.
              wrapCursor();
            } else {
              // Match xterm: a wide glyph that cannot fit with DECAWM off is
              // discarded. Consume the entire grapheme so this loop advances
              // and later narrow characters can still overwrite the last cell.
              const first = outputGraphemeSegmenter.segment(piece)[Symbol.iterator]().next().value;
              offset += first?.segment.length ?? piece.length;
            }
            continue;
          }
          // Wider than the whole viewport: write only the first grapheme so
          // the loop wraps the rest the way xterm wraps after an oversized
          // glyph, instead of pinning later characters to this row.
          fitting = firstGraphemeUnits(piece);
        }
      }
      const pieceAscii = isAsciiOnly(fitting);
      const pieceWidth = fittingWidth
        ?? (pieceAscii ? fitting.length : stringCellWidth(fitting, widthTerm));
      const appending = cursor >= current.length;
      if (appending) {
        current += fitting;
      } else {
        // The tail is overwritten, so the tracked open grapheme (if any) no
        // longer ends the line.
        openGrapheme = null;
        if (pieceAscii && isAsciiOnly(current)) {
          current = current.slice(0, cursor) + fitting + current.slice(cursor + fitting.length);
        } else {
          // Cursor coordinates count cells, while strings count UTF-16 units.
          // Replace entire intersected graphemes and blank any remaining half
          // of a wide glyph, retaining the columns of the untouched suffix.
          const prefix = sliceStringByCellColumns(current, 0, cursorCell, widthTerm);
          const endCell = cursorCell + pieceWidth;
          const endPrefix = sliceStringByCellColumns(current, 0, endCell, widthTerm);
          const overlapsWideEnd = pieceCellWidth(endPrefix, widthTerm) < Math.min(endCell, width);
          const suffix = sliceStringByCellColumns(
            current,
            endCell + (overlapsWideEnd ? 1 : 0),
            undefined,
            widthTerm,
          );
          current = prefix + " ".repeat(cursorCell - pieceCellWidth(prefix, widthTerm))
            + fitting + (overlapsWideEnd ? " " : "") + suffix;
        }
      }
      cursorCell += pieceWidth;
      currentCellWidth = Math.max(width, cursorCell);
      if (appending) {
        // Remember the grapheme this append left at the tail so a later chunk
        // continuing it (a split cluster) can be rejoined (see writeSpan).
        // An empty open grapheme would corrupt the join, so track null then.
        openGrapheme = !fitting ? null
          : isAsciiOnly(fitting) ? fitting.slice(-1) : lastGraphemeUnits(fitting);
        openGraphemeCell = cursorCell;
      }
      cursor = appending ? current.length
        : isAsciiOnly(current) ? cursorCell
          : sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length;
      offset += fitting.length;
    }
  };

  const saveTrackedCursor = () => {
    savedCursor = { row: screenRow, cell: cursorCell, originMode, autowrap };
  };

  /**
   * RIS (`ESC c`): xterm resets DECAWM/DECOM and the scroll margins, discards
   * the saved cursor, and homes it, so later output after a mode change
   * resolves the way the terminal resolves it. The transcript itself is a log
   * of printed output, so it is kept.
   */
  const resetTrackedState = () => {
    scrollTopMargin = 1;
    scrollBottomMargin = Infinity;
    originMode = false;
    autowrap = true;
    savedCursor = null;
    // xterm clears the display before homing the cursor, so the open row's
    // screen state must not survive the reset even when the tracked cursor is
    // already on row 1: keeping `current` would let later output overwrite a
    // stale suffix (`LONG` + RIS + `X` would read `XONG`). Committing keeps
    // the printed text (the transcript is a log) and starts a fresh row.
    if (current) commitCurrentLine();
    screenRow = 1;
    cursor = 0;
    cursorCell = 0;
  };

  const restoreTrackedCursor = () => {
    if (!savedCursor) return;
    originMode = savedCursor.originMode;
    autowrap = savedCursor.autowrap;
    const savedCell = Math.min(
      maxChars - 1,
      savedCursor.cell,
      viewportCols > 0 ? viewportCols - 1 : savedCursor.cell,
    );
    if (savedCursor.row !== screenRow && current) commitCurrentLine();
    // A resize that removed the saved row leaves an obsolete target; xterm
    // clamps a restored cursor to the current viewport's bottom row.
    screenRow = viewportRows > 0 ? Math.min(savedCursor.row, viewportRows) : savedCursor.row;
    cursorCell = savedCell;
    cursor = savedCell === 0 ? 0
      : isAsciiOnly(current) ? savedCell
        : sliceStringByCellColumns(current, 0, savedCell, widthTerm).length;
  };

  const writeText = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === CONTROL_BOUNDARY) {
        // A stripped control (an SGR between display chunks, say): xterm
        // consumed a control here, resetting its preceding-join state, so a
        // later continuation must not rejoin the grapheme the tail holds.
        openGrapheme = null;
        i += 1;
        continue;
      }
      if (ch === ESC || ch === C1_CSI) {
        // Any control xterm parses resets its preceding-join state (see the
        // CONTROL_BOUNDARY comment), so a split cluster cannot rejoin across
        // a ride-through cursor or mode control either.
        openGrapheme = null;
        if (ch === ESC && text[i + 1] !== "[") {
          // Bare ESC finals ride through the stripper: DECSC ("ESC 7") saves
          // and DECRC ("ESC 8") restores the tracked cursor; RIS ("ESC c")
          // resets the tracked modes, margins, and cursor.
          if (text[i + 1] === "7") saveTrackedCursor();
          else if (text[i + 1] === "8") restoreTrackedCursor();
          else if (text[i + 1] === "c") resetTrackedState();
          else if (text[i + 1] === "D" || text[i + 1] === "E" || text[i + 1] === "M") {
            const screenBottom = viewportRows > 0 ? viewportRows : 1_000_000;
            // The column these controls keep (NEL returns to the first one).
            const column = text[i + 1] === "E"
              ? 0
              : Math.min(
                maxChars - 1,
                cursorCell,
                viewportCols > 0 ? viewportCols - 1 : cursorCell,
              );
            if (text[i + 1] === "M") {
              // RI: up one row, clamped at the top margin. RI issued while
              // the cursor already sits at that margin makes xterm scroll
              // the region down instead of moving: a blank row opens at the
              // margin and the open row's text slides below it, so commit
              // the open row (the transcript keeps it) rather than letting
              // later output overwrite it in place.
              const topLimit = screenRow >= scrollTopMargin
                ? Math.min(scrollTopMargin, screenBottom)
                : 1;
              const nextRow = Math.max(topLimit, screenRow - 1);
              const scrollsAtMargin = nextRow === screenRow
                && screenRow >= scrollTopMargin
                && screenRow <= scrollBottomMargin;
              if ((nextRow !== screenRow || scrollsAtMargin) && current) {
                commitCurrentLine();
              }
              screenRow = nextRow;
            } else {
              // IND / NEL: down one row, clamped like LF at the scroll
              // region's bottom margin.
              const bottomLimit = screenRow <= scrollBottomMargin
                ? Math.min(scrollBottomMargin, screenBottom)
                : screenBottom;
              screenRow = Math.min(bottomLimit, screenRow + 1);
              commitCurrentLine();
            }
            // commitCurrentLine resets the tracked cursor; restore the column
            // these controls keep, the way the vertical CSI moves do.
            cursor = column === 0 ? 0
              : isAsciiOnly(current) ? column
                : sliceStringByCellColumns(current, 0, column, widthTerm).length;
            cursorCell = column;
          }
          i += 2;
          continue;
        }
        const bodyStart = i + (ch === ESC ? 2 : 1);
        const end = consumeCsiBody(text, bodyStart)!;
        const command = text[end - 1];
        const params = text.slice(bodyStart, end - 1).split(";");
        if (command === "r") {
          // DECSTBM: xterm homes the cursor after (re)setting the scroll
          // margins, and relative row moves inside the region stop at its
          // bottom margin instead of the viewport's bottom row. A region whose
          // bottom is not below its top (after clamping both to the viewport)
          // is ignored entirely, margins and cursor alike.
          const viewportBottom = viewportRows > 0 ? viewportRows : 1_000_000;
          const top = Math.min(Math.max(1, Number(params[0]) || 1), viewportBottom);
          const bottom = Math.min(Number(params[1]) || viewportBottom, viewportBottom);
          if (bottom > top) {
            scrollTopMargin = top;
            scrollBottomMargin = bottom;
            // xterm homes the cursor at the origin-dependent home position:
            // row 1, or the new top margin while DECOM is active.
            const homeRow = originMode ? top : 1;
            if (screenRow !== homeRow && current) commitCurrentLine();
            screenRow = homeRow;
            cursor = 0;
            cursorCell = 0;
          }
          i = end;
          continue;
        }
        if (command === "h" || command === "l") {
          // DECOM (CSI ?6h / ?6l): while set, CUP/HVP/VPA rows are relative to
          // and clamped within the scroll region. The terminal also homes the
          // cursor (to the origin-dependent home) on the mode change.
          // DECAWM (CSI ?7h / ?7l): while off, printable characters never wrap
          // to the next row; they overwrite the last column instead.
          // Private-mode sequences may combine modes in one control
          // (`CSI ?6;7l`); the leading "?" applies to every parameter, so each
          // one must be applied or combined controls would be dropped whole.
          if (params[0]?.startsWith("?")) {
            for (const param of params) {
              const mode = param.replace(/^\?/, "");
              if (mode === "6") {
                originMode = command === "h";
                const homeRow = originMode ? scrollTopMargin : 1;
                if (screenRow !== homeRow && current) commitCurrentLine();
                screenRow = homeRow;
                cursor = 0;
                cursorCell = 0;
              } else if (mode === "7") {
                autowrap = command === "h";
              }
            }
          }
          i = end;
          continue;
        }
        if (command === "s") {
          // SC: remember the cursor row and column so a later restore moves
          // back to it instead of output after it being concatenated onto the
          // row the stripper last saw.
          saveTrackedCursor();
          i = end;
          continue;
        }
        if (command === "u") {
          restoreTrackedCursor();
          i = end;
          continue;
        }
        if (command === "G") {
          // CHA: absolute column move on the current row. Keep placement
          // logical until text arrives, clamped like CUP's column.
          const column = Math.max(0, (Number(params[0]) || 1) - 1);
          const targetCell = Math.min(
            maxChars - 1,
            column,
            viewportCols > 0 ? viewportCols - 1 : column,
          );
          cursor = targetCell === 0 ? 0
            : isAsciiOnly(current) ? targetCell
              : sliceStringByCellColumns(current, 0, targetCell, widthTerm).length;
          cursorCell = targetCell;
          i = end;
          continue;
        }
        if (command === "C" || command === "D") {
          // CUF / CUB: relative horizontal moves stay on the same row, clamped
          // to the last column the way xterm clamps them.
          const move = Math.min(1_000_000, Math.max(1, Number(params[0]) || 1));
          const maxCell = Math.min(
            maxChars - 1,
            viewportCols > 0 ? viewportCols - 1 : 1_000_000,
          );
          // A deferred autowrap (or a DECAWM-off overwrite) parks the tracked
          // cursor one cell past the last column; xterm applies relative moves
          // from the last column it displays, so normalize the sentinel before
          // moving. The move also cancels the pending wrap, as in xterm.
          const baseCell = viewportCols > 0 && cursorCell >= viewportCols
            ? viewportCols - 1
            : cursorCell;
          const targetCell = Math.max(
            0,
            Math.min(maxCell, command === "C" ? baseCell + move : baseCell - move),
          );
          cursor = targetCell === 0 ? 0
            : isAsciiOnly(current) ? targetCell
              : sliceStringByCellColumns(current, 0, targetCell, widthTerm).length;
          cursorCell = targetCell;
          i = end;
          continue;
        }
        const amount = Math.min(1_000_000, Math.max(1, Number(params[0]) || 1));
        // The terminal clamps cursor-row targets to the viewport's bottom row;
        // mirror that so moves past it stay same-row redraws. Inside a scroll
        // region, relative moves stop at the region's bottom margin. Without a
        // known viewport, keep the legacy 1,000,000 cap.
        const screenBottom = viewportRows > 0 ? viewportRows : 1_000_000;
        const bottomLimit = screenRow <= scrollBottomMargin
          ? Math.min(scrollBottomMargin, screenBottom)
          : screenBottom;
        const topLimit = screenRow >= scrollTopMargin
          ? Math.min(scrollTopMargin, screenBottom)
          : 1;
        const nextRow = command === "A" || command === "F"
          ? Math.max(topLimit, screenRow - amount)
          : command === "B" || command === "E"
            ? Math.min(bottomLimit, screenRow + amount)
            : originMode
              // Origin mode makes CUP/HVP/VPA rows relative to (and clamped
              // within) the scroll region's margins.
              ? Math.min(Math.min(scrollBottomMargin, screenBottom), scrollTopMargin + amount - 1)
              : Math.min(screenBottom, amount);
        const column = command === "H" || command === "f"
          ? Math.max(0, (Number(params[1]) || 1) - 1)
          : command === "E" || command === "F" ? 0 : cursorCell;
        if (nextRow !== screenRow && current) commitCurrentLine();
        // CUP/HVP set both coordinates; vertical-only moves keep the column.
        // Keep placement logical until text arrives; cursor moves print no spaces.
        // Bound eventual padding by the transcript budget and, when known, the
        // viewport width: xterm clamps the column to the last one on screen,
        // while an unclamped column would fabricate wrapped rows.
        const targetCell = Math.min(
          maxChars - 1,
          column,
          viewportCols > 0 ? viewportCols - 1 : column,
        );
        cursor = targetCell === 0 ? 0
          : isAsciiOnly(current) ? targetCell
            : sliceStringByCellColumns(current, 0, targetCell, widthTerm).length;
        cursorCell = targetCell;
        screenRow = nextRow;
        i = end;
        continue;
      }
      if (ch === "\n") {
        // xterm scrolls at the viewport's bottom row (or the scroll region's
        // bottom margin) and leaves the cursor on that row; advancing past it
        // would turn a later same-row redraw into a row transition.
        const screenBottom = viewportRows > 0 ? viewportRows : 1_000_000;
        const bottomLimit = screenRow <= scrollBottomMargin
          ? Math.min(scrollBottomMargin, screenBottom)
          : screenBottom;
        screenRow = Math.min(bottomLimit, screenRow + 1);
        commitCurrentLine();
        i += 1;
        continue;
      }
      if (ch === "\r") {
        cursor = 0;
        cursorCell = 0;
        i += 1;
        continue;
      }
      if (ch === "\b") {
        cursor = Math.max(0, cursor - 1);
        cursorCell = Math.max(0, cursorCell - 1);
        i += 1;
        continue;
      }
      if (ch === ERASE_TO_END_OF_LINE) {
        current = current.slice(0, cursor);
        // The erased suffix may have contained the open grapheme.
        openGrapheme = null;
        currentCellWidth = pieceCellWidth(current, widthTerm);
        i += 1;
        continue;
      }
      if (ch === ERASE_START_TO_CURSOR) {
        // Erase from the line start through the cursor, inclusive: blank the
        // intersected cells and keep the untouched suffix at its columns, the
        // way xterm fills the erased cells with blanks. The cursor stays put.
        openGrapheme = null;
        const throughCursor = Math.min(cursorCell + 1, currentCellWidth);
        if (throughCursor > 0) {
          // A grapheme straddling the erase boundary is erased in full, so the
          // blanked prefix extends to the next grapheme that starts after it.
          const suffixStart = firstGraphemeStartCellAtOrAfter(current, throughCursor, widthTerm);
          const suffix = suffixStart < currentCellWidth
            ? sliceStringByCellColumns(current, suffixStart, undefined, widthTerm)
            : "";
          current = " ".repeat(suffixStart) + suffix;
          currentCellWidth = suffixStart + pieceCellWidth(suffix, widthTerm);
          cursor = isAsciiOnly(current) ? cursorCell
            : sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length;
        }
        i += 1;
        continue;
      }
      if (ch === ERASE_WHOLE_LINE) {
        // Erase the whole line: the transcript keeps the cursor's column, so a
        // later write re-pads the gap the way xterm renders the blanked cells.
        current = "";
        cursor = 0;
        openGrapheme = null;
        currentCellWidth = 0;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        // Expand to the next 8-column tab stop so row widths match how the
        // preview overlay renders the text; a literal tab renders at the tab
        // stop and would be clipped instead of wrapped onto a continuation row.
        const padding = TERMINAL_TAB_STOP_COLUMNS - (cursorCell % TERMINAL_TAB_STOP_COLUMNS);
        writeSpan(" ".repeat(padding));
        i += 1;
        continue;
      }
      let end = i;
      while (
        end < text.length
        && text[end] !== "\n"
        && text[end] !== "\r"
        && text[end] !== "\b"
        && text[end] !== "\t"
        && text[end] !== ESC
        && text[end] !== C1_CSI
        && text[end] !== ERASE_TO_END_OF_LINE
        && text[end] !== ERASE_START_TO_CURSOR
        && text[end] !== ERASE_WHOLE_LINE
        && text[end] !== CONTROL_BOUNDARY
      ) {
        end += 1;
      }
      writeSpan(text.slice(i, end));
      i = end;
    }
  };

  const getLines = (): readonly string[] => (current ? [...lines, current] : lines);

  const refreshPreviewCache = (cols: number) => {
    if (!cacheDirty && cacheCols === cols) return;
    cacheRows = buildPreviewRows(
      getLines(),
      current ? [...lineWrapFlags, currentStartsWrapped] : lineWrapFlags,
      cols,
      widthTerm,
    );
    cacheCols = cols;
    cacheDirty = false;
  };

  const history: TerminalOutputHistoryPreview = {
    append(chunk: string): void {
      if (!chunk) return;
      const { text, pending } = stripTerminalDisplayToPlainText(chunk, pendingEscape, true);
      pendingEscape = pending;
      if (!text) return;
      writeText(text);
      cacheDirty = true;
    },
    clear(): void {
      lines = [];
      lineWrapFlags = [];
      currentStartsWrapped = false;
      current = "";
      openGrapheme = null;
      currentCellWidth = 0;
      cursor = 0;
      cursorCell = 0;
      totalChars = 0;
      pendingEscape = "";
      screenRow = 1;
      // The next xterm instance starts with a full-viewport scroll region.
      scrollTopMargin = 1;
      scrollBottomMargin = Infinity;
      originMode = false;
      autowrap = true;
      savedCursor = null;
      cacheDirty = true;
    },
    getLines,
    getPreviewRowCount(cols: number): number {
      refreshPreviewCache(cols);
      return cacheRows.length;
    },
    getPreviewRows({ cols, rows: visibleRows, top }): OutputHistoryPreviewWindow {
      const columnCount = Math.max(1, cols);
      const rowCount = Math.max(1, visibleRows);
      refreshPreviewCache(columnCount);
      const totalRows = cacheRows.length;
      const clampedTop = clampOutputHistoryPreviewTop(top, totalRows, rowCount);
      const window = cacheRows.slice(clampedTop, clampedTop + rowCount);
      while (window.length < rowCount) window.push({ isWrapped: false, text: "" });
      return { rows: window, totalRows };
    },
    setViewportRows(rows: number): void {
      const nextRows = Math.max(0, Math.floor(rows));
      if (nextRows !== viewportRows) {
        // xterm resets the scroll region to the full new viewport whenever the
        // terminal size changes; keep the tracked margins in step so relative
        // moves clamp to the new bounds instead of the previous ones.
        scrollTopMargin = 1;
        scrollBottomMargin = nextRows > 0 ? nextRows : Infinity;
      }
      viewportRows = nextRows;
      if (viewportRows > 0) {
        // xterm clamps its cursor as soon as the viewport shrinks; keep the
        // tracked row inside the new bounds so a later relative move is not
        // misread as a row transition.
        screenRow = Math.min(screenRow, viewportRows);
      }
    },
    setWidthTerminal(term: WidthTerm | null): void {
      widthTerm = term ?? null;
    },
    syncViewportAfterResize({ cols, rows, cursorX, cursorY, cursorLine, isWrapped }): void {
      history.setViewportRows(rows);
      history.setViewportCols(cols);
      // Xterm knows which committed rows reflowed and whether this buffer
      // supports reflow. Do not infer the new cursor from transcript rows:
      // they can include earlier redraws that no longer occupy the screen.
      // The alternate buffer can retain hidden cells and expose them again
      // when widened, unlike normal-buffer cursor-line truncation. Read the
      // visible cursor row rather than applying that truncation to both.
      const resizedLine = cursorLine.slice(0, maxChars);
      if (current !== resizedLine || currentStartsWrapped !== isWrapped) {
        current = resizedLine;
        currentStartsWrapped = isWrapped;
        currentCellWidth = pieceCellWidth(current, widthTerm);
        openGrapheme = null;
        cacheDirty = true;
      }
      screenRow = Math.max(1, Math.min(rows, cursorY + 1));
      cursorCell = Math.max(0, Math.min(cols - 1, cursorX));
      cursor = cursorCell === 0 ? 0
        : isAsciiOnly(current) ? cursorCell
          : sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length;
    },
    setViewportCols(cols: number): void {
      const nextCols = Math.max(0, Math.floor(cols));
      if (nextCols === viewportCols) return;
      const narrowed = viewportCols > 0 && nextCols < viewportCols;
      // xterm resets its scroll region on any buffer resize, including a
      // width-only one where setViewportRows sees no row change; keep the
      // tracked margins in step so relative moves clamp to the live bounds
      // instead of a region set for the previous size.
      scrollTopMargin = 1;
      scrollBottomMargin = viewportRows > 0 ? viewportRows : Infinity;
      viewportCols = nextCols;
      if (viewportCols <= 0) return;
      if (narrowed && currentCellWidth > viewportCols) {
        // xterm trims the cursor row to the new width when the terminal
        // narrows (`reflowCursorLine` defaults to false, so the overflow is
        // discarded instead of re-wrapped into a continuation row); drop the
        // same characters from the tracked open line so later output lands on
        // the row xterm actually shows instead of retaining a phantom tail.
        current = sliceStringByCellColumns(current, 0, viewportCols, widthTerm);
        currentCellWidth = pieceCellWidth(current, widthTerm);
        // Hidden previews can skip intermediate widths; invalidate by content
        // change even when the next read reuses the cached column count.
        cacheDirty = true;
        // The grapheme the last append left open may have been trimmed away.
        if (openGrapheme !== null && openGraphemeCell > viewportCols) {
          openGrapheme = null;
        }
      }
      if (cursorCell > viewportCols - 1) {
        // xterm clamps its cursor to the new last column as soon as the
        // terminal narrows; keep the tracked column (and its UTF-16 index) in
        // step so the next printable span lands there instead of padding past
        // the viewport edge.
        cursorCell = viewportCols - 1;
        cursor = cursorCell === 0 ? 0
          : isAsciiOnly(current) ? cursorCell
            : sliceStringByCellColumns(current, 0, cursorCell, widthTerm).length;
      }
    },
  };
  return history;
};
