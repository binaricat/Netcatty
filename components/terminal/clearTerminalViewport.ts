import type { IDisposable, IParser, Terminal as XTerm } from "@xterm/xterm";

type CsiParam = number | number[];
type EraseInDisplayTerminal = XTerm & {
  parser: Pick<IParser, "registerCsiHandler">;
};
type InternalTerminal = XTerm & {
  _core?: {
    buffer?: {
      lines?: {
        length: number;
        trimStart?: (count: number) => void;
      };
      scrollTop: number;
      scrollBottom: number;
      ybase?: number;
      ydisp?: number;
    };
    scroll?: (eraseAttr: unknown, isWrapped?: boolean) => void;
    _inputHandler?: {
      _onScroll?: {
        fire?: (position: number) => void;
      };
      _eraseAttrData?: () => unknown;
    };
  };
};

type ClearTerminalViewportOptions = {
  wipeScrollback?: boolean;
};

type ClearTerminalViewportAndSyncPtyOptions = ClearTerminalViewportOptions & {
  syncPty: () => void;
};

type AppendEraseScrollbackOptions = {
  wipeScrollback: boolean;
  normalScreen: boolean;
  /**
   * Open DEC 2026 state carried from a prior PTY chunk (e.g. sync-block filter
   * saw `\x1b[?2026h` earlier). Chunk-local tracking alone cannot see that, so a
   * delayed full-redraw `\x1b[2J` would otherwise get a spurious `\x1b[3J`.
   */
  startInDec2026SyncBlock?: boolean;
};

type EraseInDisplayHandlerOptions = {
  getClearWipesScrollback: () => boolean;
  isInDec2026SyncBlock: () => boolean;
  scheduleMicrotask?: (callback: () => void) => void;
};

const getVisibleContentRowCount = (term: XTerm): number => {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") {
    return 0;
  }

  const baseY = buffer.baseY;
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buffer.getLine(baseY + row);
    if (!line) {
      continue;
    }
    if (line.translateToString(true).length > 0) {
      return row + 1;
    }
  }

  return 0;
};

const getInternalScrollRegion = (term: XTerm): { scrollTop: number; scrollBottom: number } | undefined => {
  const internalBuffer = (term as InternalTerminal)._core?.buffer;
  if (
    typeof internalBuffer?.scrollTop !== "number"
    || typeof internalBuffer.scrollBottom !== "number"
  ) {
    return undefined;
  }
  return internalBuffer;
};

const hasDefaultScrollRegion = (term: XTerm): boolean => {
  const scrollRegion = getInternalScrollRegion(term);
  if (!scrollRegion) {
    return true;
  }
  return scrollRegion.scrollTop === 0 && scrollRegion.scrollBottom === term.rows - 1;
};

export const preserveTerminalViewportInScrollback = (term: XTerm): void => {
  const rowsToPreserve = getVisibleContentRowCount(term);
  if (rowsToPreserve <= 0) {
    return;
  }

  const internal = term as InternalTerminal;
  const scroll = internal._core?.scroll;
  const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();

  if (typeof scroll !== "function" || eraseAttr === undefined) {
    return;
  }

  const scrollRegion = getInternalScrollRegion(term);
  const previousScrollTop = scrollRegion?.scrollTop;
  const previousScrollBottom = scrollRegion?.scrollBottom;

  try {
    // xterm scrolls inside active DECSTBM margins; widen them while preserving.
    if (scrollRegion) {
      scrollRegion.scrollTop = 0;
      scrollRegion.scrollBottom = term.rows - 1;
    }
    for (let row = 0; row < rowsToPreserve; row++) {
      scroll.call(internal._core, eraseAttr, false);
    }
  } finally {
    if (
      scrollRegion
      && previousScrollTop !== undefined
      && previousScrollBottom !== undefined
    ) {
      scrollRegion.scrollTop = previousScrollTop;
      scrollRegion.scrollBottom = previousScrollBottom;
    }
  }
};

