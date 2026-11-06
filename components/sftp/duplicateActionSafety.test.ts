/** @test issue #4132 — the tree's ".." row must not be offered as a Duplicate target */
import assert from "node:assert/strict";
import test from "node:test";
import { isSftpTreeParentEntry } from "./useSftpPaneTreeContextMenu.tsx";

test("only the synthetic parent row is treated as a navigation entry", () => {
  assert.equal(isSftpTreeParentEntry({ name: ".." }), true);
  assert.equal(isSftpTreeParentEntry({ name: "." }), false);
  assert.equal(isSftpTreeParentEntry({ name: "docs" }), false);
  assert.equal(isSftpTreeParentEntry({ name: "..hidden" }), false);
});
