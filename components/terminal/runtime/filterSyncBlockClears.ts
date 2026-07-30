import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Soften full-screen redraw clears inside DEC Mode 2026 synchronized-output
 * blocks before data reaches xterm.js.
 *
 * Codex and Claude Code emit `\x1b[H` + `\x1b[2J` inside sync blocks for
 * full-screen frames. xterm.js resets viewportY on `\x1b[2J`, which yanks
 * scroll position when the user is reading scrollback (xterm.js#5801).
 * Incremental sync blocks must pass through untouched.
 *
 * Detection follows anthropics/claude-code#35580: only blocks that contain
 * both cursor-home and erase-display are treated as full redraws. Pane (#120)
 * strips `\x1b[2J` only. We hold the leading `\x1b[H` until `\x1b[2J` confirms
 * the redraw, then:
 *   - emit the held cursor-home (so the new frame still starts at the origin)
 *   - strip only `\x1b[2J` (to avoid viewport yank)
 *
 * Stripping both home and clear used to stack whole TUI frames when
 * `viewportY < baseY` was a false positive (overflow / sticky lag, #2291).
 *
 * @see https://github.com/Dcouple-Inc/Pane/pull/120
 * @see https://github.com/anthropics/claude-code/issues/35580
 * @see https://github.com/xtermjs/xterm.js/issues/5801
 */

export type SyncBlockFilterState = {
  inSyncBlock: boolean;
  pending: string;
  /** Leading `\x1b[H` held until `\x1b[2J` confirms a full redraw. */
  pendingCursorHome: string | null;
  /**
   * null = unknown;
   * true = strip further clears in this block (home already emitted);
   * false = pass remaining block through.
   */
  fullRedrawBlock: boolean | null;
};

/**
 * Minimum rows into scrollback before we treat the viewport as "reading
 * history" and soft-strip full-redraw clears.
 *
 * Intentional 1-row peeks still receive `\x1b[2J` (possible viewport yank);
 * that is deliberate so a 1-row sticky-bottom / trackpad lag cannot strip
 * agent TUI frames (#2291).
 */
export const SYNC_BLOCK_SCROLLBACK_STRIP_MIN_ROWS = 2;

export type SyncBlockClearFilterResult = {
  output: string;
  startedSyncBlock: boolean;
};

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";
const CURSOR_HOME_EXPLICIT = "\x1b[1;1H";

const MARKERS = [SYNC_START, SYNC_END, CLEAR, CURSOR_HOME, CURSOR_HOME_EXPLICIT] as const;

/** Shared prefix of SYNC_START / SYNC_END, used to hop across plain spans. */
const SYNC_PREFIX = "\x1b[?2026";

const maxMarkerPrefixLength = Math.max(...MARKERS.map((marker) => marker.length)) - 1;

const isIncompleteEscapePrefix = (suffix: string): boolean => {
  if (!suffix.startsWith("\x1b")) {
    return false;
  }

  const isCsiFinal = (ch: string): boolean => ch >= "@" && ch <= "~";

  let index = 0;
  while (index < suffix.length) {
    if (suffix.startsWith("\x1b[", index)) {
      let hasFinal = false;
      for (let i = index + 2; i < suffix.length; i += 1) {
        if (isCsiFinal(suffix[i])) {
          index = i + 1;
          hasFinal = true;
          break;
        }
      }
      if (!hasFinal) {
        return true;
      }
      continue;
    }

    if (suffix[index] === "\x1b") {
      if (index === suffix.length - 1) {
        return true;
      }
      index += 1;
      continue;
    }

    index += 1;
  }

  return false;
};

const hasCsiFinalByte = (input: string, from: number): boolean => {
  for (let index = from; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return true;
    }
  }
  return false;
};

/**
 * True when some suffix of `input` could parse as an incomplete escape
 * sequence. An incomplete parse requires either a trailing lone ESC, or an
 * `\x1b[` occurrence with no CSI final byte after it. Since `[` itself is in
 * the final-byte range (0x40-0x7e), it is sufficient to check the last
 * `\x1b[`: every earlier one scans a superset that includes that `[`.
 */
const mayEndWithIncompleteEscape = (input: string): boolean => {
  if (input.length === 0) {
    return false;
  }
  if (input.charCodeAt(input.length - 1) === 0x1b) {
    return true;
  }
  const lastCsiIntro = input.lastIndexOf("\x1b[");
  return lastCsiIntro !== -1 && !hasCsiFinalByte(input, lastCsiIntro + 2);
};

const splitPendingMarkerSuffix = (input: string): { emit: string; pending: string } => {
  const markerMax = Math.min(input.length, maxMarkerPrefixLength);
  for (let length = markerMax; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(suffix) && marker.length > suffix.length)) {
      return {
        emit: input.slice(0, -length),
        pending: suffix,
      };
    }
  }

  // Without this gate, every ESC-bearing chunk pays an O(n * escapes) scan
  // below (quadratic on colored output floods); the gate settles the common
  // complete-tail case with one native lastIndexOf.
  if (!mayEndWithIncompleteEscape(input)) {
    return { emit: input, pending: "" };
  }

  // Only suffixes that start with ESC can qualify; skip other start positions
  // with a charCode probe so no substring is allocated for them.
  //
  // Scan SHORTEST suffix first (from the end of the chunk backwards).
  // `isIncompleteEscapePrefix` walks forward across *complete* sequences and
  // only reports the incomplete one it eventually reaches, so it also answers
  // `true` for every longer suffix that merely contains the incomplete tail —
  // including the one starting at the chunk's first ESC. Scanning longest-first
  // therefore held back everything from that first ESC onwards instead of just
  // the split sequence. On escape-dense output (a 60fps TUI painting per-cell
  // truecolor backgrounds) the first ESC sits within a few bytes of the chunk
  // start, so whole chunks were withheld and `state.pending` grew across chunks
  // until one happened to end on a clean boundary — xterm then received nothing
  // for hundreds of ms followed by a ~1MB burst. The last ESC in the chunk is
  // the real split point: an incomplete CSI cannot contain a further ESC.
  for (let length = 1; length <= input.length; length += 1) {
    if (input.charCodeAt(input.length - length) !== 0x1b) {
      continue;
    }
    const suffix = input.slice(-length);
    if (isIncompleteEscapePrefix(suffix)) {
      return {
        emit: input.slice(0, -length),
        pending: suffix,
      };
    }
  }

  return { emit: input, pending: "" };
};

