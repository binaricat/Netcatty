import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  applyAltScreenAction,
  createTerminalLineTimestampSegmenter,
  formatTerminalLineTimestamp,
  getTerminalLineTimestampLedgerCount,
  getVisibleTerminalLineTimestampRows,
  isSimpleAsciiControlText,
  materializeTimestampLedgerToMarkers,
  onTerminalLineTimestampsChange,
  resolveTerminalLineTimestampCapacity,
  resolveTerminalTimestampGutterRows,
  resolveTerminalTimestampGutterRowsFromLedger,
  tryMeasureVisualRows,
  writeTerminalDataWithLineTimestamps,
  type StampCursorEstimate,
} from "./terminalLineTimestamps.ts";
import {
  isTerminalScrollbackSaturated,
  resetTerminalOutputPressure,
  setTerminalOutputPressureLargeOutput,
} from "./terminalOutputPressure.ts";
import { MAX_INCOMPLETE_TERMINAL_CONTROL_SEQUENCE_CHARS } from "./terminalControlSequenceLimits.ts";

const createFakeTerm = (options: {
  cols?: number;
  wraparoundMode?: boolean;
  scrollback?: number;
  rows?: number;
  /**
   * When true, a full buffer recycles like real xterm: length/baseY stay fixed
   * and live markers shift down via onTrim-style line decrements. Default false
   * keeps the growing-baseY model used by older tests.
   */
  circularTrim?: boolean;
  /** Mirror xterm windowOptions.setWinLines (DECCOLM buffer reset gate). */
  setWinLines?: boolean;
} = {}) => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  const liveMarkers: Array<{
    line: number;
    isDisposed: boolean;
    dispose: () => void;
    attachedScreen: "normal" | "alternate";
  }> = [];
  let cursorLine = 0;
  const cols = options.cols ?? Number.POSITIVE_INFINITY
  let wraparoundMode = options.wraparoundMode ?? true;
  /** Incomplete ESC/CSI retained across write() calls (xterm parser behavior). */
  let writeParserPrefix = "";
  const scrollback = options.scrollback;
  const rows = options.rows ?? 24;
  const circularTrim = options.circularTrim === true;
  // DECSTBM scrolling region (0-based, inclusive), matching xterm _core.buffer.
  let scrollTop = 0;
  let scrollBottom = rows - 1;
  const isCombiningMark = (char: string): boolean => {
    const code = char.codePointAt(0);
    return code !== undefined && /\p{Mark}/u.test(String.fromCodePoint(code));
  };
  const cellWidth = (char: string): number => {
    const code = char.codePointAt(0);
    if (code === undefined) return 1;
    if (isCombiningMark(char)) return 0;
    if (
      code === 0x2329
      || code === 0x232a
      || (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0x1f000 && code <= 0x1f02f)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) {
      return 2;
    }
    return 1;
  };
  const readCsiSequence = (data: string, startIndex: number): { sequence: string; endIndex: number } | null => {
    if (data[startIndex] !== "\x1b" || data[startIndex + 1] !== "[") return null;
    for (let index = startIndex + 2; index < data.length; index += 1) {
      const char = data[index];
      if (char >= "@" && char <= "~") {
        return { sequence: data.slice(startIndex, index + 1), endIndex: index };
      }
    }
    return null;
  };
  const applyCsiSequence = (sequence: string): void => {
    const final = sequence.at(-1);
    const params = sequence.slice(2, -1);
    const firstParam = Number.parseInt(params.split(";")[0] || "1", 10);
    const count = Number.isFinite(firstParam) && firstParam > 0 ? firstParam : 1;
    if (sequence === "\x1b[?7h") {
      wraparoundMode = true;
    } else if (sequence === "\x1b[?7l") {
      wraparoundMode = false;
    } else if (final === "A") {
      cursorLine = Math.max(0, cursorLine - count);
    } else if (final === "B") {
      cursorLine += count;
    } else if (final === "r" && !params.startsWith("?")) {
      // DECSTBM: CSI Pt ; Pb r — set scrolling region (1-based → 0-based).
      const parts = params.split(";");
      const top = Number.parseInt(parts[0] || "1", 10);
      const bottom = Number.parseInt(parts[1] || String(rows), 10);
      const nextTop = Math.max(0, (Number.isFinite(top) && top > 0 ? top : 1) - 1);
      const nextBottom = Math.min(
        rows - 1,
        (Number.isFinite(bottom) && bottom > 0 ? bottom : rows) - 1,
      );
      if (nextTop <= nextBottom) {
        scrollTop = nextTop;
        scrollBottom = nextBottom;
      } else {
        scrollTop = 0;
        scrollBottom = rows - 1;
      }
    } else if ((final === "L" || final === "M") && !params.startsWith("?")) {
      // IL / DL: shift or dispose markers at/below the cursor row (normal only).
      if (screen !== "normal") return;
      const state = normalState;
      const editAt = state.absoluteCursorLine;
      if (final === "L") {
        const nextText = new Map<number, string>();
        for (const [key, value] of state.lineText) {
          nextText.set(key >= editAt ? key + count : key, value);
        }
        state.lineText = nextText;
        for (const marker of liveMarkers) {
          if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
          if (marker.line >= editAt) marker.line += count;
        }
        state.absoluteCursorLine += count;
        cursorLine = state.absoluteCursorLine;
      } else {
        const nextText = new Map<number, string>();
        for (const [key, value] of state.lineText) {
          if (key >= editAt && key < editAt + count) continue;
          nextText.set(key > editAt ? key - count : key, value);
        }
        state.lineText = nextText;
        for (const marker of liveMarkers) {
          if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
          if (marker.line >= editAt && marker.line < editAt + count) {
            marker.dispose();
            continue;
          }
          if (marker.line >= editAt + count) marker.line -= count;
        }
      }
    } else if ((final === "S" || final === "T") && !params.startsWith("?")) {
      // SU / SD: splice lines inside the DECSTBM region (normal only).
      // CSI Pc;Pf;Pr;Pc;Pp T is highlight mouse tracking, not SD.
      if (final === "T" && params.split(";").length >= 5) return;
      if (screen !== "normal") return;
      const state = normalState;
      const regionTop = state.baseY + scrollTop;
      const regionBottom = state.baseY + scrollBottom;
      if (regionBottom < regionTop) return;
      if (final === "S") {
        const nextText = new Map<number, string>();
        for (const [key, value] of state.lineText) {
          if (key >= regionTop && key < regionTop + count) continue;
          if (key >= regionTop + count && key <= regionBottom) {
            nextText.set(key - count, value);
            continue;
          }
          if (key < regionTop || key > regionBottom) nextText.set(key, value);
        }
        state.lineText = nextText;
        for (const marker of liveMarkers) {
          if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
          if (marker.line >= regionTop && marker.line < regionTop + count) {
            marker.dispose();
            continue;
          }
          if (marker.line >= regionTop + count && marker.line <= regionBottom) {
            marker.line -= count;
          }
        }
      } else {
        const nextText = new Map<number, string>();
        for (const [key, value] of state.lineText) {
          if (key > regionBottom - count && key <= regionBottom) continue;
          if (key >= regionTop && key <= regionBottom - count) {
            nextText.set(key + count, value);
            continue;
          }
          if (key < regionTop || key > regionBottom) nextText.set(key, value);
        }
        state.lineText = nextText;
        for (const marker of liveMarkers) {
          if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
          if (marker.line > regionBottom - count && marker.line <= regionBottom) {
            marker.dispose();
            continue;
          }
          if (marker.line >= regionTop && marker.line <= regionBottom - count) {
            marker.line += count;
          }
        }
      }
    } else if (final === "J") {
      // Erase in display: clear cells and dispose markers on affected rows
      // (in-place erase; mirrors xterm when scrollOnEraseInDisplay is off).
      const state = currentState();
      const rawParams = params.startsWith("?") ? params.slice(1) : params;
      const mode = Number.parseInt(rawParams.split(";")[0] || "0", 10);
      const viewportTop = state.baseY;
      const viewportBottom = state.baseY + rows - 1;
      let clearFrom = viewportTop;
      let clearTo = viewportBottom;
      if (mode === 0) {
        clearFrom = state.absoluteCursorLine;
        clearTo = viewportBottom;
      } else if (mode === 1) {
        clearFrom = viewportTop;
        clearTo = state.absoluteCursorLine;
      } else if (mode === 2) {
        clearFrom = viewportTop;
        clearTo = viewportBottom;
      } else if (mode === 3) {
        clearFrom = 0;
        clearTo = Math.max(-1, state.baseY - 1);
      } else {
        return;
      }
      if (clearTo < clearFrom) return;
      for (let line = clearFrom; line <= clearTo; line += 1) {
        state.lineText.delete(line);
      }
      for (const marker of liveMarkers) {
        if (marker.isDisposed || marker.attachedScreen !== screen) continue;
        if (marker.line >= clearFrom && marker.line <= clearTo) {
          marker.dispose();
        }
      }
    }
  };
  const unicodeService = {
    wcwidth(codePoint: number) {
      if (this !== unicodeService) {
        throw new Error("wcwidth must be called with its unicode service receiver");
      }
      return cellWidth(String.fromCodePoint(codePoint));
    },
  };
  // Approximate xterm: dual buffers (normal + alternate). Active switches on
  // 1049h/l; buffer.normal always exposes the saved normal-buffer cursor so
  // stamp placement can restore correctly when a write starts already on alt.
  const maxBufferLines = Number.isFinite(scrollback) && scrollback !== undefined && scrollback >= 0
    ? scrollback + rows
    : Number.POSITIVE_INFINITY;
  type BufferState = {
    absoluteCursorLine: number;
    baseY: number;
    column: number;
    lineText: Map<number, string>;
  };
  const normalState: BufferState = {
    absoluteCursorLine: 0,
    baseY: 0,
    column: 0,
    lineText: new Map(),
  };
  const altState: BufferState = {
    absoluteCursorLine: 0,
    baseY: 0,
    column: 0,
    lineText: new Map(),
  };
  let screen: "normal" | "alternate" = "normal";
  const currentState = (): BufferState => (screen === "alternate" ? altState : normalState);
  const scrollRegionUp = (state: BufferState, count: number): void => {
    const regionTop = state.baseY + scrollTop;
    const regionBottom = state.baseY + scrollBottom;
    if (regionBottom < regionTop || count <= 0) return;
    const nextText = new Map<number, string>();
    for (const [key, value] of state.lineText) {
      if (key >= regionTop && key < regionTop + count) continue;
      if (key >= regionTop + count && key <= regionBottom) {
        nextText.set(key - count, value);
        continue;
      }
      if (key < regionTop || key > regionBottom) nextText.set(key, value);
    }
    state.lineText = nextText;
    for (const marker of liveMarkers) {
      if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
      if (marker.line >= regionTop && marker.line < regionTop + count) {
        marker.dispose();
        continue;
      }
      if (marker.line >= regionTop + count && marker.line <= regionBottom) {
        marker.line -= count;
      }
    }
  };
  const scrollRegionDown = (state: BufferState, count: number): void => {
    const regionTop = state.baseY + scrollTop;
    const regionBottom = state.baseY + scrollBottom;
    if (regionBottom < regionTop || count <= 0) return;
    const nextText = new Map<number, string>();
    for (const [key, value] of state.lineText) {
      if (key > regionBottom - count && key <= regionBottom) continue;
      if (key >= regionTop && key <= regionBottom - count) {
        nextText.set(key + count, value);
        continue;
      }
      if (key < regionTop || key > regionBottom) nextText.set(key, value);
    }
    state.lineText = nextText;
    for (const marker of liveMarkers) {
      if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
      if (marker.line > regionBottom - count && marker.line <= regionBottom) {
        marker.dispose();
        continue;
      }
      if (marker.line >= regionTop && marker.line <= regionBottom - count) {
        marker.line += count;
      }
    }
  };
  /** IND / NEL / RI — mirror xterm index / nextLine / reverseIndex. */
  const applyIndexControl = (kind: "ind" | "nel" | "ri"): void => {
    const state = currentState();
    if (kind === "nel") state.column = 0;
    const relativeY = state.absoluteCursorLine - state.baseY;
    if (kind === "ri") {
      if (relativeY <= scrollTop) {
        if (screen === "normal") scrollRegionDown(state, 1);
      } else {
        state.absoluteCursorLine -= 1;
        cursorLine = state.absoluteCursorLine;
      }
      return;
    }
    const partialRegion = scrollTop > 0 || scrollBottom < rows - 1;
    // Partial DECSTBM at bottom: in-place splice (like LF), no circular trim.
    if (screen === "normal" && partialRegion && relativeY >= scrollBottom) {
      scrollRegionUp(state, 1);
      return;
    }
    // Full-region bottom (or mid-viewport): advance; trim handles circular scroll.
    if (relativeY >= scrollBottom || relativeY < rows - 1) {
      state.absoluteCursorLine += 1;
      cursorLine = state.absoluteCursorLine;
      trimScrollbackIfNeeded(state);
    }
  };
  /** When null, viewport follows bottom (baseY). Tests may pin a scroll-up offset. */
  let viewportYOverride: number | null = null;

  // When not yet full, length grows with content but never below viewport.
  // When full, length stays at maxBufferLines and baseY tracks the trim offset.
  // circularTrim uses growing absolute line ids (like the default fake) but
  // reports an unclamped length so rebase does not discard cursor-adjacent
  // bare stamps the way real xterm's 0..length-1 indices would not.
  // Cursor movement must not shrink length below retained content — real xterm
  // keeps buffer extent when the cursor moves up inside the viewport.
  const contentExtent = (state: BufferState): number => {
    let maxLine = state.absoluteCursorLine;
    for (const key of state.lineText.keys()) {
      if (key > maxLine) maxLine = key;
    }
    return maxLine + 1;
  };
  const resolveLength = (state: BufferState): number => {
    if (!Number.isFinite(maxBufferLines)) {
      return Math.max(rows, contentExtent(state));
    }
    if (circularTrim) {
      return Math.max(rows, contentExtent(state));
    }
    return Math.min(
      maxBufferLines,
      Math.max(rows, contentExtent(state) - state.baseY),
    );
  };

  const trimScrollbackIfNeeded = (state: BufferState) => {
    if (!Number.isFinite(maxBufferLines)) return;
    while (state.absoluteCursorLine - state.baseY + 1 > maxBufferLines) {
      const maxBaseY = Math.max(0, maxBufferLines - rows);
      // Real xterm: grow ybase until the buffer is full, then recycle in place
      // (constant baseY) and shift markers down.
      if (circularTrim && state.baseY >= maxBaseY) {
        state.absoluteCursorLine -= 1;
        if (screen === "normal") {
          for (const marker of liveMarkers) {
            if (marker.isDisposed) continue;
            marker.line -= 1;
            if (marker.line < 0) marker.dispose();
          }
          const nextText = new Map<number, string>();
          for (const [key, value] of state.lineText) {
            const nextKey = key - 1;
            if (nextKey < 0) continue;
            nextText.set(nextKey, value);
          }
          state.lineText = nextText;
        }
        continue;
      }
      state.baseY += 1;
      if (screen !== "normal") continue;
      const keepFromAbsolute = state.baseY;
      for (const marker of liveMarkers) {
        if (!marker.isDisposed && marker.line < keepFromAbsolute) {
          marker.dispose();
        }
      }
      for (const key of [...state.lineText.keys()]) {
        if (key < keepFromAbsolute) state.lineText.delete(key);
      }
    }
  };

  // buffer.normal: always the primary buffer (xterm keeps this while alt is active).
  const normalBuffer = {
    type: "normal" as const,
    get viewportY() {
      return viewportYOverride ?? normalState.baseY;
    },
    get baseY() {
      return normalState.baseY;
    },
    get cursorY() {
      return Math.max(0, normalState.absoluteCursorLine - normalState.baseY);
    },
    get cursorX() {
      return normalState.column;
    },
    get length() {
      return resolveLength(normalState);
    },
    getLine: (line?: number) => {
      const absolute = typeof line === "number" ? line : normalState.absoluteCursorLine;
      const text = normalState.lineText.get(absolute) ?? "";
      return {
        isWrapped: false,
        translateToString: (_trimRight?: boolean) => text,
      };
    },
  };

  // active.type must reflect the current screen for alt-screen gates.
  const activeBuffer = {
    get type() {
      return screen;
    },
    set type(value: string) {
      screen = value === "alternate" ? "alternate" : "normal";
    },
    get viewportY() {
      return viewportYOverride ?? currentState().baseY;
    },
    set viewportY(value: number) {
      viewportYOverride = Math.max(0, value);
    },
    get baseY() {
      return currentState().baseY;
    },
    set baseY(value: number) {
      currentState().baseY = Math.max(0, value);
    },
    get cursorY() {
      const state = currentState();
      return Math.max(0, state.absoluteCursorLine - state.baseY);
    },
    set cursorY(value: number) {
      const state = currentState();
      state.absoluteCursorLine = state.baseY + Math.max(0, value);
      cursorLine = state.absoluteCursorLine;
    },
    get cursorX() {
      return currentState().column;
    },
    set cursorX(value: number) {
      currentState().column = Math.max(0, value);
    },
    get length() {
      return resolveLength(currentState());
    },
    getLine: (line?: number) => {
      const state = currentState();
      const absolute = typeof line === "number" ? line : state.absoluteCursorLine;
      const text = state.lineText.get(absolute) ?? "";
      return {
        isWrapped: false,
        translateToString: (_trimRight?: boolean) => text,
      };
    },
  };

  const enterAlternate = () => {
    if (screen === "alternate") return;
    // Save normal cursor (already in normalState); reset alt surface.
    altState.absoluteCursorLine = 0;
    altState.baseY = 0;
    altState.column = 0;
    altState.lineText.clear();
    screen = "alternate";
    cursorLine = 0;
  };

  const leaveAlternate = () => {
    if (screen !== "alternate") return;
    // Real xterm clears the alt buffer on leave; its markers are disposed.
    for (const marker of liveMarkers) {
      if (!marker.isDisposed && marker.attachedScreen === "alternate") {
        marker.dispose();
      }
    }
    screen = "normal";
    cursorLine = normalState.absoluteCursorLine;
  };

  const resetBuffer = () => {
    // Mirror CoreBrowserTerminal.reset / BufferService.reset: dispose live
    // markers with the old buffer and return to a blank normal-screen viewport.
    // Bare ledger stamps must not survive via numeric lines that still fit rows.
    for (const marker of [...liveMarkers]) {
      if (!marker.isDisposed) marker.dispose();
    }
    normalState.absoluteCursorLine = 0;
    normalState.baseY = 0;
    normalState.column = 0;
    normalState.lineText.clear();
    altState.absoluteCursorLine = 0;
    altState.baseY = 0;
    altState.column = 0;
    altState.lineText.clear();
    screen = "normal";
    cursorLine = 0;
    viewportYOverride = null;
    writeParserPrefix = "";
    scrollTop = 0;
    scrollBottom = rows - 1;
  };

  const createMarkerAt = (
    line: number,
    attachedScreen: "normal" | "alternate",
  ) => {
    markerLines.push(line);
    const marker = {
      line,
      isDisposed: false,
      attachedScreen,
      dispose() {
        if (marker.isDisposed) return;
        marker.isDisposed = true;
        disposedMarkerLines.push(line);
      },
    };
    liveMarkers.push(marker);
    return marker;
  };

  const term = {
    _core: {
      unicodeService,
      // Real xterm: public Terminal.reset and RIS→onRequestReset both call here.
      reset: resetBuffer,
      buffer: {
        get scrollTop() {
          return scrollTop;
        },
        get scrollBottom() {
          return scrollBottom;
        },
      },
      buffers: {
        normal: {
          addMarker(y: number) {
            return createMarkerAt(Math.max(0, y), "normal");
          },
        },
      },
    },
    buffer: {
      active: activeBuffer,
      normal: normalBuffer,
    },
    cols,
    options: {
      ...(Number.isFinite(scrollback) ? { scrollback } : {}),
      ...(options.setWinLines ? { windowOptions: { setWinLines: true } } : {}),
    },
    get modes() {
      return { wraparoundMode };
    },
    rows,
    resize(nextCols: number, nextRows: number) {
      const prevCols = (term as { cols: number }).cols;
      (term as { cols: number }).cols = Math.max(1, nextCols);
      (term as { rows: number }).rows = Math.max(1, nextRows);
      // Crude column-reflow: shift normal-buffer content/markers so deferred
      // rematerialize-after-leave with stale bare lines would misalign.
      if (nextCols !== prevCols) {
        const nextText = new Map<number, string>();
        for (const [key, value] of normalState.lineText) {
          nextText.set(key + 1, value);
        }
        normalState.lineText = nextText;
        normalState.absoluteCursorLine += 1;
        for (const marker of liveMarkers) {
          if (marker.isDisposed || marker.attachedScreen !== "normal") continue;
          marker.line += 1;
        }
        if (screen === "normal") {
          cursorLine = normalState.absoluteCursorLine;
        }
      }
    },
    reset() {
      // Mirror public Terminal.reset → _core.reset (RIS skips this wrapper).
      term._core.reset();
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
      // Mirror xterm: retain an incomplete ESC/CSI across backend chunks so
      // split RIS / CSI L/M still execute when the final byte arrives.
      const input = writeParserPrefix ? `${writeParserPrefix}${data}` : data;
      writeParserPrefix = "";
      for (let index = 0; index < input.length; index += 1) {
        if (input[index] === "\x1b") {
          if (index === input.length - 1) {
            writeParserPrefix = "\x1b";
            break;
          }
          // RIS (ESC c): mirror InputHandler → onRequestReset → _core.reset mid-chunk.
          if (input[index + 1] === "c") {
            term._core.reset();
            index += 1;
            continue;
          }
          if (input[index + 1] === "[") {
            const sequence = readCsiSequence(input, index);
            if (!sequence) {
              writeParserPrefix = input.slice(index);
              break;
            }
            if (
              sequence.sequence === "\x1b[?1049h"
              || sequence.sequence === "\x1b[?47h"
              || sequence.sequence === "\x1b[?1047h"
            ) {
              enterAlternate();
              index = sequence.endIndex;
              continue;
            }
            if (
              sequence.sequence === "\x1b[?1049l"
              || sequence.sequence === "\x1b[?47l"
              || sequence.sequence === "\x1b[?1047l"
            ) {
              leaveAlternate();
              index = sequence.endIndex;
              continue;
            }
            // DECCOLM only resets when setWinLines is enabled (xterm behavior).
            if (
              (sequence.sequence === "\x1b[?3h" || sequence.sequence === "\x1b[?3l")
              && options.setWinLines
            ) {
              term._core.reset();
              index = sequence.endIndex;
              continue;
            }
            applyCsiSequence(sequence.sequence);
            currentState().absoluteCursorLine = cursorLine;
            index = sequence.endIndex;
            continue;
          }
          // ESC D / E / M — Index / Next Line / Reverse Index.
          const escFinal = input[index + 1];
          if (escFinal === "D" || escFinal === "E" || escFinal === "M") {
            applyIndexControl(escFinal === "D" ? "ind" : escFinal === "E" ? "nel" : "ri");
            index += 1;
            continue;
          }
        }
        const state = currentState();
        const char = input[index];
        // C1 IND / NEL / RI (same actions as ESC D / E / M).
        if (char === "\x84" || char === "\x85" || char === "\x8d") {
          applyIndexControl(char === "\x84" ? "ind" : char === "\x85" ? "nel" : "ri");
          continue;
        }
        if (char === "\n") {
          const relativeY = state.absoluteCursorLine - state.baseY;
          const partialRegion = scrollTop > 0 || scrollBottom < rows - 1;
          // Inside a DECSTBM region, LF at the bottom splices rows in-place
          // (like CSI S) instead of advancing into scrollback history.
          if (
            screen === "normal"
            && partialRegion
            && relativeY >= scrollBottom
          ) {
            scrollRegionUp(state, 1);
            state.column = Number.isFinite(cols) && state.column >= cols
              ? cols - 1
              : 0;
          } else {
            state.absoluteCursorLine += 1;
            cursorLine = state.absoluteCursorLine;
            state.column = Number.isFinite(cols) && state.column >= cols
              ? cols - 1
              : 0;
            trimScrollbackIfNeeded(state);
          }
        } else if (char === "\r") {
          state.column = 0;
        } else if (char === "\b") {
          state.column = Math.max(0, state.column - 1);
        } else if (char === "\t") {
          if (state.column < cols) {
            const nextTabStop = state.column + (8 - (state.column % 8));
            state.column = Math.min(nextTabStop, cols - 1);
          }
        } else if (isCombiningMark(char)) {
          continue;
        } else if (char < " " || char === "\u007f") {
          continue;
        } else {
          const code = input.codePointAt(index);
          const isEmojiVariationSequence = code === 0x2764 && input.codePointAt(index + 1) === 0xfe0f;
          const width = isEmojiVariationSequence ? 2 : cellWidth(char);
          if (isEmojiVariationSequence) {
            index += 1;
          }
          if (wraparoundMode && state.column + width > cols) {
            state.absoluteCursorLine += 1;
            cursorLine = state.absoluteCursorLine;
            state.column = 0;
            trimScrollbackIfNeeded(state);
          }
          const existing = state.lineText.get(state.absoluteCursorLine) ?? "";
          state.lineText.set(
            state.absoluteCursorLine,
            existing + (isEmojiVariationSequence ? "❤️" : char),
          );
          state.column = Number.isFinite(cols)
            ? Math.min(cols, state.column + width)
            : state.column + width;
        }
      }
      cursorLine = currentState().absoluteCursorLine;
      trimScrollbackIfNeeded(currentState());
      callback?.();
    },
    registerMarker(offset: number) {
      // Markers attach to the active buffer (normal or alt), matching xterm.
      const state = currentState();
      const line = state.absoluteCursorLine + offset;
      return createMarkerAt(line, screen);
    },
  };

  return {
    term,
    writes,
    markerLines,
    disposedMarkerLines,
    liveMarkers,
    /** Test helper: inspect / force xterm-like baseY growth on the normal buffer. */
    getBaseY: () => normalState.baseY,
    setBaseY: (value: number) => {
      normalState.baseY = Math.max(0, value);
    },
    setViewportY: (value: number) => {
      viewportYOverride = Math.max(0, value);
    },
    getAbsoluteCursorLine: () => currentState().absoluteCursorLine,
    /** Force already-on-alt with a saved normal cursor (skeptic multi-write path). */
    enterAlternateWithSavedNormal: (savedNormalLine: number, savedNormalColumn = 0) => {
      normalState.absoluteCursorLine = Math.max(0, savedNormalLine);
      normalState.column = Math.max(0, savedNormalColumn);
      normalState.lineText.set(normalState.absoluteCursorLine, "shell-prompt");
      enterAlternate();
      // Simulate a tall TUI: alt cursor deep in the alternate buffer.
      altState.absoluteCursorLine = 40;
      altState.column = 0;
      cursorLine = 40;
    },
    getNormalAbsoluteLine: () => normalState.absoluteCursorLine,
  };
};

