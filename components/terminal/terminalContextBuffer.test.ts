import assert from "node:assert/strict";
import test from "node:test";

import {
  readActiveTerminalBufferTextRange,
  readCursorLogicalTailForReadiness,
  readTerminalBufferTextRange,
  readTerminalScreenText,
} from "./terminalContextBuffer.ts";

function createBuffer(lines: string[]) {
  return {
    getLine(index: number) {
      const value = lines[index];
      if (value === undefined) return undefined;
      return {
        translateToString(trimRight?: boolean, startColumn = 0, endColumn?: number) {
          const sliced = value.slice(startColumn, endColumn);
          return trimRight ? sliced.trimEnd() : sliced;
        },
      };
    },
  };
}

test("readTerminalBufferTextRange returns only the requested rows", () => {
  const buffer = createBuffer([
    "normal-history",
    "top header",
    "cpu  12%",
    "mem  44%",
    "bottom prompt",
  ]);

  assert.equal(
    readTerminalBufferTextRange(buffer as never, {
      startLine: 1,
      endLine: 3,
      cols: 80,
    }),
    "top header\ncpu  12%\nmem  44%",
  );
});

test("readActiveTerminalBufferTextRange reads the active alternate buffer without normal scrollback", () => {
  const normalBuffer = createBuffer(["old normal scrollback"]);
  const alternateBuffer = createBuffer(["vim title", "file body", ":"]);
  const term = {
    cols: 80,
    buffer: {
      active: alternateBuffer,
      normal: normalBuffer,
      alternate: alternateBuffer,
    },
  };

  assert.equal(
    readActiveTerminalBufferTextRange(term as never, { startLine: 0, endLine: 2 }),
    "vim title\nfile body\n:",
  );
});

test("screen export follows the scrolled viewport and excludes hidden history", () => {
  const buffer = { ...createBuffer(["old", "visible one", "  visible two", "newest"]),
    viewportY: 1, length: 4, type: "normal" };
  assert.equal(readTerminalScreenText({ cols: 80, rows: 2, buffer: { active: buffer } } as never),
    "visible one\n  visible two");
});

test("screen export preserves blank and wrapped physical rows and clips hidden columns", () => {
  const buffer = { ...createBuffer(["123456", "78", "", "end", ""]),
    viewportY: 0, length: 5, type: "normal" };
  assert.equal(readTerminalScreenText({ cols: 4, rows: 5, buffer: { active: buffer } } as never),
    "1234\n78\n\nend\n");
});

test("screen export reads only the alternate screen while fullscreen apps are active", () => {
  const buffer = { ...createBuffer(["vim", "text", ""]),
    viewportY: 0, length: 3, type: "alternate" };
  assert.equal(readTerminalScreenText({ cols: 80, rows: 3, buffer: { active: buffer } } as never),
    "vim\ntext\n");
});

type MockCell = { code: number; width: number };

function createCursorTerm(
  rows: Array<{ text: string; isWrapped?: boolean; length?: number; cells?: MockCell[] }>,
  { cols = 80, baseY = 0, cursorY = 0, cursorX = 0 }: { cols?: number; baseY?: number; cursorY?: number; cursorX?: number },
) {
  return {
    cols,
    buffer: {
      active: {
        length: rows.length,
        baseY,
        cursorY,
        cursorX,
        getLine(index: number) {
          const row = rows[index];
          if (!row) return undefined;
          return {
            length: row.length ?? row.cells?.length ?? cols,
            isWrapped: row.isWrapped === true,
            ...(row.cells
              ? {
                getCell(col: number) {
                  const cell = row.cells?.[col];
                  if (!cell) return undefined;
                  return {
                    getCode: () => cell.code,
                    getWidth: () => cell.width,
                  };
                },
              }
              : {}),
            translateToString(trimRight?: boolean, startColumn = 0, endColumn?: number) {
              const sliced = row.text.slice(startColumn, endColumn);
              return trimRight ? sliced.trimEnd() : sliced;
            },
          };
        },
      },
    },
  };
}

test("readCursorLogicalTailForReadiness joins soft-wrapped rows so wrapped pending commands never look like prompts", () => {
  const term = createCursorTerm(
    [
      { text: "user@host:~$ echo " + "x".repeat(62), isWrapped: false },
      { text: "user@host:~$ ", isWrapped: true },
      { text: "", isWrapped: false },
    ],
    { cols: 80, baseY: 0, cursorY: 1, cursorX: 13 },
  );
  const result = readCursorLogicalTailForReadiness(term as never);
  assert.equal(result.cursorAtLineEnd, true);
  assert.equal(result.text, `user@host:~$ echo ${"x".repeat(62)}user@host:~$ `);
});

