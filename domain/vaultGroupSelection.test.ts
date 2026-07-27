import assert from "node:assert/strict";
import test from "node:test";

import {
  collectVaultGroupPathsForSelectAll,
  retainVisibleVaultGroupSelection,
  collectVisibleVaultGroupPaths,
  collectVisibleVaultHostIds,
} from "./vaultGroupSelection.ts";

test("tree selection collects only groups present in the filtered tree", () => {
  const paths = collectVisibleVaultGroupPaths([{
    path: "Visible",
    children: {
      child: { path: "Visible/Child", children: {} },
    },
  }]);

  assert.deepEqual(paths, ["Visible", "Visible/Child"]);
  assert.equal(paths.includes("Hidden"), false);
});

test("tree select-all uses tree hosts while grid and list use displayed hosts", () => {
  const displayedHosts = [{ id: "group-only" }];
  const treeHosts = [{ id: "all-a" }, { id: "all-b" }];

  assert.deepEqual(collectVisibleVaultHostIds({
    viewMode: "tree",
    displayedHosts,
    treeHosts,
  }), ["all-a", "all-b"]);
  assert.deepEqual(collectVisibleVaultHostIds({
    viewMode: "list",
    displayedHosts,
    treeHosts,
  }), ["group-only"]);
});

test("filtered select-all never selects whole groups with hidden hosts", () => {
  assert.deepEqual(collectVaultGroupPathsForSelectAll({
    hasActiveFilters: true,
    viewMode: "grid",
    displayedGroupPaths: ["Production", "Staging"],
    visibleTreeGroupPaths: ["Production"],
  }), []);
  assert.deepEqual(collectVaultGroupPathsForSelectAll({
    hasActiveFilters: false,
    viewMode: "tree",
    displayedGroupPaths: ["Production", "Staging"],
    visibleTreeGroupPaths: ["Production"],
  }), ["Production"]);
});

test("group selection drops groups hidden by navigation or filters", () => {
  assert.deepEqual(
    retainVisibleVaultGroupSelection(
      new Set(["visible", "hidden"]),
      new Set(["visible", "new"]),
    ),
    new Set(["visible"]),
  );
});