test("segments terminal output into raw bytes plus timestamp markers", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("hello\r\nnext"), [
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "hello\r\n" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "next" },
  ]);
});

test("does not create timestamp markers for alternate screen output", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b[?1049hvim\r\ntext"), [
    { kind: "data", data: "\x1b[?1049hvim\r\ntext" },
  ]);
  assert.deepEqual(segmenter.append("\x1b[?1049lprompt"), [
    { kind: "data", data: "\x1b[?1049l" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "prompt" },
  ]);
});

test("preserves OSC prompt prefixes terminated by C1 string terminator", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b]0;server\u009calice@server:~$ "), [
    { kind: "data", data: "\x1b]0;server\u009c" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "alice@server:~$ " },
  ]);
});

test("preserves split OSC prompt prefixes terminated by C1 string terminator", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 9, 8, 7),
  });

  assert.deepEqual(segmenter.append("\x1b]7;file://server/home/alice"), []);
  assert.deepEqual(segmenter.append("\u009calice@server:~$ "), [
    { kind: "data", data: "\x1b]7;file://server/home/alice\u009c" },
    { kind: "timestamp", label: "09:08:07" },
    { kind: "data", data: "alice@server:~$ " },
  ]);
});

test("resolves visible timestamp rows from marker lines", () => {
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 10,
      rows: 4,
      entries: [
        { marker: { line: 9 }, label: "before" },
        { marker: { line: 10 }, label: "10:00:00" },
        { marker: { line: 12 }, label: "10:00:02" },
        { marker: { line: 14 }, label: "after" },
      ],
    }),
    [
      { row: 0, label: "10:00:00" },
      { row: 2, label: "10:00:02" },
    ],
  );
});

