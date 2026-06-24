import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
  TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
  getTerminalTimestampTypography,
  resolveTerminalTimestampGutterColor,
  resolveTerminalTimestampGutterWidth,
} from "./TerminalTimestampGutter.tsx";

test("timestamp gutter uses a bright color from the active terminal theme", () => {
  assert.equal(
    resolveTerminalTimestampGutterColor({
      brightCyan: "#66e8ff",
      brightYellow: "#ffe066",
      foreground: "#dddddd",
    }),
    "#66e8ff",
  );
});

test("timestamp gutter falls back within the terminal theme palette", () => {
  assert.equal(
    resolveTerminalTimestampGutterColor({
      brightYellow: "#ffe066",
      foreground: "#dddddd",
    }),
    "#ffe066",
  );
  assert.equal(
    resolveTerminalTimestampGutterColor({
      foreground: "#dddddd",
    }),
    "#dddddd",
  );
});

test("timestamp gutter width follows measured timestamp text width", () => {
  assert.equal(
    resolveTerminalTimestampGutterWidth({ measuredTextWidth: 84, fontSize: 14 }),
    84 + TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
  );
  assert.equal(
    resolveTerminalTimestampGutterWidth({ measuredTextWidth: 1, fontSize: 14 }),
    TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
  );
});

test("timestamp gutter typography follows terminal typography", () => {
  assert.deepEqual(
    getTerminalTimestampTypography({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
      fontWeight: 500,
    }),
    {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 15,
      fontWeight: 500,
    },
  );
});

test("timestamp gutter uses the terminal background", () => {
  const source = readFileSync(new URL("./TerminalTimestampGutter.tsx", import.meta.url), "utf8");

  assert.match(source, /backgroundColor: "var\(--terminal-ui-bg\)"/);
  assert.doesNotMatch(source, /bg-black\/10/);
  assert.match(source, /boxShadow: "inset -0\.5px 0 0 color-mix\(in srgb, var\(--terminal-ui-fg\) 8%, transparent\)"/);
  assert.doesNotMatch(source, /border-r/);
});
