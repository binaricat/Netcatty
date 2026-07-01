import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComboboxWheelScroll,
  comboboxWheelDeltaToPixels,
  type ComboboxScrollableTarget,
} from "./ui/combobox.tsx";

const source = readFileSync(new URL("./ui/combobox.tsx", import.meta.url), "utf8");

test("combobox wheel deltas normalize to pixels", () => {
  assert.equal(comboboxWheelDeltaToPixels(12, 0), 12);
  assert.equal(comboboxWheelDeltaToPixels(3, 1), 48);
  assert.equal(comboboxWheelDeltaToPixels(1, 2), 280);
});

test("combobox wheel input scrolls the overflowing option list", () => {
  const target: ComboboxScrollableTarget = {
    clientHeight: 100,
    scrollHeight: 300,
    scrollTop: 20,
  };

  assert.equal(applyComboboxWheelScroll(target, 5, 1), true);
  assert.equal(target.scrollTop, 100);
});

test("combobox wheel input is ignored when the option list does not overflow", () => {
  const target: ComboboxScrollableTarget = {
    clientHeight: 300,
    scrollHeight: 300,
    scrollTop: 20,
  };

  assert.equal(applyComboboxWheelScroll(target, 5, 1), false);
  assert.equal(target.scrollTop, 20);
});

test("combobox option popovers capture wheel events inside the popup list", () => {
  assert.match(source, /onWheelCapture=\{handleWheelCapture\}/);
  assert.match(source, /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)[\s\S]*event\.nativeEvent\.stopImmediatePropagation\(\)/);
  assert.match(source, /app-no-drag p-0 border-border\/60/);
  assert.doesNotMatch(source, /from "\.\/scroll-area"/);
});
