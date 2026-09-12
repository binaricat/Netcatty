import assert from "node:assert/strict";
import test from "node:test";

import { getLastChar, removeLastChar, isPrintableInput } from "./serialCharMetrics";

/* ------------------------------------------------------------------ */
/* Byte length — UTF-8                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Byte length — GB18030 / GBK                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Byte length — GB18030 4-byte supplementary characters               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* getLastChar / removeLastChar (surrogate-pair-safe slicing)           */
/* ------------------------------------------------------------------ */

test("getLastChar returns single BMP character", () => {
  assert.equal(getLastChar("abc"), "c");
  assert.equal(getLastChar("a你"), "你");
});

test("getLastChar returns full surrogate pair for supplementary characters", () => {
  // U+20000 is stored as a surrogate pair (D840 DC00).
  const extB = "\u{20000}";
  assert.equal(getLastChar("a" + extB), extB);
  assert.equal(getLastChar(extB), extB);
});

test("removeLastChar removes single BMP character", () => {
  assert.equal(removeLastChar("abc"), "ab");
  assert.equal(removeLastChar("a你"), "a");
});

test("removeLastChar removes full surrogate pair for supplementary characters", () => {
  // U+20000 is stored as a surrogate pair (D840 DC00).
  const extB = "\u{20000}";
  assert.equal(removeLastChar("a" + extB), "a");
  assert.equal(removeLastChar(extB), "");
});

test("removeLastChar returns empty string for single character", () => {
  assert.equal(removeLastChar("a"), "");
});

test("getLastChar and removeLastChar handle empty string", () => {
  assert.equal(getLastChar(""), "");
  assert.equal(removeLastChar(""), "");
});

test("getLastChar returns whole decomposed grapheme (base + combining mark)", () => {
  // e + U+0301 (combining acute) renders as one visible é.
  const decomposed = "e\u0301";
  assert.equal(getLastChar("a" + decomposed), decomposed);
  assert.equal(getLastChar(decomposed), decomposed);
});

test("removeLastChar removes whole decomposed grapheme (base + combining mark)", () => {
  const decomposed = "e\u0301";
  assert.equal(removeLastChar("a" + decomposed), "a");
  assert.equal(removeLastChar(decomposed), "");
});

test("getLastChar returns whole ZWJ emoji sequence", () => {
  // Man + ZWJ + Woman renders as one grapheme.
  const zwj = "\u{1F468}\u200D\u{1F469}";
  assert.equal(getLastChar("hi" + zwj), zwj);
});

test("removeLastChar removes whole ZWJ emoji sequence", () => {
  const zwj = "\u{1F468}\u200D\u{1F469}";
  assert.equal(removeLastChar("hi" + zwj), "hi");
  assert.equal(removeLastChar(zwj), "");
});

test("getLastChar returns whole variation-selector sequence", () => {
  // Heart + VS16 (U+FE0F) renders as one emoji grapheme.
  const heart = "\u2764\uFE0F";
  assert.equal(getLastChar("a" + heart), heart);
});

test("removeLastChar removes whole variation-selector sequence", () => {
  const heart = "\u2764\uFE0F";
  assert.equal(removeLastChar("a" + heart), "a");
  assert.equal(removeLastChar(heart), "");
});

/* ------------------------------------------------------------------ */
/* isPrintableInput                                                      */
/* ------------------------------------------------------------------ */

test("isPrintableInput returns true for printable characters", () => {
  assert.equal(isPrintableInput("a"), true);
  assert.equal(isPrintableInput("你"), true);
  assert.equal(isPrintableInput("hello"), true);
  assert.equal(isPrintableInput("123"), true);
  assert.equal(isPrintableInput(" "), true); // space is printable
});

test("isPrintableInput returns false for escape sequences", () => {
  assert.equal(isPrintableInput("\x1b[A"), false); // up arrow
  assert.equal(isPrintableInput("\x1b[D"), false); // left arrow
  assert.equal(isPrintableInput("\x1b[32m"), false); // color escape
});

test("isPrintableInput returns false for control characters", () => {
  assert.equal(isPrintableInput("\x7f"), false); // DEL
  assert.equal(isPrintableInput("\b"), false); // backspace
  assert.equal(isPrintableInput("\r"), false); // carriage return
  assert.equal(isPrintableInput("\n"), false); // newline
  assert.equal(isPrintableInput("\x03"), false); // Ctrl+C
  assert.equal(isPrintableInput("\x15"), false); // Ctrl+U
});

test("isPrintableInput returns false for empty string", () => {
  assert.equal(isPrintableInput(""), false);
});
