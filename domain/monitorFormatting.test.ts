import test from "node:test";
import assert from "node:assert/strict";
import { formatMonitorRate } from "./monitorFormatting";

test("disk and network rates adapt to decimal KB/MB/GB units", () => {
  for (const [value, expected] of [
    [0, "0.0 KB/s"], [500, "0.5 KB/s"], [1000, "1.0 KB/s"],
    [999000, "999.0 KB/s"], [1e6, "1.0 MB/s"], [2.5e6, "2.5 MB/s"],
    [1e9, "1.0 GB/s"], [12e9, "12.0 GB/s"],
  ] as const) assert.equal(formatMonitorRate(value), expected);
  for (const value of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(formatMonitorRate(value), "--");
  }
});