const readBlockCursorHome = (
  input: string,
  index: number,
): { raw: string; end: number } | null => {
  if (input.startsWith(CURSOR_HOME_EXPLICIT, index)) {
    return { raw: CURSOR_HOME_EXPLICIT, end: index + CURSOR_HOME_EXPLICIT.length };
  }
  if (input.startsWith(CURSOR_HOME, index)) {
    return { raw: CURSOR_HOME, end: index + CURSOR_HOME.length };
  }
  return null;
};

const releasePendingCursorHome = (state: SyncBlockFilterState, result: string): string => {
  if (!state.pendingCursorHome) {
    return result;
  }
  const released = `${result}${state.pendingCursorHome}`;
  state.pendingCursorHome = null;
  return released;
};

const resetSyncBlockState = (state: SyncBlockFilterState): void => {
  state.inSyncBlock = false;
  state.pendingCursorHome = null;
  state.fullRedrawBlock = null;
};

/**
 * True when the user is reading scrollback far enough that a full-redraw
 * `\x1b[2J` would yank the viewport. Alternate screen never strips.
 */
export const isTerminalViewportScrolledUp = (term: XTerm): boolean => {
  const buffer = term.buffer?.active;
  if (!buffer || buffer.type !== "normal") {
    return false;
  }
  const scrolledRows = buffer.baseY - buffer.viewportY;
  return scrolledRows >= SYNC_BLOCK_SCROLLBACK_STRIP_MIN_ROWS;
};

const shouldStripFullRedrawClear = (term?: XTerm): boolean =>
  term !== undefined && isTerminalViewportScrolledUp(term);

