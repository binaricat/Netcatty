import test from "node:test";
import assert from "node:assert/strict";

import {
  getVaultDropIntent,
  getVaultDropPosition,
} from "./vaultReorderDrag.ts";

const makeElement = (rect: Partial<DOMRect>): HTMLElement => ({
  getBoundingClientRect: () => ({
    left: 100,
    right: 200,
    top: 40,
    bottom: 100,
    width: 100,
    height: 60,
    x: 100,
    y: 40,
    toJSON: () => ({}),
    ...rect,
  }),
}) as HTMLElement;

test("vault drop position uses horizontal halves in grid and vertical halves in list", () => {
  const element = makeElement({});

  assert.equal(getVaultDropPosition(element, 120, 90, true), "before");
  assert.equal(getVaultDropPosition(element, 180, 50, true), "after");
  assert.equal(getVaultDropPosition(element, 180, 50, false), "before");
  assert.equal(getVaultDropPosition(element, 120, 90, false), "after");
});

test("vault drop intent uses edges for sorting and middle for nesting", () => {
  const element = makeElement({});

  assert.equal(getVaultDropIntent(element, 110, 70, true), "before");
  assert.equal(getVaultDropIntent(element, 190, 70, true), "after");
  assert.equal(getVaultDropIntent(element, 150, 70, true), "inside");
  assert.equal(getVaultDropIntent(element, 150, 45, false), "before");
  assert.equal(getVaultDropIntent(element, 150, 95, false), "after");
  assert.equal(getVaultDropIntent(element, 150, 70, false), "inside");
});
