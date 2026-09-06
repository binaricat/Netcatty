import {
  sliceStringByCellColumns,
  stringCellWidth,
} from "../../terminal/autocomplete/terminalStringCellWidth";
import type { HistoryPreviewRow } from "./terminalHistoryScrollOverride";

/**
 * Plain-text transcript of what a session printed, used as the alternate-screen
 * history preview data source (#2516).
 *
 * Inside screen/vim/codex the app owns the alternate buffer, so xterm's normal
 * buffer has no scrollback and the preview has nothing to show. The output
 * stream is the only usable source, so every display chunk fed to the log
 * capture is reduced to plain lines here: row moves separate printed lines, a bare
 * `\r` overwrites the line it restarts (progress bars/spinners stay one line),
 * and the retained tail is bounded.
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

/**
 * The erase-in-line sequences progress lines use (`\r` + text + `\x1b[K`) must
 * be applied to the transcript, or the stale suffix of a shorter redraw shows
 * up as text. Returns the marker for the variants the transcript can apply.
 */
const eraseInLineMarkerFor = (input: string, start: number, end: number): string | null => {
  if (input[end - 1] !== "K") return null;
  const introducerLength = escapeIntroducerLength(input, start);
  const mode = input.slice(start + introducerLength, end - 1).split(";")[0];
  // Erase from start to cursor (1) has no transcript equivalent; skip it.
  if (mode === "1") return null;
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
      // Only the history writer consumes cursor-row controls. Standalone plain
      // text stripping keeps its original contract.
      if (preserveRowControls
        && (input[i] === C1_CSI || input[i + 1] === "[")
        && /^[0-9;]*[HfABEFdr]$/.test(input.slice(i + escapeIntroducerLength(input, i), end))) {
        output += input.slice(i, end);
      }
      const eraseInLine = eraseInLineMarkerFor(input, i, end);
      if (eraseInLine) output += eraseInLine;
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

const isAsciiOnly = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
};

/** Cell columns a transcript span occupies (wide glyphs count twice). */
const pieceCellWidth = (text: string): number =>
  isAsciiOnly(text) ? text.length : stringCellWidth(text);

/**
 * Wrap one transcript line into viewport-sized rows. Continuation rows carry
 * the same `isWrapped` flag xterm uses so soft-wrapped selection joins keep
 * working (see joinHistoryPreviewSelectionText).
 */
export const wrapOutputHistoryLineToRows = (text: string, cols: number): string[] => {
  if (cols < 1) return [text];
  const ascii = isAsciiOnly(text);
  const width = ascii ? text.length : stringCellWidth(text);
  if (width <= cols) return [text];

  const rows: string[] = [];
  let startCell = 0;
  while (startCell < width) {
    // ASCII lines skip the grapheme segmenter; a transcript can hold long lines.
    const row = ascii
      ? text.slice(startCell, startCell + cols)
      : sliceStringByCellColumns(text, startCell, startCell + cols);
    if (!row) break;
    rows.push(row);
    startCell += ascii ? row.length : stringCellWidth(row);
  }
  return rows.length > 0 ? rows : [text];
};

const buildPreviewRows = (lines: readonly string[], cols: number): HistoryPreviewRow[] => {
  const rows: HistoryPreviewRow[] = [];
  for (const line of lines) {
    const wrapped = wrapOutputHistoryLineToRows(line, cols);
    for (let row = 0; row < wrapped.length; row += 1) {
      rows.push({ isWrapped: row > 0, text: wrapped[row] });
    }
  }
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
}