test("readCursorLogicalTailForReadiness preserves trailing prompt spaces and strips empty rows below cursor", () => {
  const term = createCursorTerm(
    [
      { text: "Last login: Fri Nov 27" },
      { text: "user@host:~$ " },
      { text: "" },
      { text: "" },
    ],
    { cols: 80, baseY: 0, cursorY: 1, cursorX: 13 },
  );
  const result = readCursorLogicalTailForReadiness(term as never);
  assert.equal(result.cursorLine, 1);
  assert.equal(result.cursorAtLineEnd, true);
  assert.equal(result.hasContentBelowCursor, false);
  assert.equal(result.text, "Last login: Fri Nov 27\nuser@host:~$ ");
});

test("readCursorLogicalTailForReadiness reconstructs wrapped two-line prompts cleanly", () => {
  const term = createCursorTerm(
    [
      { text: "[root@very-long-host", isWrapped: false },
      { text: "-01 ~] br0 = 10.1.64.1", isWrapped: true },
      { text: "# ", isWrapped: false },
      { text: "", isWrapped: false },
    ],
    { cols: 80, baseY: 0, cursorY: 2, cursorX: 2 },
  );
  const result = readCursorLogicalTailForReadiness(term as never);
  assert.equal(result.text, "[root@very-long-host-01 ~] br0 = 10.1.64.1\n# ");
});

test("readCursorLogicalTailForReadiness fails closed on mid-line edits, text below cursor, and evicted wrapped heads", () => {
  // Mid-line cursor edit
  const midLine = createCursorTerm(
    [{ text: "user@host:~$ echo hi" }],
    { cols: 80, baseY: 0, cursorY: 0, cursorX: 13 },
  );
  assert.equal(readCursorLogicalTailForReadiness(midLine as never).text, "");

  // Non-empty text below cursor (primary-screen TUI/menu)
  const textBelow = createCursorTerm(
    [{ text: "user@host:~$ " }, { text: "Menu item" }],
    { cols: 80, baseY: 0, cursorY: 0, cursorX: 13 },
  );
  assert.equal(readCursorLogicalTailForReadiness(textBelow as never).text, "");

  // Evicted scrollback head on cursor's wrapped logical line
  const evictedWrap = createCursorTerm(
    [{ text: "user@host:~$ ", isWrapped: true }],
    { cols: 80, baseY: 0, cursorY: 0, cursorX: 13 },
  );
  assert.equal(readCursorLogicalTailForReadiness(evictedWrap as never).text, "");

  // Soft-wrapped continuation row below cursor
  const wrappedBelow = createCursorTerm(
    [{ text: "user@host:~$ ", isWrapped: false }, { text: "", isWrapped: true }],
    { cols: 80, baseY: 0, cursorY: 0, cursorX: 13 },
  );
  assert.equal(readCursorLogicalTailForReadiness(wrappedBelow as never).text, "");
});

test("readCursorLogicalTailForReadiness discards truncated or evicted preceding wrapped lines", () => {
  // 67-row unfinished command whose truncated suffix starts with a host-like header,
  // followed by a bare `# ` continuation line: must NOT emit the cut-off suffix as a header.
  const longWrappedRows: Array<{ text: string; isWrapped?: boolean }> = [
    { text: "echo 'start        ", isWrapped: false },
    { text: "padding-row-1      ", isWrapped: true },
    { text: "user@host: /project", isWrapped: true },
  ];
  for (let i = 0; i < 64; i += 1) {
    longWrappedRows.push({ text: "x".repeat(20), isWrapped: true });
  }
  longWrappedRows.push({ text: "# ", isWrapped: false });

  const overCap = createCursorTerm(longWrappedRows, {
    cols: 20,
    baseY: 0,
    cursorY: longWrappedRows.length - 1,
    cursorX: 2,
  });
  assert.equal(readCursorLogicalTailForReadiness(overCap as never).text, "# ");

  // Scrollback-evicted preceding wrapped line (`row 0` has `isWrapped: true`) above bare `# `.
  const evictedPreceding = createCursorTerm(
    [
      { text: "user@host: /project", isWrapped: true },
      { text: "# ", isWrapped: false },
    ],
    { cols: 80, baseY: 0, cursorY: 1, cursorX: 2 },
  );
  assert.equal(readCursorLogicalTailForReadiness(evictedPreceding as never).text, "# ");

  // Complete single-line prompt below a truncated log line is still preserved cleanly.
  const completePromptAfterLongLog = createCursorTerm(
    [
      ...longWrappedRows.slice(0, -1),
      { text: "user@host:~$ ", isWrapped: false },
    ],
    { cols: 20, baseY: 0, cursorY: longWrappedRows.length - 1, cursorX: 13 },
  );
  assert.equal(readCursorLogicalTailForReadiness(completePromptAfterLongLog as never).text, "user@host:~$ ");
});

