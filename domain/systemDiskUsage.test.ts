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
      { mountPoint: "/invalid", used: -1, total: 20 },
    ]),
    { used: 25, total: 100, percent: 25 },
  );
  assert.equal(aggregateMountedDiskUsage([]), null);
});

test("aggregateMountedDiskUsage counts a repeated capacity group only once", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { capacityKey: "/dev/sda1", mountPoint: "/", used: 20, total: 100 },
      { capacityKey: "/dev/sda1", mountPoint: "/bind-root", used: 20, total: 100 },
      { capacityKey: "/dev/sdb1", mountPoint: "/data", used: 60, total: 300 },
    ]),
    { used: 80, total: 400, percent: 20 },
  );
});

test("aggregateMountedDiskUsage preserves fractional capacity until display formatting", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { capacityKey: "/dev/sda1", mountPoint: "/", used: 0.125, total: 0.5 },
      { capacityKey: "/dev/sdb1", mountPoint: "/data", used: 0.25, total: 1.5 },
    ]),
    { used: 0.375, total: 2, percent: 18.75 },
  );
});

test("aggregateMountedDiskUsage counts shared APFS container capacity once", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { capacityKey: "apfs:/dev/disk3", mountPoint: "/Volumes/One", used: 40, total: 500 },
      { capacityKey: "apfs:/dev/disk3", mountPoint: "/Volumes/Two", used: 90, total: 500 },
    ]),
    { used: 90, total: 500, percent: 18 },
  );
});

test("aggregateMountedDiskUsage includes an overfull filesystem", () => {
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { capacityKey: "/dev/sda1", mountPoint: "/", used: 110, total: 100 },
      { capacityKey: "/dev/sdb1", mountPoint: "/data", used: 25, total: 100 },
    ]),
    { used: 135, total: 200, percent: 67.5 },
  );
  assert.deepEqual(
    aggregateMountedDiskUsage([
      { capacityKey: "/dev/sda1", mountPoint: "/", used: 110, total: 100 },
    ]),
    { used: 110, total: 100, percent: 100 },
  );
});
