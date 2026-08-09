import test from "node:test";
import assert from "node:assert/strict";

import {
  codePointCellWidth,
  removeLastCodePoint,
  stringCellWidth,
} from "./xtermUtils.ts";

test("stringCellWidth treats emoji modifier sequences as one wide glyph", () => {
  // 👍🏽 = thumbs-up + medium skin tone. Code-point sum is 4; xterm 15-graphemes
  // renders the cluster as a single 2-cell glyph.
  const thumbs = "\u{1F44D}\u{1F3FD}";
  assert.equal(codePointCellWidth(0x1f44d) + codePointCellWidth(0x1f3fd), 4);
  assert.equal(stringCellWidth(thumbs), 2);
});

test("stringCellWidth treats ZWJ emoji families as one wide glyph", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  assert.equal(stringCellWidth(family), 2);
});

test("stringCellWidth keeps regional-indicator flags at two cells", () => {
  const flag = "\u{1F1FA}\u{1F1F8}"; // 🇺🇸
  assert.equal(stringCellWidth(flag), 2);
});

test("stringCellWidth still counts CJK and ASCII by display cells", () => {
  assert.equal(stringCellWidth("中"), 2);
  assert.equal(stringCellWidth("cat "), 4);
  assert.equal(stringCellWidth("e\u0301"), 1);
});

test("stringCellWidth treats emoji presentation selectors as wide graphemes", () => {
  // ☺️ / keycap digit: xterm 15-graphemes promotes U+FE0F to width 2 when it
  // joins its base, so the cluster is two cells (not narrow base + zero VS).
  assert.equal(codePointCellWidth(0xfe0f), 0);
  assert.equal(stringCellWidth("\u263A\uFE0F"), 2);
  assert.equal(stringCellWidth("1\uFE0F\u20E3"), 2);
});

test("stringCellWidth counts legacy emoji-presentation characters as wide", () => {
  // Outside the supplementary emoji blocks; xterm 15-graphemes still treats
  // Emoji_Presentation=Yes BMP symbols as two cells without needing FE0F.
  assert.equal(codePointCellWidth(0x2705), 2); // ✅
  assert.equal(codePointCellWidth(0x26a1), 2); // ⚡
  assert.equal(codePointCellWidth(0x231a), 2); // ⌚
  assert.equal(stringCellWidth("✅⚡⌚"), 6);
  // Text-default emoji stay narrow unless FE0F joins them.
  assert.equal(codePointCellWidth(0x2600), 1); // ☀
  assert.equal(stringCellWidth("\u2600"), 1);
  assert.equal(stringCellWidth("\u2600\uFE0F"), 2);
});

test("removeLastCodePoint erases one code point, matching Bash/readline Backspace", () => {
  // Non-BMP emoji is one code point spanning two UTF-16 units.
  assert.equal(removeLastCodePoint("hello\u{1F600}"), "hello");
  // Skin-tone modifier is a separate code point; readline leaves the base.
  assert.equal(removeLastCodePoint("a\u{1F44D}\u{1F3FD}"), "a\u{1F44D}");
  assert.equal(removeLastCodePoint("x"), "");
  assert.equal(removeLastCodePoint(""), "");
});
