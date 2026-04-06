import type { Terminal as XTerm } from "@xterm/xterm";

type CsiParam = number | number[];
type InternalTerminal = XTerm & {
  _core?: {
    scroll?: (eraseAttr: unknown, isWrapped?: boolean) => void;
    _inputHandler?: {
      _eraseAttrData?: () => unknown;
    };
  };
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

  for (let row = 0; row < rowsToPreserve; row++) {
    scroll.call(internal._core, eraseAttr, false);
  }
};

export const clearTerminalViewport = (term: XTerm): void => {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return;

  const cursorY = buffer.cursorY;
  const cursorX = buffer.cursorX;

  if (cursorY === 0 && buffer.baseY === 0) return;

  const internal = term as InternalTerminal;
  const scroll = internal._core?.scroll;
  const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();

  if (typeof scroll !== "function" || eraseAttr === undefined) return;

  // Push lines above cursor into scrollback so they are preserved.
  // After cursorY scrolls the prompt line shifts to active-screen row 0.
  for (let i = 0; i < cursorY; i++) {
    scroll.call(internal._core, eraseAttr, false);
  }

  // Clear everything below the prompt and reposition the cursor on it.
  // CSI coordinates are 1-indexed.
  const col = cursorX + 1;
  term.write(`\x1b[2;1H\x1b[J\x1b[1;${col}H`, () => {
    term.scrollToBottom();
  });
};

export const isEraseScrollbackSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 3;

export const isEraseViewportSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 2;
