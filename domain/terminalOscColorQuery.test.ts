import assert from "node:assert/strict";
import test from "node:test";

import { stripOscColorQueryResponses } from "./terminalOscColorQuery";

const ESCAPE = "\u001b";
const STRING_TERMINATOR = `${ESCAPE}\\`;

test("stripOscColorQueryResponses leaves data unchanged when disabled", () => {
  const response = `${ESCAPE}]11;rgb:0d0d/1111/1717${STRING_TERMINATOR}`;

  assert.equal(stripOscColorQueryResponses(response, false), response);
});

test("stripOscColorQueryResponses removes dynamic color responses", () => {
  const response = `${ESCAPE}]10;rgb:c9c9/d1d1/d9d9${STRING_TERMINATOR}${ESCAPE}]11;rgb:0d0d/1111/1717\u0007`;

  assert.equal(stripOscColorQueryResponses(`before${response}after`, true), "beforeafter");
});

test("stripOscColorQueryResponses removes indexed palette responses", () => {
  const response = `${ESCAPE}]4;12;rgb:7aa7/f2f2/f7f7${STRING_TERMINATOR}`;

  assert.equal(stripOscColorQueryResponses(response, true), "");
});

test("stripOscColorQueryResponses preserves non-response terminal data", () => {
  const colorSetting = `${ESCAPE}]11;#112233${STRING_TERMINATOR}`;
  const cursorReport = `${ESCAPE}[12;34R`;

  assert.equal(
    stripOscColorQueryResponses(`text${colorSetting}${cursorReport}`, true),
    `text${colorSetting}${cursorReport}`,
  );
});

test("stripOscColorQueryResponses removes multiple responses while preserving input", () => {
  const first = `${ESCAPE}]11;rgb:f1f1/f4f4/f8f8${STRING_TERMINATOR}`;
  const second = `${ESCAPE}]10;rgb:2424/2929/2f2f${STRING_TERMINATOR}`;

  assert.equal(
    stripOscColorQueryResponses(`docker logs${first} output${second} prompt`, true),
    "docker logs output prompt",
  );
});

test("stripOscColorQueryResponses does not remove malformed or incomplete responses", () => {
  const incomplete = `${ESCAPE}]11;rgb:0d0d/1111/1717`;
  const malformed = `${ESCAPE}]11;rgb:00000/1111/1717${STRING_TERMINATOR}`;

  assert.equal(stripOscColorQueryResponses(`${incomplete}${malformed}`, true), `${incomplete}${malformed}`);
});
