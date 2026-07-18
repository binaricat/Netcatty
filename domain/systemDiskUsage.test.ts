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
      { mountPoint: "/invalid", used: 21, total: 20 },
    ]),
    { used: 25, total: 100, percent: 25 },
  );
  assert.equal(aggregateMountedDiskUsage([]), null);
});

test("aggregateMountedDiskUsage counts a repeated filesystem only once", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { filesystem: "/dev/sda1", mountPoint: "/", used: 20, total: 100 },
      { filesystem: "/dev/sda1", mountPoint: "/bind-root", used: 20, total: 100 },
      { filesystem: "/dev/sdb1", mountPoint: "/data", used: 60, total: 300 },
    ]),
    { used: 80, total: 400, percent: 20 },
  );
});

test("aggregateMountedDiskUsage preserves fractional capacity until display formatting", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { filesystem: "/dev/sda1", mountPoint: "/", used: 0.125, total: 0.5 },
      { filesystem: "/dev/sdb1", mountPoint: "/data", used: 0.25, total: 1.5 },
    ]),
    { used: 0.375, total: 2, percent: 18.75 },
  );
});
