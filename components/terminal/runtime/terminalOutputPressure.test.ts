import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  getTerminalOutputPressure,
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
  setTerminalOutputPressureVisibility,
} from "./terminalOutputPressure.ts";
import { TERMINAL_LONG_LINE_PRESSURE_BYTES } from "./terminalFlowConstants.ts";

const createFakeTerm = () => ({}) as XTerm;

test("tracks long unbroken terminal output pressure until a line break arrives", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, "x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES - 1));
  assert.equal(getTerminalOutputPressure(term).longLine, false);

  noteTerminalOutputPressureData(term, "x");
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");

  noteTerminalOutputPressureData(term, "\nshort");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});

test("reports newline-terminated long terminal lines as long-line pressure", () => {
  const term = createFakeTerm();

  noteTerminalOutputPressureData(term, `${"x".repeat(TERMINAL_LONG_LINE_PRESSURE_BYTES)}\n`);
  assert.equal(getTerminalOutputPressure(term).longLine, true);
  assert.equal(getTerminalOutputPressure(term).mode, "long-line");
  assert.equal(getTerminalOutputPressure(term).consecutiveUnbrokenBytes, 0);

  noteTerminalOutputPressureData(term, "short\n");
  assert.equal(getTerminalOutputPressure(term).longLine, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});

test("reports background pressure separately from output volume", () => {
  const term = createFakeTerm();

  setTerminalOutputPressureVisibility(term, false);
  assert.equal(getTerminalOutputPressure(term).background, true);
  assert.equal(getTerminalOutputPressure(term).mode, "background");

  setTerminalOutputPressureVisibility(term, true);
  assert.equal(getTerminalOutputPressure(term).background, false);
  assert.equal(getTerminalOutputPressure(term).mode, "normal");

  resetTerminalOutputPressure(term);
});
