import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Strip full-screen redraw sequences inside DEC Mode 2026 synchronized-output
 * blocks before data reaches xterm.js.
 *
 * Codex and Claude Code emit `\x1b[H` + `\x1b[2J` inside sync blocks for
 * full-screen frames. xterm.js resets viewportY on `\x1b[2J`, which yanks
 * scroll position. Incremental sync blocks must pass through untouched.
 *
 * Detection follows anthropics/claude-code#35580: only blocks that contain
 * both cursor-home and erase-display are treated as full redraws. Pane (#120)
 * strips `\x1b[2J`; we also hold the leading `\x1b[H` until `\x1b[2J` confirms
 * the redraw so incremental blocks that never emit `\x1b[2J` still work.
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
  /** null = unknown; true = strip home+clear; false = pass block through. */
  fullRedrawBlock: boolean | null;
};

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

  for (let length = input.length; length > 0; length -= 1) {
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

/** True when the user has scrolled up into scrollback history. */
export const isTerminalViewportScrolledUp = (term: XTerm): boolean => {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") {
    return false;
  }
  return buffer.viewportY < buffer.baseY;
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

    if (!state.inSyncBlock) {
      result += input[index];
      index += 1;
      continue;
    }

    if (state.fullRedrawBlock === false) {
      result += input[index];
      index += 1;
      continue;
    }

    const cursorHome = readBlockCursorHome(input, index);
    if (cursorHome) {
      if (state.fullRedrawBlock === true) {
        index = cursorHome.end;
        continue;
      }
      if (!shouldStripFullRedrawClear(term)) {
        result += cursorHome.raw;
        index = cursorHome.end;
        continue;
      }
      state.pendingCursorHome = cursorHome.raw;
      index = cursorHome.end;
      continue;
    }

    if (input.startsWith(CLEAR, index)) {
      if (state.pendingCursorHome !== null) {
        state.pendingCursorHome = null;
        state.fullRedrawBlock = true;
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
      state.fullRedrawBlock = false;
      result += CLEAR;
      index += CLEAR.length;
      continue;
    }

    if (state.pendingCursorHome !== null) {
      result += state.pendingCursorHome;
      state.pendingCursorHome = null;
    }

    result += input[index];
    index += 1;
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
