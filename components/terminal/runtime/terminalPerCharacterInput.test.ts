import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RAW_PASTE_PER_CHARACTER_LENGTH,
  getTextInputWireChunks,
  shouldSplitImeTextInputForWire,
  shouldSplitRawPasteInputForWire,
  splitTextIntoCodePointWrites,
} from "./terminalPerCharacterInput";

test("splitTextIntoCodePointWrites keeps surrogate pairs on one write", () => {
  assert.deepEqual(splitTextIntoCodePointWrites("a中👍b"), ["a", "中", "👍", "b"]);
  assert.deepEqual(splitTextIntoCodePointWrites("👍"), ["👍"]);
  assert.deepEqual(splitTextIntoCodePointWrites(""), []);
});

test("IME commits with more than one character split per character", () => {
  assert.equal(shouldSplitImeTextInputForWire("中国"), true);
  assert.equal(shouldSplitImeTextInputForWire("abc"), true);
  assert.equal(shouldSplitImeTextInputForWire("中a👍"), true);
});

test("single-character IME commits keep the single write", () => {
  assert.equal(shouldSplitImeTextInputForWire("中"), false);
  assert.equal(shouldSplitImeTextInputForWire("👍"), false);
  assert.equal(shouldSplitImeTextInputForWire(","), false);
  assert.equal(shouldSplitImeTextInputForWire(""), false);
});

test("IME commits carrying escape sequences never split", () => {
  assert.equal(shouldSplitImeTextInputForWire("\x1b[200~中\x1b[201~"), false);
  assert.equal(shouldSplitImeTextInputForWire("\x1b[0;;200u"), false);
  assert.equal(shouldSplitImeTextInputForWire("\x1ba"), false);
});

test("short raw pastes split per character", () => {
  assert.equal(shouldSplitRawPasteInputForWire("10.1.2.3"), true);
  assert.equal(shouldSplitRawPasteInputForWire("中文"), true);
  assert.equal(shouldSplitRawPasteInputForWire("ab"), true);
  assert.equal(
    shouldSplitRawPasteInputForWire("a".repeat(MAX_RAW_PASTE_PER_CHARACTER_LENGTH)),
    true,
  );
});

test("single-character and long raw pastes keep the single write", () => {
  assert.equal(shouldSplitRawPasteInputForWire("a"), false);
  assert.equal(
    shouldSplitRawPasteInputForWire("a".repeat(MAX_RAW_PASTE_PER_CHARACTER_LENGTH + 1)),
    false,
  );
  assert.equal(shouldSplitRawPasteInputForWire(""), false);
});

test("raw pastes containing escape sequences never split", () => {
  assert.equal(shouldSplitRawPasteInputForWire("\x1b[200~ab\x1b[201~"), false);
  assert.equal(shouldSplitRawPasteInputForWire("\x1b[A"), false);
  assert.equal(shouldSplitRawPasteInputForWire("a\x1b"), false);
});

test("wire chunking honors the per-character request only for plain text", () => {
  assert.deepEqual(getTextInputWireChunks("ab", false), ["ab"]);
  assert.deepEqual(getTextInputWireChunks("ab", true), ["a", "b"]);
  assert.deepEqual(getTextInputWireChunks("a中👍", true), ["a", "中", "👍"]);
  assert.deepEqual(getTextInputWireChunks("\x1b[200~ab\x1b[201~", true), [
    "\x1b[200~ab\x1b[201~",
  ]);
});