export const clearTerminalViewport = (
  term: XTerm,
  options: ClearTerminalViewportOptions = {},
): boolean => {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return false;

  const cursorY = buffer.cursorY;
  const cursorX = buffer.cursorX;

  if (cursorY === 0 && buffer.baseY === 0) return false;

  const internal = term as InternalTerminal;
  const scroll = internal._core?.scroll;
  const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();

  if (typeof scroll !== "function" || eraseAttr === undefined) return false;

  // Push lines above cursor into scrollback so they are preserved.
  // After cursorY scrolls the prompt line shifts to active-screen row 0.
  for (let i = 0; i < cursorY; i++) {
    scroll.call(internal._core, eraseAttr, false);
  }

  // Clear everything below the prompt and reposition the cursor on it.
  // CSI coordinates are 1-indexed.
  const col = cursorX + 1;
  const eraseScrollback = options.wipeScrollback ? "\x1b[3J" : "";
  term.write(`\x1b[2;1H\x1b[J${eraseScrollback}\x1b[1;${col}H`, () => {
    term.scrollToBottom();
  });
  return true;
};

export const clearTerminalViewportAndSyncPty = (
  term: XTerm,
  { syncPty, ...options }: ClearTerminalViewportAndSyncPtyOptions,
): boolean => {
  const didClearViewport = clearTerminalViewport(term, options);
  if (didClearViewport) {
    syncPty();
  }
  return didClearViewport;
};

export const isEraseScrollbackSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 3;

export const isEraseViewportSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 2;

export const isEraseBelowSequence = (params: CsiParam[]): boolean =>
  params.length === 0 || params[0] === 0;

export const shouldScrollOnEraseInDisplay = (
  term: XTerm,
  inDec2026SyncBlock: boolean,
  clearWipesScrollback: boolean,
): boolean => {
  if (clearWipesScrollback || inDec2026SyncBlock) {
    return false;
  }
  return term.buffer.active.type === "normal" && hasDefaultScrollRegion(term);
};

/**
 * Netcatty preserves visible rows in scrollback before CSI 2 J so shell `clear`
 * does not discard history. TUIs inside DEC 2026 sync blocks or the alternate
 * screen expect an in-place erase instead.
 */
export const shouldPreserveViewportBeforeFullErase = (
  term: XTerm,
  inDec2026SyncBlock: boolean,
  clearWipesScrollback = false,
): boolean => {
  if (inDec2026SyncBlock || clearWipesScrollback) {
    return false;
  }
  return term.buffer.active.type === "normal";
};

export const shouldPreserveViewportBeforeEraseBelow = (
  term: XTerm,
  inDec2026SyncBlock: boolean,
  clearWipesScrollback = false,
): boolean => {
  if (!shouldPreserveViewportBeforeFullErase(term, inDec2026SyncBlock, clearWipesScrollback)) {
    return false;
  }
  const buffer = term.buffer.active;
  return buffer.cursorX === 0 && buffer.cursorY === 0;
};

export const shouldWipeScrollbackAfterEraseBelow = (
  term: XTerm,
  inDec2026SyncBlock: boolean,
  clearWipesScrollback: boolean,
): boolean => {
  if (!shouldWipeScrollbackAfterFullErase(term, inDec2026SyncBlock, clearWipesScrollback)) {
    return false;
  }
  const buffer = term.buffer.active;
  return buffer.cursorX === 0 && buffer.cursorY === 0;
};

const wipeTerminalScrollback = (term: XTerm): void => {
  const internal = term as InternalTerminal;
  const buffer = internal._core?.buffer;
  const lines = buffer?.lines;
  const scrollBackSize = (lines?.length ?? 0) - term.rows;
  if (!buffer || !lines || scrollBackSize <= 0 || typeof lines.trimStart !== "function") {
    return;
  }

  lines.trimStart(scrollBackSize);
  buffer.ybase = Math.max((buffer.ybase ?? 0) - scrollBackSize, 0);
  buffer.ydisp = Math.max((buffer.ydisp ?? 0) - scrollBackSize, 0);
  internal._core?._inputHandler?._onScroll?.fire?.(0);
};

export const shouldWipeScrollbackAfterFullErase = (
  term: XTerm,
  inDec2026SyncBlock: boolean,
  clearWipesScrollback: boolean,
): boolean => {
  if (!clearWipesScrollback || inDec2026SyncBlock) {
    return false;
  }
  return term.buffer.active.type === "normal";
};