const scanSyncBlockClears = (
  input: string,
  state: SyncBlockFilterState,
  term?: XTerm,
): SyncBlockClearFilterResult => {
  let result = "";
  let startedSyncBlock = false;
  let index = 0;

  while (index < input.length) {
    if (input.startsWith(SYNC_START, index)) {
      resetSyncBlockState(state);
      state.inSyncBlock = true;
      startedSyncBlock = true;
      result += SYNC_START;
      index += SYNC_START.length;
      continue;
    }

    if (input.startsWith(SYNC_END, index)) {
      result = releasePendingCursorHome(state, result);
      resetSyncBlockState(state);
      result += SYNC_END;
      index += SYNC_END.length;
      continue;
    }

    if (!state.inSyncBlock || state.fullRedrawBlock === false) {
      // Pass-through span: nothing to rewrite until the next possible sync
      // marker. Hop there with a native scan instead of copying per char.
      // The current position is known not to start SYNC_START/SYNC_END, so
      // consuming at least one character here is safe.
      const nextMarker = input.indexOf(SYNC_PREFIX, index + 1);
      const end = nextMarker === -1 ? input.length : nextMarker;
      result += input.slice(index, end);
      index = end;
      continue;
    }

    const cursorHome = readBlockCursorHome(input, index);
    if (cursorHome) {
      if (state.fullRedrawBlock === true) {
        // Home already applied for this full redraw; drop redundant homes so
        // we do not re-hold and re-pair with a later clear incorrectly.
        index = cursorHome.end;
        continue;
      }
      if (!shouldStripFullRedrawClear(term)) {
        result += cursorHome.raw;
        index = cursorHome.end;
        continue;
      }
      // Hold until `\x1b[2J` confirms a full redraw; home is re-emitted then.
      state.pendingCursorHome = cursorHome.raw;
      index = cursorHome.end;
      continue;
    }

    if (input.startsWith(CLEAR, index)) {
      if (state.pendingCursorHome !== null) {
        // Full redraw pair: always re-emit the held home so the frame starts
        // at the origin (#2291). Re-check scroll at CLEAR time — home may have
        // been held while scrolled, then the user returned to the live bottom
        // before 2J arrived in a later PTY chunk.
        result += state.pendingCursorHome;
        state.pendingCursorHome = null;
        if (shouldStripFullRedrawClear(term)) {
          state.fullRedrawBlock = true;
        } else {
          result += CLEAR;
          state.fullRedrawBlock = null;
        }
        index += CLEAR.length;
        continue;
      }
      if (state.fullRedrawBlock === true) {
        index += CLEAR.length;
        continue;
      }
      if (!shouldStripFullRedrawClear(term)) {
        result += CLEAR;
        index += CLEAR.length;
        continue;
      }
      // Standalone clear (no leading home) is not a full redraw pair.
      state.fullRedrawBlock = false;
      result += CLEAR;
      index += CLEAR.length;
      continue;
    }

    if (state.pendingCursorHome !== null) {
      result += state.pendingCursorHome;
      state.pendingCursorHome = null;
    }

    // Inside an active sync block every marker starts with ESC; hop to the
    // next ESC and copy the plain span in one slice.
    const nextEsc = input.indexOf("\x1b", index + 1);
    const end = nextEsc === -1 ? input.length : nextEsc;
    result += input.slice(index, end);
    index = end;
  }

  return { output: result, startedSyncBlock };
};

export const filterSyncBlockClearsWithMeta = (
  data: string,
  state: SyncBlockFilterState,
  term?: XTerm,
): SyncBlockClearFilterResult => {
  if (!state.inSyncBlock && !state.pending && !data.includes("\x1b")) {
    return { output: data, startedSyncBlock: false };
  }

  const { emit, pending } = splitPendingMarkerSuffix(`${state.pending}${data}`);
  state.pending = pending;
  if (!emit) {
    return { output: "", startedSyncBlock: false };
  }

  return scanSyncBlockClears(emit, state, term);
};

export const filterSyncBlockClears = (
  data: string,
  state: SyncBlockFilterState,
  term?: XTerm,
): string => filterSyncBlockClearsWithMeta(data, state, term).output;

export const createSyncBlockFilterState = (): SyncBlockFilterState => ({
  inSyncBlock: false,
  pending: "",
  pendingCursorHome: null,
  fullRedrawBlock: null,
});