test("resolves timestamp rows for wrapped continuations", () => {
  assert.deepEqual(
    resolveTerminalTimestampGutterRows({
      viewportY: 11,
      rows: 4,
      entries: [
        { marker: { line: 10 }, label: "10:00:10" },
        { marker: { line: 13 }, label: "10:00:13" },
      ],
      isWrappedLine: (line) => line === 11 || line === 12,
    }),
    [
      { row: 0, label: "10:00:10" },
      { row: 1, label: "10:00:10" },
      { row: 2, label: "10:00:13" },
    ],
  );
});

test("formats timestamp labels without terminal escape codes", () => {
  assert.equal(formatTerminalLineTimestamp(new Date(2026, 5, 6, 1, 2, 3)), "01:02:03");
});


test("gutter off records a per-second ledger with a sparse reflow anchor", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const t0 = new Date(2026, 5, 6, 12, 0, 0);
  writeTerminalDataWithLineTimestamps(term as never, "before\r\nnext\r\nthird", () => {}, {
    enabled: false,
    timestampDate: t0,
  });

  assert.equal(writes.join(""), "before\r\nnext\r\nthird");
  // One wall-clock second → one sparse anchor (not per-line markers).
  assert.equal(markerLines.length, 1);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
});

test("ledger keeps one stamp per wall-clock second whether gutter is on or off", () => {
  const { term, markerLines } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\n", () => {}, {
    enabled: true,
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "c\r\nd\r\n", () => {}, {
    enabled: false,
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  // Sparse anchors only: one registerMarker per stamped second.
  assert.equal(markerLines.length, 2);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
});

test("gutter paint fills blank rows with the previous stamp time", () => {
  const { term } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "a\r\nb\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "c\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  const rows = getVisibleTerminalLineTimestampRows(term as never);
  // line0 stamp 12:00:00 fills line1; line2 stamp 12:00:01.
  assert.deepEqual(
    rows.filter((row) => row.row <= 2).map((row) => ({ row: row.row, label: row.label })),
    [
      { row: 0, label: "12:00:00" },
      { row: 1, label: "12:00:00" },
      { row: 2, label: "12:00:01" },
    ],
  );
});

test("ledger notifies listeners once when a new second is stamped", () => {
  const { term } = createFakeTerm();
  let notifications = 0;
  const unsubscribe = onTerminalLineTimestampsChange(term as never, () => {
    notifications += 1;
  });

  writeTerminalDataWithLineTimestamps(term as never, "one\r\ntwo\r\nthree", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, " continued", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "\r\nnext-second\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  unsubscribe();

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
  assert.equal(notifications, 2);
});

test("large multi-line dump in one second still uses a single ledger stamp", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n");

  writeTerminalDataWithLineTimestamps(term as never, lines, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.deepEqual(writes, [lines]);
  assert.equal(markerLines.length, 1);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
});

test("soft-wrapped long line places the next-second stamp after visual rows", () => {
  // cols=10: "abcdefghij" is one full row; "klmnopqrst" wraps to a second row, then \n.
  const { term, liveMarkers } = createFakeTerm({ cols: 10, rows: 24 });
  writeTerminalDataWithLineTimestamps(term as never, `${"x".repeat(25)}\r\n`, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "next\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
  // 25 chars @ width 10 → rows 0,1,2 for first logical line; "next" on line 3.
  // Second stamp must not share line 0 with the first (hard-\n-only bug).
  const lines = liveMarkers.map((marker) => marker.line).sort((a, b) => a - b);
  assert.equal(lines[0], 0);
  assert.ok(
    lines[1]! >= 3,
    `expected second stamp at or after line 3 after soft-wrap, got ${JSON.stringify(lines)}`,
  );

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.some((row) => row.label === "12:00:00"));
  assert.ok(painted.some((row) => row.label === "12:00:01"));
});

test("reflow updates painted rows from sparse anchor marker.line", () => {
  const { term, liveMarkers } = createFakeTerm({ cols: 80, rows: 24, scrollback: 1000 });
  writeTerminalDataWithLineTimestamps(term as never, "early\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "late\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  assert.equal(liveMarkers.length, 2);

  // Simulate xterm reflow: markers move to new absolute lines.
  liveMarkers[0]!.line = 5;
  liveMarkers[1]!.line = 12;

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const byRow = new Map(painted.map((row) => [row.row, row.label]));
  // viewportY=0 → buffer line === row for these anchors.
  assert.equal(byRow.get(5), "12:00:00");
  assert.equal(byRow.get(12), "12:00:01");
  // Fill-forward between anchors.
  assert.equal(byRow.get(8), "12:00:00");
});

test("does not withhold output when an OSC sequence is split across chunks", () => {
  const { term, writes } = createFakeTerm();
  const callbacks: string[] = [];

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b]7;file://server/home/alice",
    () => callbacks.push("first"),
  );
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\u009calice@server:~$ ",
    () => callbacks.push("second"),
  );

  assert.deepEqual(callbacks, ["first", "second"]);
  assert.ok(writes.join("").includes("alice@server:~$ "));
});