export const installEraseInDisplayHandlers = (
  term: EraseInDisplayTerminal,
  {
    getClearWipesScrollback,
    isInDec2026SyncBlock,
    scheduleMicrotask = queueMicrotask,
  }: EraseInDisplayHandlerOptions,
): IDisposable => {
  const setScrollOnEraseInDisplayOnce = (enabled: boolean): void => {
    term.options.scrollOnEraseInDisplay = enabled;
    if (enabled) {
      scheduleMicrotask(() => {
        term.options.scrollOnEraseInDisplay = false;
      });
    }
  };

  const eraseDisposable = term.parser.registerCsiHandler({ final: "J" }, (params) => {
    const wipeAllowed = getClearWipesScrollback();
    const inDec2026SyncBlock = isInDec2026SyncBlock();
    // Scope xterm's native preservation to shell clears, not TUI redraws.
    if (isEraseViewportSequence(params)) {
      const useNativeScrollPreservation = shouldScrollOnEraseInDisplay(
        term,
        inDec2026SyncBlock,
        wipeAllowed,
      );
      setScrollOnEraseInDisplayOnce(useNativeScrollPreservation);
      if (
        !useNativeScrollPreservation
        && shouldPreserveViewportBeforeFullErase(term, inDec2026SyncBlock, wipeAllowed)
      ) {
        preserveTerminalViewportInScrollback(term);
      }
      return false;
    }
    setScrollOnEraseInDisplayOnce(false);
    if (isEraseBelowSequence(params)) {
      if (shouldPreserveViewportBeforeEraseBelow(term, inDec2026SyncBlock, wipeAllowed)) {
        preserveTerminalViewportInScrollback(term);
      } else if (shouldWipeScrollbackAfterEraseBelow(term, inDec2026SyncBlock, wipeAllowed)) {
        wipeTerminalScrollback(term);
      }
      return false;
    }
    if (!isEraseScrollbackSequence(params)) {
      return false;
    }
    // CSI 3 J — POSIX/ncurses default `clear` emits this to wipe scrollback.
    // Honor it unless the user opts into the legacy "preserve history" behavior.
    return !wipeAllowed;
  });
  const selectiveEraseDisposable = term.parser.registerCsiHandler({ prefix: "?", final: "J" }, () => {
    setScrollOnEraseInDisplayOnce(false);
    return false;
  });

  return {
    dispose: () => {
      eraseDisposable.dispose();
      selectiveEraseDisposable.dispose();
    },
  };
};

export const appendEraseScrollbackAfterFullErases = (
  data: string,
  {
    wipeScrollback,
    normalScreen,
    startInDec2026SyncBlock = false,
  }: AppendEraseScrollbackOptions,
): string => {
  if (!wipeScrollback || !normalScreen || data.length === 0) {
    return data;
  }

  // Hot path: all rewrites below only ever trigger on a literal \x1b[2J.
  // Sync open state may be carried from a prior chunk; without a 2J this chunk
  // still needs no rewrite.
  if (!data.includes("\x1b[2J")) {
    return data;
  }

  let result = "";
  let index = 0;
  let inDec2026SyncBlock = startInDec2026SyncBlock;
  let inAlternateScreen = false;

  while (index < data.length) {
    if (data.startsWith("\x1b[?2026h", index)) {
      inDec2026SyncBlock = true;
      result += "\x1b[?2026h";
      index += "\x1b[?2026h".length;
      continue;
    }

    if (data.startsWith("\x1b[?2026l", index)) {
      inDec2026SyncBlock = false;
      result += "\x1b[?2026l";
      index += "\x1b[?2026l".length;
      continue;
    }

    const altEnter = ["\x1b[?47h", "\x1b[?1047h", "\x1b[?1049h"].find((sequence) =>
      data.startsWith(sequence, index)
    );
    if (altEnter) {
      inAlternateScreen = true;
      result += altEnter;
      index += altEnter.length;
      continue;
    }

    const altLeave = ["\x1b[?47l", "\x1b[?1047l", "\x1b[?1049l"].find((sequence) =>
      data.startsWith(sequence, index)
    );
    if (altLeave) {
      inAlternateScreen = false;
      result += altLeave;
      index += altLeave.length;
      continue;
    }

    if (data.startsWith("\x1b[2J", index)) {
      result += "\x1b[2J";
      index += "\x1b[2J".length;
      if (
        !inDec2026SyncBlock
        && !inAlternateScreen
        && !data.startsWith("\x1b[3J", index)
      ) {
        result += "\x1b[3J";
      }
      continue;
    }

    result += data[index];
    index += 1;
  }

  return result;
};
