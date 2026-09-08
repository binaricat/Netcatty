import assert from "node:assert/strict";
import test from "node:test";

import { getCharByteLength, getCharDisplayWidth } from "./serialCharMetrics";

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