function cellsForAscii(text: string, trailingCell?: MockCell): MockCell[] {
  const cells = Array.from(text, (ch) => ({ code: ch.charCodeAt(0), width: 1 }));
  if (trailingCell) cells.push(trailingCell);
  return cells;
}

test("readCursorLogicalTailForReadiness strips wide-character wrap padding without dropping real spaces or wide glyphs", () => {
  const wideCharA = "\u4e2d";
  const wideCharB = "\u6587";

  // Structural null padding cell (code 0, width 1) before a double-width glyph on the next wrapped row.
  const paddedWideWrap = createCursorTerm(
    [
      {
        text: "user@host:~abc ",
        isWrapped: false,
        length: 15,
        cells: cellsForAscii("user@host:~abc", { code: 0, width: 1 }),
      },
      {
        text: `${wideCharA}$ `,
        isWrapped: true,
        length: 15,
        cells: [{ code: 0x4e2d, width: 2 }, { code: 0, width: 0 }, { code: 36, width: 1 }, { code: 32, width: 1 }],
      },
    ],
    { cols: 15, baseY: 0, cursorY: 1, cursorX: 4 },
  );
  assert.equal(readCursorLogicalTailForReadiness(paddedWideWrap as never).text, `user@host:~abc${wideCharA}$ `);

  // Real typed trailing space (code 32, width 1) before a double-width glyph must be preserved.
  const realSpaceBeforeWide = createCursorTerm(
    [
      {
        text: "user@host:~ab  ",
        isWrapped: false,
        length: 15,
        cells: cellsForAscii("user@host:~ab ", { code: 32, width: 1 }),
      },
      {
        text: `${wideCharA}$ `,
        isWrapped: true,
        length: 15,
        cells: [{ code: 0x4e2d, width: 2 }, { code: 0, width: 0 }, { code: 36, width: 1 }, { code: 32, width: 1 }],
      },
    ],
    { cols: 15, baseY: 0, cursorY: 1, cursorX: 4 },
  );
  assert.equal(readCursorLogicalTailForReadiness(realSpaceBeforeWide as never).text, `user@host:~ab  ${wideCharA}$ `);

  // Trailing width-0 continuation cell of a wide glyph at the end of the row must NOT be sliced off.
  const wideGlyphAtRowEnd = createCursorTerm(
    [
      {
        text: `user@host:~a${wideCharA}`,
        isWrapped: false,
        length: 14,
        cells: [
          ...cellsForAscii("user@host:~a"),
          { code: 0x4e2d, width: 2 },
          { code: 0, width: 0 },
        ],
      },
      {
        text: `${wideCharB}$ `,
        isWrapped: true,
        length: 14,
        cells: [{ code: 0x6587, width: 2 }, { code: 0, width: 0 }, { code: 36, width: 1 }, { code: 32, width: 1 }],
      },
    ],
    { cols: 14, baseY: 0, cursorY: 1, cursorX: 4 },
  );
  assert.equal(readCursorLogicalTailForReadiness(wideGlyphAtRowEnd as never).text, `user@host:~a${wideCharA}${wideCharB}$ `);

  // Null cell ahead of a normal-width continuation is NOT wide-char wrap padding and stays intact.
  const nullBeforeNarrow = createCursorTerm(
    [
      {
        text: "user@host:~abc ",
        isWrapped: false,
        length: 15,
        cells: cellsForAscii("user@host:~abc", { code: 0, width: 1 }),
      },
      {
        text: "Z$ ",
        isWrapped: true,
        length: 15,
        cells: cellsForAscii("Z$ "),
      },
    ],
    { cols: 15, baseY: 0, cursorY: 1, cursorX: 3 },
  );
  assert.equal(readCursorLogicalTailForReadiness(nullBeforeNarrow as never).text, "user@host:~abc Z$ ");
});
