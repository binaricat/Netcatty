import assert from "node:assert/strict";
import test from "node:test";

import {
  readActiveTerminalBufferTextRange,
  readTerminalBufferTextRange,
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

import { readTerminalScreenText } from "./terminalContextBuffer.ts";

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
