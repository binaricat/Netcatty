import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveNoteFontFamily,
  resolveNoteFontSelectionFamily,
  resolveNoteFontSelectionId,
} from "./noteFonts.ts";

const fonts = [
  { id: "menlo", family: "Menlo, monospace" },
  { id: "fira", family: '"Fira Code", monospace' },
];

test("note font settings store CSS families and read legacy ids", () => {
  assert.equal(resolveNoteFontSelectionFamily(fonts, "fira"), '"Fira Code", monospace');
  assert.equal(resolveNoteFontSelectionId(fonts, '"Fira Code", monospace'), "fira");
  assert.equal(resolveNoteFontFamily(fonts, "menlo"), "Menlo, monospace");
  assert.equal(resolveNoteFontFamily(fonts, "unknown"), "");
  assert.equal(resolveNoteFontSelectionId(fonts, ""), "");
  assert.equal(resolveNoteFontSelectionFamily([{ id: "", family: "" }, ...fonts], ""), "");
});
