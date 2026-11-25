import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustLightnessToken,
  adjustSaturationToken,
  hexToHslToken,
  resolveReadableForegroundForHsl,
} from "./colorContrast.ts";

test("hexToHslToken converts hex colors with or without leading hash", () => {
  assert.equal(hexToHslToken("#000000"), "0 0% 0%");
  assert.equal(hexToHslToken("#ffffff"), "0 0% 100%");
  assert.equal(hexToHslToken("#ff0000"), "0 100% 50%");
  assert.equal(hexToHslToken("00ff00"), "120 100% 50%");
  assert.equal(hexToHslToken("#0000ff"), "240 100% 50%");
  assert.equal(hexToHslToken("#1e1e2e"), hexToHslToken("1e1e2e"));
});

test("adjustLightnessToken shifts lightness and clamps to [0, 100]", () => {
  assert.equal(adjustLightnessToken("240 21.1% 14.9%", 6), "240 21.1% 20.9%");
  assert.equal(adjustLightnessToken("240 21.1% 14.9%", -20), "240 21.1% 0%");
  assert.equal(adjustLightnessToken("240 21.1% 95%", 15), "240 21.1% 100%");
});

test("adjustSaturationToken scales saturation and clamps to [0, 100]", () => {
  assert.equal(adjustSaturationToken("220 50% 80%", 0.5), "220 25% 80%");
  assert.equal(adjustSaturationToken("220 80% 80%", 2), "220 100% 80%");
  assert.equal(adjustSaturationToken("220 80% 80%", -1), "220 0% 80%");
});

test("hexToHslToken pairs with resolveReadableForegroundForHsl", () => {
  assert.equal(resolveReadableForegroundForHsl(hexToHslToken("#111111")), "0 0% 100%");
  assert.equal(resolveReadableForegroundForHsl(hexToHslToken("#f5f5f5")), "0 0% 0%");
});
