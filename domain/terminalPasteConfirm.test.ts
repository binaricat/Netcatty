import test from "node:test";
import assert from "node:assert/strict";

import {
  getMultilinePasteInfo,
  normalizeMultilinePasteConfirmMinLines,
  shouldConfirmMultilinePaste,
} from "./terminalPasteConfirm";

test("line count ignores a single trailing newline", () => {
  assert.equal(getMultilinePasteInfo("line1\nline2\n").lineCount, 2);
  assert.equal(getMultilinePasteInfo("line1\n").lineCount, 1);
  assert.equal(getMultilinePasteInfo("").lineCount, 0);
});

test("line count normalizes CRLF and CR line endings", () => {
  assert.equal(getMultilinePasteInfo("line1\r\nline2\rline3\n").lineCount, 3);
  assert.equal(getMultilinePasteInfo("a\r\nb\nc").charCount, 6);
});

test("default threshold asks for confirmation at 2+ lines", () => {
  assert.equal(shouldConfirmMultilinePaste("single"), false);
  assert.equal(shouldConfirmMultilinePaste("line1\n"), false);
  assert.equal(shouldConfirmMultilinePaste("line1\nline2"), true);
  assert.equal(shouldConfirmMultilinePaste("line1\r\nline2\r\nline3"), true);
});

test("configurable threshold is honored", () => {
  assert.equal(shouldConfirmMultilinePaste("line1\nline2", { minLines: 3 }), false);
  assert.equal(shouldConfirmMultilinePaste("line1\nline2\nline3", { minLines: 3 }), true);
});

test("threshold normalization clamps to the supported range", () => {
  assert.equal(normalizeMultilinePasteConfirmMinLines(undefined), 2);
  assert.equal(normalizeMultilinePasteConfirmMinLines(0), 1);
  assert.equal(normalizeMultilinePasteConfirmMinLines(-5), 1);
  assert.equal(normalizeMultilinePasteConfirmMinLines(2000), 1000);
  assert.equal(normalizeMultilinePasteConfirmMinLines(Number.NaN), 2);
  assert.equal(normalizeMultilinePasteConfirmMinLines(10.4), 10);
});
