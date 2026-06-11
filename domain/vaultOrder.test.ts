import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeVaultOrder,
  reorderVaultStrings,
  reorderVaultItems,
  sortByVaultOrder,
} from "./vaultOrder.ts";

type Item = {
  id: string;
  label: string;
  order?: number;
};

const ids = (items: Item[]) => items.map((item) => item.id);

test("normalizeVaultOrder backfills missing order from current array order", () => {
  const ordered = normalizeVaultOrder<Item>([
    { id: "b", label: "Beta" },
    { id: "a", label: "Alpha", order: 2000 },
    { id: "c", label: "Charlie" },
  ]);

  assert.deepEqual(
    ordered.map((item) => item.order),
    [1000, 2000, 3000],
  );
});

test("normalizeVaultOrder preserves existing order values", () => {
  const ordered = normalizeVaultOrder<Item>([
    { id: "b", label: "Beta", order: 2000 },
    { id: "a", label: "Alpha", order: 1000 },
  ]);

  assert.deepEqual(
    ordered.map((item) => [item.id, item.order]),
    [
      ["b", 2000],
      ["a", 1000],
    ],
  );
});

test("sortByVaultOrder uses order before label", () => {
  const ordered = sortByVaultOrder<Item>([
    { id: "alpha", label: "Alpha", order: 3000 },
    { id: "zulu", label: "Zulu", order: 1000 },
    { id: "beta", label: "Beta", order: 2000 },
  ]);

  assert.deepEqual(ids(ordered), ["zulu", "beta", "alpha"]);
});

test("reorderVaultItems moves an item before a target and renumbers", () => {
  const reordered = reorderVaultItems<Item>(
    [
      { id: "a", label: "Alpha", order: 1000 },
      { id: "b", label: "Beta", order: 2000 },
      { id: "c", label: "Charlie", order: 3000 },
    ],
    "c",
    "a",
    "before",
  );

  assert.deepEqual(ids(reordered), ["c", "a", "b"]);
  assert.deepEqual(
    reordered.map((item) => item.order),
    [1000, 2000, 3000],
  );
});

test("reorderVaultItems moves an item after a target", () => {
  const reordered = reorderVaultItems<Item>(
    [
      { id: "a", label: "Alpha", order: 1000 },
      { id: "b", label: "Beta", order: 2000 },
      { id: "c", label: "Charlie", order: 3000 },
    ],
    "a",
    "c",
    "after",
  );

  assert.deepEqual(ids(reordered), ["b", "c", "a"]);
});

test("reorderVaultStrings moves one value around another", () => {
  assert.deepEqual(
    reorderVaultStrings(["ops", "prod", "dev"], "dev", "ops", "before"),
    ["dev", "ops", "prod"],
  );
});
