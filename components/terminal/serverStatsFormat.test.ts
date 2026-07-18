import test from "node:test";
import assert from "node:assert/strict";

import { formatDiskCapacityGb } from "./serverStatsFormat.ts";

test("disk capacity uses at most two decimal places", () => {
  assert.equal(formatDiskCapacityGb(5.964138), "5.96");
  assert.equal(formatDiskCapacityGb(28.893616), "28.89");
  assert.equal(formatDiskCapacityGb(0.005907), "0.01");
  assert.equal(formatDiskCapacityGb(10), "10");
  assert.equal(formatDiskCapacityGb(10.5), "10.5");
});
