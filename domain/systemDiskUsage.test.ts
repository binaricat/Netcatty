import assert from "node:assert/strict";
import test from "node:test";

import { aggregateMountedDiskUsage } from "./systemDiskUsage.ts";

test("aggregateMountedDiskUsage totals every mounted disk", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { mountPoint: "/", used: 20, total: 100 },
      { mountPoint: "/data", used: 60, total: 300 },
    ]),
    { used: 80, total: 400, percent: 20 },
  );
});

test("aggregateMountedDiskUsage ignores unusable disk rows", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { mountPoint: "/", used: 25, total: 100 },
      { mountPoint: "/missing", used: Number.NaN, total: 20 },
      { mountPoint: "/zero", used: 0, total: 0 },
    ]),
    { used: 25, total: 100, percent: 25 },
  );
  assert.equal(aggregateMountedDiskUsage([]), null);
});
