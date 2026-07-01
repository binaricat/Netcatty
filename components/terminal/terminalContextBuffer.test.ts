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
