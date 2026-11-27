import type { IBuffer, Terminal as XTerm } from "@xterm/xterm";

export type TerminalTextRange = {
  startLine: number;
  endLine: number;
};

type TerminalBufferTextSource = Pick<XTerm, "buffer" | "cols">;

export function readActiveTerminalBufferTextRange(
  term: TerminalBufferTextSource,
  range: TerminalTextRange,
): string {
  const startLine = Math.max(0, Math.floor(range.startLine));
  const endLine = Math.max(-1, Math.floor(range.endLine));
  if (endLine < startLine) return "";

  return readTerminalBufferTextRange(term.buffer.active, {
    ...range,
    cols: term.cols,
  });
}

export function readTerminalBufferTextRange(
  buffer: Pick<IBuffer, "getLine">,
  range: TerminalTextRange & { cols?: number },
): string {
  const startLine = Math.max(0, Math.floor(range.startLine));
  const endLine = Math.max(-1, Math.floor(range.endLine));
  if (endLine < startLine) return "";

  const cols = typeof range.cols === "number" && Number.isFinite(range.cols)
    ? Math.max(0, Math.floor(range.cols))
    : undefined;

  const lines: string[] = [];
  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    lines.push(line?.translateToString(true, 0, cols) ?? "");
  }
  return lines.join("\n");
}

/** Read the rendered viewport, preserving its physical row boundaries. */
export function readTerminalScreenText(term: Pick<XTerm, "buffer" | "cols" | "rows">): string {
  const buffer = term.buffer.active;
  const startLine = buffer.type === "alternate" ? 0 : buffer.viewportY;
  return readActiveTerminalBufferTextRange(term, {
    startLine,
    endLine: Math.min(buffer.length, startLine + term.rows) - 1,
  });
}

export interface CursorLogicalTailResult {
  text: string;
  cursorLine?: number;
  cursorAtLineEnd: boolean;
  hasContentBelowCursor: boolean;
}

/**
 * Reconstruct logical lines ending at the active xterm cursor for read-only
 * shell readiness seeding. Joins soft-wrapped physical rows (`isWrapped`) with
 * "" rather than "\n" so a wrapped pending command can never look like an idle
 * prompt, preserves trailing prompt spaces up to `cursorX`, and fails closed
 * when content exists to the right of or below the cursor.
 */
export function readCursorLogicalTailForReadiness(
  term: Pick<XTerm, "buffer" | "cols">,
  options: { maxLogicalLines?: number; maxWrappedRows?: number } = {},
): CursorLogicalTailResult {
  const buffer = term.buffer.active as typeof term.buffer.active & {
    baseY?: number;
    cursorY?: number;
    cursorX?: number;
  };
  const totalLines = Math.max(0, buffer.length);
  if (
    totalLines === 0
    || typeof buffer.baseY !== "number"
    || typeof buffer.cursorY !== "number"
    || typeof buffer.cursorX !== "number"
  ) {
    return { text: "", cursorAtLineEnd: false, hasContentBelowCursor: false };
  }

  const cols = Math.max(0, Math.floor(term.cols));
  const cursorLine = Math.min(totalLines - 1, Math.max(0, buffer.baseY + buffer.cursorY));
  const cursorColumn = Math.min(cols, Math.max(0, Math.floor(buffer.cursorX)));
  const lineAtCursor = buffer.getLine(cursorLine);
  if (!lineAtCursor) {
    return { text: "", cursorLine, cursorAtLineEnd: false, hasContentBelowCursor: false };
  }

  const afterCursor = lineAtCursor.translateToString(true, cursorColumn, cols);
  if (afterCursor.length > 0) {
    return { text: "", cursorLine, cursorAtLineEnd: false, hasContentBelowCursor: false };
  }

  for (let row = cursorLine + 1; row < totalLines; row += 1) {
    const below = buffer.getLine(row);
    if (row === cursorLine + 1 && below?.isWrapped === true) {
      return { text: "", cursorLine, cursorAtLineEnd: false, hasContentBelowCursor: false };
    }
    if (below && below.translateToString(true, 0, cols).trim().length > 0) {
      return { text: "", cursorLine, cursorAtLineEnd: true, hasContentBelowCursor: true };
    }
  }

  const maxLogicalLines = Math.max(1, options.maxLogicalLines ?? 8);
  const maxWrappedRows = Math.max(1, options.maxWrappedRows ?? 64);
  const logicalLines: string[] = [];
  let row = cursorLine;

  for (let logicalIdx = 0; logicalIdx < maxLogicalLines && row >= 0; logicalIdx += 1) {
    let startRow = row;
    let wrappedCount = 0;
    while (startRow > 0 && buffer.getLine(startRow)?.isWrapped === true) {
      wrappedCount += 1;
      if (wrappedCount > maxWrappedRows) {
        if (logicalIdx === 0) {
          return { text: "", cursorLine, cursorAtLineEnd: true, hasContentBelowCursor: false };
        }
        break;
      }
      startRow -= 1;
    }
    if (logicalIdx === 0 && startRow === 0 && buffer.getLine(0)?.isWrapped === true) {
      return { text: "", cursorLine, cursorAtLineEnd: true, hasContentBelowCursor: false };
    }

    let combined = "";
    for (let r = startRow; r <= row; r += 1) {
      const segment = buffer.getLine(r);
      if (!segment) continue;
      if (r === cursorLine) {
        combined += segment.translateToString(false, 0, cursorColumn);
      } else if (r < row) {
        combined += segment.translateToString(false, 0, cols);
      } else {
        combined += segment.translateToString(true, 0, cols);
      }
    }
    logicalLines.unshift(combined);
    row = startRow - 1;
  }

  return {
    text: logicalLines.join("\n"),
    cursorLine,
    cursorAtLineEnd: true,
    hasContentBelowCursor: false,
  };
}