test("drops an oversized unterminated control prefix and resumes timestamp parsing", () => {
  const segmenter = createTerminalLineTimestampSegmenter({
    now: () => new Date(2026, 5, 6, 12, 0, 0),
  });
  const malformed = `\x1b[?1049${"9".repeat(MAX_INCOMPLETE_TERMINAL_CONTROL_SEQUENCE_CHARS)}`;

  const overflow = segmenter.append(malformed);
  assert.equal(segmenter.flushPendingEscapeSequence(), "");
  assert.equal(
    overflow.filter((segment) => segment.kind === "data").reduce((sum, segment) => sum + segment.data.length, 0),
    malformed.length,
  );

  const recovered = segmenter.append("ready\r\n");
  assert.equal(recovered.some((segment) => segment.kind === "timestamp"), true);
  assert.equal(recovered.some((segment) => segment.kind === "data" && segment.data.includes("ready")), true);
});

test("does not timestamp output suspended on the alternate screen", () => {
  const { term } = createFakeTerm();
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049hvim screen", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 0);
});

test("records a ledger stamp after leaving alternate screen", () => {
  const { term } = createFakeTerm();
  // Start as if already on alt screen via segmenter enter then leave in data
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[?1049hframe\x1b[?1049lprompt line\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) >= 1);
});

test("applyAltScreenAction never rewinds normal-buffer line or column", () => {
  // Pure truth table: enter/leave × altActive; line/col immutable.
  const base: StampCursorEstimate = {
    absoluteLine: 7,
    column: 3,
    wraparoundMode: true,
    altActive: false,
  };
  const cases: Array<{
    name: string;
    start: StampCursorEstimate;
    action: "enter" | "leave";
    expectAlt: boolean;
  }> = [
    {
      name: "enter while normal",
      start: { ...base, altActive: false },
      action: "enter",
      expectAlt: true,
    },
    {
      name: "enter while already alt",
      start: { ...base, altActive: true },
      action: "enter",
      expectAlt: true,
    },
    {
      name: "leave while alt",
      start: { ...base, altActive: true },
      action: "leave",
      expectAlt: false,
    },
    {
      name: "spurious leave while already normal",
      start: { ...base, altActive: false, absoluteLine: 7, column: 3 },
      action: "leave",
      expectAlt: false,
    },
  ];
  for (const row of cases) {
    const next = applyAltScreenAction(row.start, row.action);
    assert.equal(next.absoluteLine, row.start.absoluteLine, row.name);
    assert.equal(next.column, row.start.column, row.name);
    assert.equal(next.wraparoundMode, row.start.wraparoundMode, row.name);
    assert.equal(next.altActive, row.expectAlt, row.name);
  }
  // enter then leave preserves line/col from mid-walk freeze point.
  const afterEnter = applyAltScreenAction({ ...base, absoluteLine: 1 }, "enter");
  const afterLeave = applyAltScreenAction(afterEnter, "leave");
  assert.equal(afterLeave.absoluteLine, 1);
  assert.equal(afterLeave.altActive, false);
});

// --- Three write-path integrations for alt/seed/leave (shipped entry) ---