export const createTerminalOutputHistoryPreview = (options?: {
  maxLines?: number;
  maxChars?: number;
}): TerminalOutputHistoryPreview => {
  const maxLines = Math.max(1, options?.maxLines ?? DEFAULT_OUTPUT_HISTORY_MAX_LINES);
  const maxChars = Math.max(1, options?.maxChars ?? DEFAULT_OUTPUT_HISTORY_MAX_CHARS);
  let lines: string[] = [];
  let current = "";
  let cursor = 0;
  let cursorCell = 0;
  let screenRow = 1;
  let currentCellWidth = 0;
  let totalChars = 0;
  let pendingEscape = "";
  let viewportRows = 0;
  let viewportCols = 0;
  // Active DECSTBM scroll margins (1-based rows); Infinity means "viewport bottom".
  let scrollTopMargin = 1;
  let scrollBottomMargin = Infinity;
  let cacheDirty = true;
  let cacheCols = -1;
  let cacheRows: HistoryPreviewRow[] = [];

  const commitCurrentLine = () => {
    lines.push(current);
    totalChars += current.length;
    current = "";
    currentCellWidth = 0;
    cursor = 0;
    cursorCell = 0;
    // Never trim away the last retained line.
    while (lines.length > maxLines || (totalChars > maxChars && lines.length > 1)) {
      const dropped = lines.shift();
      if (dropped === undefined) break;
      totalChars -= dropped.length;
    }
  };

  /**
   * Write one span at the open line's cursor. A cursor-addressed redraw
   * (cursor-home CSI stripped, no LF) would keep appending frames to the open
   * line forever, so the budget is enforced here: spans are written in bounded
   * pieces, committing a full line at the cap, so nothing is dropped and the
   * copy every write makes stays bounded.
   */
  const writeSpan = (span: string) => {
    let offset = 0;
    while (offset < span.length) {
      if (current.length >= maxChars) commitCurrentLine();
      const width = currentCellWidth;
      if (cursorCell > width) {
        current += " ".repeat(cursorCell - width);
        cursor = current.length;
      }
      const piece = span.slice(offset, offset + (maxChars - current.length));
      if (!piece) return;
      const pieceAscii = isAsciiOnly(piece);
      const pieceWidth = pieceAscii ? piece.length : stringCellWidth(piece);
      const appending = cursor >= current.length;
      if (appending) {
        current += piece;
      } else if (pieceAscii && isAsciiOnly(current)) {
        current = current.slice(0, cursor) + piece + current.slice(cursor + piece.length);
      } else {
        // Cursor coordinates count cells, while strings count UTF-16 units.
        // Replace entire intersected graphemes and blank any remaining half
        // of a wide glyph, retaining the columns of the untouched suffix.
        const prefix = sliceStringByCellColumns(current, 0, cursorCell);
        const endCell = cursorCell + pieceWidth;
        const endPrefix = sliceStringByCellColumns(current, 0, endCell);
        const overlapsWideEnd = pieceCellWidth(endPrefix) < Math.min(endCell, width);
        const suffix = sliceStringByCellColumns(current, endCell + (overlapsWideEnd ? 1 : 0));
        current = prefix + " ".repeat(cursorCell - pieceCellWidth(prefix))
          + piece + (overlapsWideEnd ? " " : "") + suffix;
      }
      cursorCell += pieceWidth;
      currentCellWidth = Math.max(width, cursorCell);
      cursor = appending ? current.length
        : isAsciiOnly(current) ? cursorCell
          : sliceStringByCellColumns(current, 0, cursorCell).length;
      offset += piece.length;
    }
  };

  const writeText = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ESC || ch === C1_CSI) {
        const bodyStart = i + (ch === ESC ? 2 : 1);
        const end = consumeCsiBody(text, bodyStart)!;
        const command = text[end - 1];
        const params = text.slice(bodyStart, end - 1).split(";");
        if (command === "r") {
          // DECSTBM: xterm homes the cursor after (re)setting the scroll
          // margins, and relative row moves inside the region stop at its
          // bottom margin instead of the viewport's bottom row.
          scrollTopMargin = Math.max(1, Number(params[0]) || 1);
          scrollBottomMargin = Math.max(
            scrollTopMargin,
            Number(params[1]) || (viewportRows > 0 ? viewportRows : 1_000_000),
          );
          if (screenRow !== 1 && current) commitCurrentLine();
          screenRow = 1;
          cursor = 0;
          cursorCell = 0;
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
            : sliceStringByCellColumns(current, 0, targetCell).length;
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
        currentCellWidth = pieceCellWidth(current);
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
    cacheRows = buildPreviewRows(getLines(), cols);
    cacheCols = cols;
    cacheDirty = false;
  };

  return {
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
      current = "";
      currentCellWidth = 0;
      cursor = 0;
      cursorCell = 0;
      totalChars = 0;
      pendingEscape = "";
      screenRow = 1;
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
      viewportRows = Math.max(0, Math.floor(rows));
      if (viewportRows > 0) {
        // xterm clamps its cursor as soon as the viewport shrinks; keep the
        // tracked row (and any scroll margins) inside the new bounds so a
        // later relative move is not misread as a row transition.
        screenRow = Math.min(screenRow, viewportRows);
        scrollBottomMargin = Math.min(scrollBottomMargin, viewportRows);
      }
    },
    setViewportCols(cols: number): void {
      viewportCols = Math.max(0, Math.floor(cols));
    },
  };
};