import assert from "node:assert/strict";
import test from "node:test";

import {
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