test("alt-screen newlines do not inflate post-exit stamp anchor lines", () => {
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000 });
  // Many hard newlines inside the alt screen must not push the restored
  // normal-buffer stamp down (would mis-pin sparse reflow anchors).
  const payload = `\x1b[?1049h${"frame\n".repeat(30)}\x1b[?1049lprompt\r\n`;
  writeTerminalDataWithLineTimestamps(term as never, payload, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    0,
    `expected stamp on restored normal buffer line 0, got ${liveMarkers[0]?.line}`,
  );
});

test("same-chunk normal advance before enter is kept after leave for post-TUI stamp", () => {
  // Leading hard newline advances the normal estimate to line 1 with no stamp
  // yet; enter freezes that estimate; leave must not rewind to line 0.
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000, cols: 80 });
  const payload = `\r\n\x1b[?1049h${"frame\n".repeat(20)}\x1b[?1049lprompt\r\n`;
  writeTerminalDataWithLineTimestamps(term as never, payload, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    1,
    `expected prompt stamp on advanced normal line 1, got ${liveMarkers[0]?.line}`,
  );
});

test("spurious leave without enter keeps same-chunk normal advance for prompt stamp", () => {
  // Skeptic: '\r\n\x1b[?1049lprompt\r\n' must stamp line 1, not rewind to 0.
  const { term, liveMarkers } = createFakeTerm({ rows: 24, scrollback: 1000, cols: 80 });
  writeTerminalDataWithLineTimestamps(
    term as never,
    "\r\n\x1b[?1049lprompt\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);
  assert.equal(liveMarkers.length, 1);
  assert.equal(
    liveMarkers[0]?.line,
    1,
    `expected stamp on line 1 after leading \\n + spurious leave, got ${liveMarkers[0]?.line}`,
  );
});

test("already-on-alt leave stamps on saved normal line not deep alt cursor", () => {
  const fake = createFakeTerm({ rows: 24, scrollback: 1000 });
  const { term, liveMarkers, disposedMarkerLines } = fake;

  // Normal-buffer banner first (saves a real primary-buffer line).
  writeTerminalDataWithLineTimestamps(term as never, "banner\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  const savedNormalLine = fake.getNormalAbsoluteLine();
  assert.ok(savedNormalLine >= 1);

  // Simulate a multi-write TUI session: already on alt with a deep alt cursor
  // while buffer.normal still holds the shell line.
  fake.enterAlternateWithSavedNormal(savedNormalLine, 0);
  assert.equal((term.buffer.active as { type: string }).type, "alternate");
  assert.equal(fake.getAbsoluteCursorLine(), 40);

  // Alt-only output must not add stamps (segmenter suspended).
  writeTerminalDataWithLineTimestamps(term as never, `${"frame\n".repeat(15)}`, () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 1),
  });
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);

  // Leave alt + shell prompt — stamp must pin to saved normal line, not alt 40+.
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049lprompt\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 2),
  });

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    2,
    "post-TUI stamp must remain in the ledger (not dropped as past bufferLength)",
  );
  const live = liveMarkers.filter((marker) => !marker.isDisposed);
  assert.ok(live.length >= 2);
  const promptAnchor = live[live.length - 1]!;
  assert.ok(
    promptAnchor.line < 20,
    `expected normal-buffer stamp, got alt-depth line ${promptAnchor.line}`,
  );
  assert.ok(
    promptAnchor.line >= savedNormalLine - 1 && promptAnchor.line <= savedNormalLine + 2,
    `expected stamp near saved normal line ${savedNormalLine}, got ${promptAnchor.line}`,
  );
  // The deep-alt mis-pin (line ~40) must not be the surviving prompt anchor.
  assert.equal(disposedMarkerLines.includes(40), false);
  assert.notEqual(promptAnchor.line, 40);
});

test("resolveTerminalTimestampGutterRowsFromLedger fills gaps with previous time", () => {
  const rows = resolveTerminalTimestampGutterRowsFromLedger({
    viewportY: 0,
    rows: 5,
    ledger: [
      { label: "12:00:00", secondKey: 1, line: 0 },
      { label: "12:00:01", secondKey: 2, line: 3 },
    ],
  });
  assert.deepEqual(rows, [
    { row: 0, label: "12:00:00" },
    { row: 1, label: "12:00:00" },
    { row: 2, label: "12:00:00" },
    { row: 3, label: "12:00:01" },
    { row: 4, label: "12:00:01" },
  ]);
});

test("resolveTerminalTimestampGutterRowsFromLedger does not paint past lastPaintLine", () => {
  // Viewport is 10 rows but content only reaches line 2 — empty rows stay blank.
  const rows = resolveTerminalTimestampGutterRowsFromLedger({
    viewportY: 0,
    rows: 10,
    lastPaintLine: 2,
    ledger: [
      { label: "12:00:00", secondKey: 1, line: 0 },
    ],
  });
  assert.deepEqual(rows, [
    { row: 0, label: "12:00:00" },
    { row: 1, label: "12:00:00" },
    { row: 2, label: "12:00:00" },
  ]);
});

test("gutter paint does not fill empty viewport rows past real content", () => {
  // Fake buffer length is always >= rows (like xterm), even with few content lines.
  const { term } = createFakeTerm({ rows: 24 });
  writeTerminalDataWithLineTimestamps(term as never, "motd\r\nlogin\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  // "motd\nlogin\n" → content on lines 0-1; cursor sits empty on line 2.
  assert.ok(painted.length > 0);
  assert.ok(
    painted.every((row) => row.row <= 1),
    `expected paint only on content rows, got rows: ${painted.map((r) => r.row).join(",")}`,
  );
  assert.equal(painted.at(-1)?.row, 1);
});

test("baseY growth while buffer is still growing does not drop early ledger stamps", () => {
  // Large scrollback so a short session is not yet "full"; baseY may still rise
  // as the viewport follows the cursor. Old logic rebased on every baseY delta
  // and wiped MOTD stamps even though nothing was trimmed.
  const fake = createFakeTerm({ rows: 10, scrollback: 1000 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(term as never, "banner-line\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 0),
  });
  writeTerminalDataWithLineTimestamps(term as never, "later-line\r\n", () => {}, {
    timestampDate: new Date(2026, 5, 6, 12, 0, 5),
  });

  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);

  // Simulate mistaken "baseY follows cursor" growth while buffer not full.
  fake.setBaseY(2);
  // Scroll back to the top so paint includes the original banner line.
  fake.setViewportY(0);

  const painted = getVisibleTerminalLineTimestampRows(term as never);
  // Early stamp must still fill-forward (not discarded by rebase).
  assert.ok(
    painted.some((row) => row.label === "12:00:00"),
    `expected early stamp still visible, got ${JSON.stringify(painted)}`,
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 2);
});

test("full-buffer scrollback trim rebases ledger and drops lines past the top", () => {
  const fake = createFakeTerm({ rows: 4, scrollback: 4 });
  const { term } = fake;
  // maxLines = 4 + 4 = 8. Write enough distinct seconds to stamp many lines,
  // then overflow so baseY grows while buffer is full.

  for (let second = 0; second < 12; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `line-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second) },
    );
  }

  assert.ok(fake.getBaseY() > 0, "expected scrollback trim to raise baseY");
  const ledgerCount = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerCount > 0);
  // Stamps for lines that scrolled off the top must be gone after rebase+filter.
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.length > 0);
  // Every painted label should still be a valid HH:MM:SS from our window.
  for (const row of painted) {
    assert.match(row.label, /^12:00:\d{2}$/);
  }
});

test("term.reset clears saturated bare ledger stamps", async () => {
  // Saturated mode copies marker.line onto bare ledger entries and releases
  // anchors. xterm.reset only disposes live markers; without a reset hook,
  // rebase keeps bare lines that still fit the fresh viewport and paints old
  // times onto post-reset / snapshot rows.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerBefore > 1, "expected a populated saturated ledger");

  (term as { reset: () => void }).reset();

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    0,
    "buffer reset must wipe bare ledger stamps with the disposed markers",
  );
  assert.deepEqual(
    getVisibleTerminalLineTimestampRows(term as never),
    [],
    "gutter must not paint pre-reset labels onto the cleared buffer",
  );

  writeTerminalDataWithLineTimestamps(
    term as never,
    "after-reset\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 13, 0, 0) },
  );
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.deepEqual(painted, [{ row: 0, label: "13:00:00" }]);
});

test("parser-driven _core.reset clears saturated bare ledger stamps", async () => {
  // RIS (ESC c) fires InputHandler.onRequestReset → CoreBrowserTerminal.reset,
  // which never touches the public Terminal.reset wrapper. Stamps must clear
  // via the _core.reset hook, not only direct term.reset() calls.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) > 1);

  // Simulate RIS: call core.reset without going through public term.reset.
  (term as { _core: { reset: () => void } })._core.reset();

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    0,
    "RIS/_core.reset must wipe bare ledger stamps like public term.reset",
  );
  assert.deepEqual(
    getVisibleTerminalLineTimestampRows(term as never),
    [],
    "gutter must not paint pre-RIS labels onto the cleared buffer",
  );

  writeTerminalDataWithLineTimestamps(
    term as never,
    "after-ris\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 14, 0, 0) },
  );
  assert.deepEqual(
    getVisibleTerminalLineTimestampRows(term as never),
    [{ row: 0, label: "14:00:00" }],
  );
});

test("saturated scrollback keeps ledger stamps without attaching new live markers", async () => {
  // Once the buffer is full, every new line trims scrollback and xterm updates
  // every live marker. Steady log tails must keep bare ledger lines only.
  const fake = createFakeTerm({ rows: 24, scrollback: 40 });
  const { term, liveMarkers } = fake;
  // maxLines=64; saturated when length >= 64-24=40.

  for (let second = 0; second < 30; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), false);
  assert.ok(liveMarkers.some((marker) => !marker.isDisposed));

  for (let second = 30; second < 50; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `fill-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);

  const markersBefore = liveMarkers.length;
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  writeTerminalDataWithLineTimestamps(
    term as never,
    "steady-log-line\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 1, 0) },
  );
  assert.equal(
    liveMarkers.length,
    markersBefore + 2,
    "saturated writes may re-pin trim sentinel + top probe, not per-stamp markers",
  );
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) >= ledgerBefore);

  // Existing anchors are retired on an amortized drain so trim stays cheap.
  // Cursor sentinel + line-0 probe remain so circular recycles stay visible and
  // local CSI L/M disposal can be distinguished from top-of-buffer trim.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(
    liveMarkers.filter((marker) => !marker.isDisposed).length,
    2,
    "saturated writes should release ledger markers but keep trim sentinel + top probe",
  );

  // Fake term keeps viewport at baseY=0 until trim; pin to the bottom so paint
  // covers the latest bare-line stamp.
  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(
    painted.some((row) => row.label === "12:01:00"),
    `expected saturated bare-line stamp in gutter, got ${JSON.stringify(painted)}`,
  );
});

