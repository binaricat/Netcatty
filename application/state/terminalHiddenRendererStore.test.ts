import assert from "node:assert/strict";
import test from "node:test";

import { terminalHiddenRendererStore } from "./terminalHiddenRendererStore.ts";

test("terminalHiddenRendererStore evicts oldest soft-hidden session", () => {
  terminalHiddenRendererStore.clearSoftHidden("a");
  terminalHiddenRendererStore.clearSoftHidden("b");
  terminalHiddenRendererStore.markSoftHidden("a");
  terminalHiddenRendererStore.markSoftHidden("b");
  assert.equal(terminalHiddenRendererStore.pickEvictionCandidate(2), "a");
  terminalHiddenRendererStore.clearSoftHidden("a");
  terminalHiddenRendererStore.clearSoftHidden("b");
});
