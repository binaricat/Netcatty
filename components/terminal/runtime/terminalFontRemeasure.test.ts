import test from "node:test";
import assert from "node:assert/strict";

import { forceXTermFontRemeasure } from "./terminalFontRemeasure";

test("forceXTermFontRemeasure uses xterm char size service when available", () => {
  let measured = 0;
  const term = {
    _core: {
      _charSizeService: {
        measure() {
          measured += 1;
        },
      },
    },
    options: {
      fontSize: 14,
    },
  };

  assert.equal(forceXTermFontRemeasure(term), true);
  assert.equal(measured, 1);
  assert.equal(term.options.fontSize, 14);
});

test("forceXTermFontRemeasure falls back to a restored font size nudge", () => {
  let fontSize = 14;
  const writes: number[] = [];
  const term = {
    options: {},
  } as { options: { fontSize: number } };

  Object.defineProperty(term.options, "fontSize", {
    get: () => fontSize,
    set: (next: number) => {
      writes.push(next);
      fontSize = next;
    },
  });

  assert.equal(forceXTermFontRemeasure(term), true);
  assert.equal(writes.length, 2);
  assert.ok(writes[0] > 14);
  assert.equal(writes[1], 14);
  assert.equal(term.options.fontSize, 14);
});

test("forceXTermFontRemeasure reports unavailable when no measurement path exists", () => {
  assert.equal(forceXTermFontRemeasure({}), false);
  assert.equal(forceXTermFontRemeasure({ options: { fontSize: Number.NaN } }), false);
});