test("circular saturated trim shifts bare ledger lines while baseY stays fixed", async () => {
  // Real xterm recycles with constant baseY/length; releasing ledger markers
  // must not freeze gutter stamps on overwritten rows (#2600 Codex P1).
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term } = fake;
  const maxBaseY = 4; // maxBufferLines(8) - rows(4)

  // Fill until ybase has reached its circular ceiling (real xterm steady state).
  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  assert.equal(fake.getBaseY(), maxBaseY);
  const baseYWhileFull = fake.getBaseY();

  for (let second = 0; second < 8; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `recycle-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 1, second) },
    );
  }
  assert.equal(
    fake.getBaseY(),
    baseYWhileFull,
    "circular recycle must not bump baseY once the buffer is full",
  );

  await new Promise((resolve) => { setTimeout(resolve, 0); });
  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.length > 0, "expected gutter rows after circular recycle");
  // Early seed stamps must have scrolled away with the recycled top lines.
  assert.equal(
    painted.some((row) => row.label === "12:00:00"),
    false,
    `stale top-of-buffer stamp should be gone, got ${JSON.stringify(painted)}`,
  );
  assert.ok(
    painted.some((row) => row.label.startsWith("12:01:")),
    `expected post-recycle stamps in gutter, got ${JSON.stringify(painted)}`,
  );
});

test("flood fill then first saturated stamp keeps gutter aligned after circular trim", async () => {
  // True-flood writes never arm the trim sentinel. The first later timestamped
  // line must pin a sentinel before write so circular recycle shifts the bare
  // stamp with the row — otherwise the gutter labels the row below.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term } = fake;

  setTerminalOutputPressureLargeOutput(term as never, true);
  for (let index = 0; index < 24; index += 1) {
    writeTerminalDataWithLineTimestamps(term as never, `flood-${index}\r\n`, () => {});
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 0);
  setTerminalOutputPressureLargeOutput(term as never, false);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "target-line\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 2, 0) },
  );

  await new Promise((resolve) => { setTimeout(resolve, 0); });
  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const stamp = painted.find((row) => row.label === "12:02:00");
  assert.ok(stamp, `expected post-flood stamp in gutter, got ${JSON.stringify(painted)}`);

  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;
  const stampedText = (
    term.buffer.active.getLine(viewportY + stamp.row) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);
  assert.equal(
    stampedText,
    "target-line",
    `gutter stamp must sit on target-line after circular trim, got ${JSON.stringify({ stampedText, painted })}`,
  );

  resetTerminalOutputPressure(term as never);
});

test("armed sentinel then flood keeps first later stamp on its row", async () => {
  // Saturated writes arm a trim sentinel. True-flood then moves/disposes it
  // without ledger sync; the first later stamp must rebase that stale
  // sentinel *before* recording, or the flood-era delta lands on the new entry.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) > 0);

  setTerminalOutputPressureLargeOutput(term as never, true);
  for (let index = 0; index < 16; index += 1) {
    writeTerminalDataWithLineTimestamps(term as never, `flood-${index}\r\n`, () => {});
  }
  setTerminalOutputPressureLargeOutput(term as never, false);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "target-line\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 3, 0) },
  );

  await new Promise((resolve) => { setTimeout(resolve, 0); });
  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const stamp = painted.find((row) => row.label === "12:03:00");
  assert.ok(stamp, `expected post-flood stamp in gutter, got ${JSON.stringify(painted)}`);

  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;
  const stampedText = (
    term.buffer.active.getLine(viewportY + stamp.row) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);
  assert.equal(
    stampedText,
    "target-line",
    `gutter stamp must sit on target-line after stale-sentinel flood, got ${JSON.stringify({ stampedText, painted })}`,
  );

  resetTerminalOutputPressure(term as never);
});

test("local CSI-style sentinel disposal does not wipe saturated ledger", async () => {
  // Cursor-pinned sentinel disposal from CSI M/L must not be treated as a
  // circular top-trim of trimSentinelLine+1 rows (that zeroes the ledger).
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term, liveMarkers } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerBefore > 1, "expected a populated saturated ledger");

  const live = liveMarkers.filter((marker) => !marker.isDisposed);
  assert.equal(live.length, 2, "expected cursor sentinel and top probe");
  const topProbe = live.find((marker) => marker.line === 0);
  const cursorSentinel = live.find((marker) => marker.line > 0);
  assert.ok(topProbe, "expected absolute line-0 trim probe");
  assert.ok(cursorSentinel, "expected cursor-pinned trim sentinel");

  // Simulate CSI M at the bottom: dispose only the cursor-pinned sentinel.
  cursorSentinel!.dispose();
  assert.equal(topProbe!.isDisposed, false);
  assert.equal(topProbe!.line, 0);

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  getVisibleTerminalLineTimestampRows(term as never);

  const ledgerAfter = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(
    ledgerAfter >= ledgerBefore - 1,
    `local sentinel disposal must not erase timestamp history (${ledgerBefore} → ${ledgerAfter})`,
  );
});

test("local CSI-style sentinel move does not shift saturated bare ledger", async () => {
  // CSI M above the cursor decreases the cursor-pinned sentinel without
  // disposing it. A surviving line-0 probe means local edit — do not apply
  // that movement as a circular-trim delta to every bare ledger entry.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true });
  const { term, liveMarkers } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const paintedBefore = getVisibleTerminalLineTimestampRows(term as never);
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(paintedBefore.length > 0, "expected gutter rows before local edit");
  assert.ok(ledgerBefore > 1, "expected a populated saturated ledger");

  const live = liveMarkers.filter((marker) => !marker.isDisposed);
  const topProbe = live.find((marker) => marker.line === 0);
  const cursorSentinel = live.find((marker) => marker.line > 0);
  assert.ok(topProbe, "expected absolute line-0 trim probe");
  assert.ok(cursorSentinel, "expected cursor-pinned trim sentinel");

  const sentinelBefore = cursorSentinel!.line;
  // Simulate CSI M above the cursor: sentinel moves up; top probe stays at 0.
  cursorSentinel!.line = Math.max(1, sentinelBefore - 2);
  assert.equal(topProbe!.isDisposed, false);
  assert.equal(topProbe!.line, 0);
  assert.ok(cursorSentinel!.line < sentinelBefore, "expected sentinel to move up");

  const paintedAfter = getVisibleTerminalLineTimestampRows(term as never);
  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    ledgerBefore,
    "local sentinel move must not erase or invent ledger entries",
  );
  assert.deepEqual(
    paintedAfter,
    paintedBefore,
    `local sentinel move must not slide gutter labels onto preceding rows, before=${JSON.stringify(paintedBefore)} after=${JSON.stringify(paintedAfter)}`,
  );
});

test("resize after flood rebases stale sentinel before rematerialize", async () => {
  // Flood moves the armed sentinel without syncing bare ledger offsets. The
  // term.resize hook must rebase from that sentinel before rematerializing,
  // or anchors pin to stale lines and survive column reflow on the wrong rows.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) > 0);

  // Install resize hook via paint, then flood without another paint/write sync.
  getVisibleTerminalLineTimestampRows(term as never);
  setTerminalOutputPressureLargeOutput(term as never, true);
  for (let index = 0; index < 4; index += 1) {
    writeTerminalDataWithLineTimestamps(term as never, `flood-${index}\r\n`, () => {});
  }
  setTerminalOutputPressureLargeOutput(term as never, false);

  assert.equal(typeof (term as { resize?: unknown }).resize, "function");
  (term as { resize: (cols: number, rows: number) => void }).resize(40, term.rows);

  // Flood recycled the bottom; scroll to the top where seed rows remain.
  fake.setViewportY(0);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(painted.length > 0, `expected gutter rows after flood+resize, got ${JSON.stringify(painted)}`);

  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;
  let alignedSeed = false;
  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `seed stamp must stay on its row after flood+resize, got ${JSON.stringify({ text, row, painted })}`,
    );
    alignedSeed = true;
  }
  assert.ok(alignedSeed, `expected at least one surviving seed row after flood+resize, got ${JSON.stringify(painted)}`);

  resetTerminalOutputPressure(term as never);
});

test("column resize after saturation keeps rematerialized gutter history", async () => {
  // Saturated mode releases ledger markers. Rematerialize before cols change so
  // reflow can move anchors; otherwise colsChanged drops every bare stamp.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term, liveMarkers } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerBefore > 1, "expected a populated saturated ledger");
  assert.equal(
    liveMarkers.filter((marker) => !marker.isDisposed).length,
    2,
    "expected only trim sentinel + top probe while saturated",
  );

  // Resize rematerializes bare ledger anchors, then simulates reflow moves.
  const attached = materializeTimestampLedgerToMarkers(term as never);
  assert.ok(attached >= ledgerBefore - 2, `expected rematerialized anchors, got ${attached}`);
  (term as { cols: number }).cols = 40;
  for (const marker of liveMarkers) {
    if (marker.isDisposed) continue;
    // Soft-wrap reflow typically shifts absolute lines; keep them in range.
    marker.line = Math.max(0, marker.line);
  }

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) > 0,
    "column reflow must not drop the entire saturated ledger",
  );
  assert.ok(painted.length > 0, `expected gutter rows after column resize, got ${JSON.stringify(painted)}`);
});

test("term.resize hook rematerializes saturated ledger before column reflow", async () => {
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerBefore > 1);

  // Force store creation + resize hook via a paint, then resize columns.
  getVisibleTerminalLineTimestampRows(term as never);
  assert.equal(typeof (term as { resize?: unknown }).resize, "function");
  (term as { resize: (cols: number, rows: number) => void }).resize(40, term.rows);

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) > 0,
    `resize hook must preserve saturated ledger (${ledgerBefore} before)`,
  );
  assert.ok(painted.length > 0, `expected gutter rows after term.resize, got ${JSON.stringify(painted)}`);
});

test("column resize on alternate screen preserves saturated normal-buffer history", async () => {
  // Saturated mode releases ledger anchors. Rematerializing while a TUI holds
  // the alternate screen would rebase against the short alt buffer and pin
  // survivors there — those markers die on leave and wipe gutter history.
  // Instead, pin onto buffer.normal before reflow so anchors ride the resize.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  assert.ok(ledgerBefore > 1, "expected a populated saturated ledger");
  assert.equal(isTerminalScrollbackSaturated(term as never), true);

  getVisibleTerminalLineTimestampRows(term as never);
  // Short alt viewport (length ≈ rows): rebase-vs-active would drop normal history.
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049h", () => {});
  assert.equal((term.buffer.active as { type: string }).type, "alternate");
  assert.ok(
    (term.buffer.active as { length: number }).length <= term.rows,
    "expected a short alternate buffer relative to normal history",
  );

  assert.equal(typeof (term as { resize?: unknown }).resize, "function");
  (term as { resize: (cols: number, rows: number) => void }).resize(40, term.rows);

  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) >= ledgerBefore - 2,
    `alt-screen column resize must not drop normal history (${ledgerBefore} before, now ${getTerminalLineTimestampLedgerCount(term as never)})`,
  );

  // Leave alt: alt-anchored markers dispose. History must still paint on the
  // post-reflow rows (fake resize shifts normal lines by +1).
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[?1049l", () => {});
  assert.equal((term.buffer.active as { type: string }).type, "normal");
  fake.setViewportY(Math.max(0, fake.getNormalAbsoluteLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) > 0,
    "normal-buffer stamps must survive alt resize + leave",
  );
  assert.ok(painted.length > 0, `expected gutter rows after alt resize, got ${JSON.stringify(painted)}`);

  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;
  let alignedSeed = false;
  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `seed stamp must stay on its post-reflow row after alt resize, got ${JSON.stringify({ text, row, painted })}`,
    );
    alignedSeed = true;
  }
  assert.ok(
    alignedSeed,
    `expected at least one aligned seed row after alt resize, got ${JSON.stringify(painted)}`,
  );
});

test("DECCOLM without setWinLines keeps gutter history", async () => {
  // xterm only full-resets on DECCOLM when windowOptions.setWinLines is true.
  // Netcatty does not enable that option, so CSI ? 3 h/l must not wipe stamps.
  const fake = createFakeTerm({ rows: 8, cols: 80 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(
    term as never,
    "keep-me\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[?3hstill-here\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 1) },
  );

  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) >= 1,
    "DECCOLM without setWinLines must not clear the timestamp ledger",
  );
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.ok(
    painted.some((row) => row.label === "12:00:00"),
    `pre-DECCOLM stamp must survive, got ${JSON.stringify(painted)}`,
  );
});

test("DECCOLM with setWinLines clears gutter history like RIS", async () => {
  const fake = createFakeTerm({ rows: 8, cols: 80, setWinLines: true });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(
    term as never,
    "before\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[?3hafter-deccolm\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 1) },
  );

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    1,
    "enabled DECCOLM clears pre-reset stamps; post-reset text keeps one stamp",
  );
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.deepEqual(
    painted,
    [{ row: 0, label: "12:00:01" }],
    `post-DECCOLM row must keep its gutter stamp, got ${JSON.stringify(painted)}`,
  );
});

test("saturated CSI M rematerializes anchors so stamps follow deleted lines", async () => {
  // Once saturated, bare ledger lines cannot track IL/DL. Rematerialize before
  // the write so xterm (and the fake) can move markers with the edit.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Move cursor to an early seed row, then delete one line (CSI M).
  const targetLine = Math.max(0, fake.getAbsoluteCursorLine() - 3);
  (term.buffer.active as { cursorY: number }).cursorY = Math.max(
    0,
    targetLine - (term.buffer.active as { baseY: number }).baseY,
  );
  const deletedText = (
    term.buffer.active.getLine(targetLine) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[1M", () => {});

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === deletedText) continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after CSI M, got ${JSON.stringify({ text, row, painted, deletedText, viewportY })}`,
    );
  }
});

