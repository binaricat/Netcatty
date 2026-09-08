import assert from "node:assert/strict";
import test from "node:test";

import { getCharByteLength, getCharDisplayWidth, getLastChar, removeLastChar, isPrintableInput } from "./serialCharMetrics";

/* ------------------------------------------------------------------ */
/* Display width                                                       */
/* ------------------------------------------------------------------ */

test("getCharDisplayWidth returns 1 for ASCII printable characters", () => {
  for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789 .,!?") {
    assert.equal(getCharDisplayWidth(ch), 1, `expected 1 for ${JSON.stringify(ch)}`);
  }
});

test("getCharDisplayWidth returns 2 for CJK Unified Ideographs", () => {
  assert.equal(getCharDisplayWidth("你"), 2);
  assert.equal(getCharDisplayWidth("好"), 2);
  assert.equal(getCharDisplayWidth("中"), 2);
  assert.equal(getCharDisplayWidth("文"), 2);
});

test("getCharDisplayWidth returns 2 for Hangul Syllables", () => {
  assert.equal(getCharDisplayWidth("한"), 2);
  assert.equal(getCharDisplayWidth("글"), 2);
});

test("getCharDisplayWidth returns 2 for Fullwidth Forms", () => {
  assert.equal(getCharDisplayWidth("！"), 2); // fullwidth exclamation
  assert.equal(getCharDisplayWidth("Ａ"), 2); // fullwidth Latin A
});

test("getCharDisplayWidth returns 2 for CJK Extension A", () => {
  assert.equal(getCharDisplayWidth("㐀"), 2); // U+3400
  assert.equal(getCharDisplayWidth("䶿"), 2); // U+4DBF
});

test("getCharDisplayWidth returns 2 for CJK Extension B (surrogate pair)", () => {
  assert.equal(getCharDisplayWidth("\u{20000}"), 2); // U+20000 — CJK Ext B
});

test("getCharDisplayWidth returns 2 for CJK Compatibility Ideographs", () => {
  assert.equal(getCharDisplayWidth("\uF900"), 2);
});

test("getCharDisplayWidth returns 0 for empty string", () => {
  assert.equal(getCharDisplayWidth(""), 0);
});

test("getCharDisplayWidth returns 1 for control characters", () => {
  assert.equal(getCharDisplayWidth("\x7f"), 1);
  assert.equal(getCharDisplayWidth("\b"), 1);
  assert.equal(getCharDisplayWidth("\r"), 1);
  assert.equal(getCharDisplayWidth("\n"), 1);
});

test("getCharDisplayWidth returns 2 for emoji", () => {
  assert.equal(getCharDisplayWidth("\u{1F600}"), 2); // Grinning face
});

/* ------------------------------------------------------------------ */
/* Byte length — UTF-8                                                 */
/* ------------------------------------------------------------------ */

test("getCharByteLength returns 1 for ASCII in UTF-8", () => {
  for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789") {
    assert.equal(getCharByteLength(ch, "utf-8"), 1);
  }
});

test("getCharByteLength returns 1 for ASCII when charset is missing", () => {
  assert.equal(getCharByteLength("a"), 1);
  assert.equal(getCharByteLength("\x7f"), 1);
});

test("getCharByteLength returns 2 for Latin-1 Supplement in UTF-8", () => {
  assert.equal(getCharByteLength("\u00e9", "utf-8"), 2); // é
});

test("getCharByteLength returns 3 for CJK in UTF-8", () => {
  assert.equal(getCharByteLength("你", "utf-8"), 3);
  assert.equal(getCharByteLength("好", "utf-8"), 3);
  assert.equal(getCharByteLength("中", "utf-8"), 3);
});

test("getCharByteLength returns 3 for CJK when charset is missing (defaults to UTF-8)", () => {
  assert.equal(getCharByteLength("你"), 3);
});

test("getCharByteLength returns 4 for CJK Extension B in UTF-8", () => {
  assert.equal(getCharByteLength("\u{20000}", "utf-8"), 4);
});

test("getCharByteLength returns 4 for emoji in UTF-8", () => {
  assert.equal(getCharByteLength("\u{1F600}", "utf-8"), 4);
});

test("getCharByteLength returns 1 for control characters in UTF-8", () => {
  assert.equal(getCharByteLength("\x7f", "utf-8"), 1);
  assert.equal(getCharByteLength("\b", "utf-8"), 1);
  assert.equal(getCharByteLength("\r", "utf-8"), 1);
  assert.equal(getCharByteLength("\x08", "utf-8"), 1);
});

/* ------------------------------------------------------------------ */
/* Byte length — GB18030 / GBK                                         */
/* ------------------------------------------------------------------ */

test("getCharByteLength returns 1 for ASCII in GB18030", () => {
  assert.equal(getCharByteLength("a", "gb18030"), 1);
  assert.equal(getCharByteLength("\x7f", "gb18030"), 1);
});

test("getCharByteLength returns 2 for CJK in GB18030", () => {
  assert.equal(getCharByteLength("你", "gb18030"), 2);
  assert.equal(getCharByteLength("好", "gb18030"), 2);
  assert.equal(getCharByteLength("中", "gb18030"), 2);
});

test("getCharByteLength returns 1 for control characters in GB18030", () => {
  assert.equal(getCharByteLength("\x7f", "gb18030"), 1);
  assert.equal(getCharByteLength("\b", "gb18030"), 1);
});

test("getCharByteLength handles GBK alias", () => {
  assert.equal(getCharByteLength("你", "GBK"), 2);
  assert.equal(getCharByteLength("你", "gb2312"), 2);
  assert.equal(getCharByteLength("你", "cp936"), 2);
});

/* ------------------------------------------------------------------ */
/* Edge cases                                                          */
/* ------------------------------------------------------------------ */

test("getCharByteLength returns 1 for empty string", () => {
  assert.equal(getCharByteLength("", "utf-8"), 1);
});

test("getCharDisplayWidth returns 1 for null-like empty input", () => {
  assert.equal(getCharDisplayWidth(""), 0);
});

/* ------------------------------------------------------------------ */
/* Byte length — GB18030 4-byte supplementary characters               */
/* ------------------------------------------------------------------ */

test("getCharByteLength returns 4 for CJK Extension B in GB18030", () => {
  // U+20000 is CJK Extension B — 4 bytes in GB18030.
  assert.equal(getCharByteLength("\u{20000}", "gb18030"), 4);
});

test("getCharByteLength returns 4 for emoji in GB18030", () => {
  // U+1F600 (grinning face) — 4 bytes in GB18030.
  assert.equal(getCharByteLength("\u{1F600}", "gb18030"), 4);
});

test("getCharByteLength returns 2 for BMP CJK in GB18030 (not 4)", () => {
  // U+4E00 is BMP CJK — 2 bytes in GB18030, not 4.
  assert.equal(getCharByteLength("你", "gb18030"), 2);
});

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

test("getCharByteLength counts whole decomposed grapheme bytes in UTF-8", () => {
  // e (1 byte) + combining acute (2 bytes) = 3 bytes on the wire.
  assert.equal(getCharByteLength("e\u0301", "utf-8"), 3);
});

test("getCharDisplayWidth returns 1 for decomposed grapheme", () => {
  // Base 'e' is 1 cell; combining mark contributes 0 cells.
  assert.equal(getCharDisplayWidth("e\u0301"), 1);
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
