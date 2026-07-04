import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemManagerTabs } from "./systemTarget.ts";

test("system manager shows overview before detailed management tabs", () => {
  assert.deepEqual(buildSystemManagerTabs(null, undefined, null), ["overview", "processes"]);
});