test("inline RIS followed by text keeps a gutter stamp for post-reset output", async () => {
  // Segmentation + ledger insert run before term.write. Parser-driven RIS
  // clears the store mid-chunk; post-reset printable text must keep its stamp.
  const fake = createFakeTerm({ rows: 8, cols: 80 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(
    term as never,
    "before\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.ok(getTerminalLineTimestampLedgerCount(term as never) > 0);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1bcafter-ris\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 1) },
  );

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    1,
    "pre-RIS stamps clear; post-RIS text must keep exactly one stamp",
  );
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  assert.deepEqual(
    painted,
    [{ row: 0, label: "12:00:01" }],
    `post-RIS row must keep its gutter stamp, got ${JSON.stringify(painted)}`,
  );
});

test("RIS split across writes still stamps post-reset output", async () => {
  // Backend chunk ends on ESC; next chunk completes RIS. xterm retains ESC and
  // resets while processing the second write — timestamp scan must too.
  const fake = createFakeTerm({ rows: 8, cols: 80 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(
    term as never,
    "before\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );

  writeTerminalDataWithLineTimestamps(term as never, "\x1b", () => {});
  writeTerminalDataWithLineTimestamps(
    term as never,
    "cafter-ris\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 1) },
  );

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    1,
    "split RIS must clear pre-reset stamps and keep post-reset text",
  );
  assert.deepEqual(
    getVisibleTerminalLineTimestampRows(term as never),
    [{ row: 0, label: "12:00:01" }],
  );
});

test("post-reset continued line does not stamp twice across seconds", async () => {
  // In-band RIS + printable text (no newline) stamps once. A later chunk that
  // continues the same physical row in a new second must not replace the label.
  const fake = createFakeTerm({ rows: 8, cols: 80 });
  const { term } = fake;

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1bcpartial",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 0) },
  );
  assert.equal(getTerminalLineTimestampLedgerCount(term as never), 1);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "-continued\r\n",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 1) },
  );

  assert.equal(
    getTerminalLineTimestampLedgerCount(term as never),
    1,
    "continued post-reset line must keep the original line-start stamp",
  );
  assert.deepEqual(
    getVisibleTerminalLineTimestampRows(term as never),
    [{ row: 0, label: "12:00:00" }],
  );
});

test("saturated CSI M rematerializes when the sequence is split across writes", async () => {
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const targetLine = Math.max(0, fake.getAbsoluteCursorLine() - 3);
  (term.buffer.active as { cursorY: number }).cursorY = Math.max(
    0,
    targetLine - (term.buffer.active as { baseY: number }).baseY,
  );
  const deletedText = (
    term.buffer.active.getLine(targetLine) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  // Split CSI M across chunks: ESC [ then 1M.
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[", () => {});
  writeTerminalDataWithLineTimestamps(term as never, "1M", () => {});

  fake.setViewportY(Math.max(0, fake.getAbsoluteCursorLine() - (term.rows - 1)));
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === deletedText) continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `split CSI M must still rematerialize; got ${JSON.stringify({ text, row, painted, deletedText })}`,
    );
  }
});

test("saturated CSI S rematerializes anchors so stamps follow scrolled lines", async () => {
  // CSI S splices the scroll region without circular top-trim. Saturated bare
  // ledger lines must rematerialize first or gutter times stick to wrong rows.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const viewportTop = (term.buffer.active as { baseY: number }).baseY;
  const scrolledAway = (
    term.buffer.active.getLine(viewportTop) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[1S", () => {});

  fake.setViewportY(viewportTop);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === scrolledAway) continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after CSI S, got ${JSON.stringify({ text, row, painted, scrolledAway, viewportY })}`,
    );
  }
});

test("saturated DECSTBM linefeed rematerializes anchors inside the scroll region", async () => {
  // LF at the bottom of a partial DECSTBM region splices rows without trimming
  // buffer origin — same rematerialize requirement as CSI S/T.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Restrict scrolling to rows 2-4 (1-based); leave row 1 pinned.
  writeTerminalDataWithLineTimestamps(term as never, "\x1b[2;4r", () => {});
  const baseY = (term.buffer.active as { baseY: number }).baseY;
  (term.buffer.active as { cursorY: number }).cursorY = 3;
  const regionTopText = (
    term.buffer.active.getLine(baseY + 1) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\nregion-tail\r",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 40) },
  );

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === regionTopText || text === "region-tail") continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after DECSTBM LF, got ${JSON.stringify({ text, row, painted, regionTopText, viewportY })}`,
    );
  }
});

test("saturated DECSTBM+LF in one write rematerializes using in-chunk region", async () => {
  // DECSTBM and the following LF share one write. Pre-write region is still
  // full-screen; rematerialize must parse the in-chunk CSI r.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const baseY = (term.buffer.active as { baseY: number }).baseY;
  (term.buffer.active as { cursorY: number }).cursorY = 3;
  const regionTopText = (
    term.buffer.active.getLine(baseY + 1) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[2;4r\nregion-tail\r",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 40) },
  );

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === regionTopText || text === "region-tail") continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after same-write DECSTBM+LF, got ${JSON.stringify({ text, row, painted, regionTopText, viewportY })}`,
    );
  }
});

test("saturated DECSTBM IND rematerializes anchors inside the scroll region", async () => {
  // ESC D at the bottom of a partial DECSTBM region splices like LF / CSI S.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[2;4r", () => {});
  const baseY = (term.buffer.active as { baseY: number }).baseY;
  (term.buffer.active as { cursorY: number }).cursorY = 3;
  const regionTopText = (
    term.buffer.active.getLine(baseY + 1) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1bDregion-tail\r",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 40) },
  );

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === regionTopText || text === "region-tail") continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after DECSTBM IND, got ${JSON.stringify({ text, row, painted, regionTopText, viewportY })}`,
    );
  }
});

test("saturated DECSTBM+C1 IND in one write rematerializes using in-chunk region", async () => {
  // Same-chunk DECSTBM + C1 IND (\x84) must rematerialize like DECSTBM+LF.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const baseY = (term.buffer.active as { baseY: number }).baseY;
  (term.buffer.active as { cursorY: number }).cursorY = 3;
  const regionTopText = (
    term.buffer.active.getLine(baseY + 1) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(
    term as never,
    "\x1b[2;4r\x84region-tail\r",
    () => {},
    { timestampDate: new Date(2026, 5, 6, 12, 0, 40) },
  );

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === regionTopText || text === "region-tail") continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after same-write DECSTBM+C1 IND, got ${JSON.stringify({ text, row, painted, regionTopText, viewportY })}`,
    );
  }
});

test("saturated DECSTBM RI rematerializes anchors inside the scroll region", async () => {
  // ESC M at the top of a DECSTBM region splices down like CSI T — no circular trim.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[2;4r", () => {});
  const baseY = (term.buffer.active as { baseY: number }).baseY;
  (term.buffer.active as { cursorY: number }).cursorY = 1;
  const regionBottomText = (
    term.buffer.active.getLine(baseY + 3) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);

  writeTerminalDataWithLineTimestamps(term as never, "\x1bM", () => {});

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;

  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    if (!text || text === regionBottomText) continue;
    const match = /^seed-(\d+)$/.exec(text);
    if (!match) continue;
    const second = Number(match[1]) % 60;
    const expected = `12:00:${String(second).padStart(2, "0")}`;
    assert.equal(
      row.label,
      expected,
      `stamp must follow content after DECSTBM RI, got ${JSON.stringify({ text, row, painted, regionBottomText, viewportY })}`,
    );
  }
});

test("saturated CSI 2 J rematerializes anchors so erased viewport stamps drop", async () => {
  // With clearWipesScrollback disabled, CSI 2 J clears viewport rows and
  // disposes markers on those rows. Saturated bare ledger must rematerialize
  // first or stamps for erased content linger beside the blank viewport.
  const fake = createFakeTerm({ rows: 4, scrollback: 4, circularTrim: true, cols: 80 });
  const { term } = fake;

  for (let second = 0; second < 20; second += 1) {
    writeTerminalDataWithLineTimestamps(
      term as never,
      `seed-${second}\r\n`,
      () => {},
      { timestampDate: new Date(2026, 5, 6, 12, 0, second % 60) },
    );
  }
  assert.equal(isTerminalScrollbackSaturated(term as never), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const baseY = (term.buffer.active as { baseY: number }).baseY;
  const ledgerBefore = getTerminalLineTimestampLedgerCount(term as never);
  const disposedBefore = fake.disposedMarkerLines.length;

  // Capture a viewport line that still has seed text + a gutter stamp.
  const viewportSeedLine = baseY + 1;
  const viewportSeedText = (
    term.buffer.active.getLine(viewportSeedLine) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);
  assert.match(viewportSeedText, /^seed-\d+$/);

  writeTerminalDataWithLineTimestamps(term as never, "\x1b[2J", () => {});

  assert.ok(
    fake.disposedMarkerLines.length > disposedBefore,
    "CSI 2 J must dispose rematerialized markers on erased viewport rows",
  );
  assert.ok(
    getTerminalLineTimestampLedgerCount(term as never) < ledgerBefore,
    "erased viewport stamps must drop from the saturated ledger",
  );

  const cleared = (
    term.buffer.active.getLine(viewportSeedLine) as {
      translateToString: (trimRight?: boolean) => string;
    }
  ).translateToString(true);
  assert.equal(cleared, "", "CSI 2 J must clear viewport cell text");

  fake.setViewportY(baseY);
  const painted = getVisibleTerminalLineTimestampRows(term as never);
  const viewportY = (term.buffer.active as { viewportY: number }).viewportY;
  for (const row of painted) {
    const text = (
      term.buffer.active.getLine(viewportY + row.row) as {
        translateToString: (trimRight?: boolean) => string;
      }
    ).translateToString(true);
    // Blank erased viewport rows must not keep the seed stamp that lived there.
    if (!text && viewportY + row.row >= baseY) {
      const seedSecond = Number(/^seed-(\d+)$/.exec(viewportSeedText)?.[1] ?? -1) % 60;
      const stale = `12:00:${String(seedSecond).padStart(2, "0")}`;
      assert.notEqual(
        row.label,
        stale,
        `blank viewport must not keep erased stamp ${stale}, got ${JSON.stringify({ row, painted, viewportSeedText })}`,
      );
    }
  }
});

test("simple ASCII control text gate matches seq-style floods", () => {
  assert.equal(isSimpleAsciiControlText("1\n2\n3\n"), true);
  assert.equal(isSimpleAsciiControlText("line-0\r\nline-1\r\n"), true);
  assert.equal(isSimpleAsciiControlText("a\tb\b c"), true);
  assert.equal(isSimpleAsciiControlText("hello\x1b[0m"), false);
  assert.equal(isSimpleAsciiControlText("界"), false);
});
test("tryMeasureVisualRows matches hard-newline accounting for short ASCII lines", () => {
  const { term } = createFakeTerm({ cols: 80 });
  const data = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\r\n");
  const measured = tryMeasureVisualRows(term as never, data, 0, 80, true);
  assert.ok(measured);
  assert.equal(measured?.rowOffset, 99);
  assert.equal(measured?.column, "line-99".length);
});
test("tryMeasureVisualRows accounts for soft wraps on long ASCII lines", () => {
  const { term } = createFakeTerm({ cols: 5 });
  const measured = tryMeasureVisualRows(term as never, "abcdefghij", 0, 5, true);
  assert.ok(measured);
  assert.equal(measured?.rowOffset, 1);
  assert.equal(measured?.column, 5);
});
test("tryMeasureVisualRows rejects unmeasurable escape sequences", () => {
  const { term } = createFakeTerm({ cols: 80 });
  assert.equal(
    tryMeasureVisualRows(term as never, "\x1b[Aup", 0, 80, true),
    null,
  );
});
test("capacity follows small scrollback and caps large histories", () => {
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 1000 },
    } as never),
    1000 + 24 + 64,
  );
  // Large scrollback values must not create a live xterm marker per retained row.
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 200000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 24,
      options: { scrollback: 80000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
  assert.equal(
    resolveTerminalLineTimestampCapacity({
      rows: 400,
      options: { scrollback: 100000 },
    } as never),
    MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
  );
});
