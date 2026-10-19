import test from "node:test";
import assert from "node:assert/strict";
import { buildMonitorTrendGeometry, findMonitorChartPoint } from "./monitorChart";
import type { MonitorPoint } from "./monitorRuntime";

const points: MonitorPoint[] = [
  { at: 1000, cpu: 12.5, memory: 40.123, disk: null, rx: null, tx: null },
  { at: 2000, cpu: null, memory: 50, disk: null, rx: null, tx: null },
  { at: 3000, cpu: 80, memory: null, disk: null, rx: null, tx: null },
];
test("chart hit testing returns the exact sampled value and timestamp", () => {
  assert.equal(findMonitorChartPoint(points, "cpu", 2900, 300), points[2]);
  assert.equal(findMonitorChartPoint(points, "memory", 1100, 300), points[0]);
});
test("chart hit testing does not fabricate readings in missing or distant history", () => {
  assert.equal(findMonitorChartPoint(points, "cpu", 2000, 300), null);
  assert.equal(findMonitorChartPoint(points, "cpu", -5000, 300), null);
  assert.equal(findMonitorChartPoint([], "cpu", 1000, 300), null);
});

test("full histories fit the chart budget while extrema and raw hover samples survive", () => {
  const end = 1800000;
  const samples = Array.from({ length: 1800 }, (_, i) => ({ ...points[0], at: (i + 1) * 1000, cpu: 50 }));
  samples[700].cpu = 100;
  samples[701].cpu = 0;
  const geometry = buildMonitorTrendGeometry(samples, "cpu", 30, 1, end);
  assert.equal(geometry.segments.length, 1);
  const path = geometry.segments[0].path;
  assert.ok(path.split(/ [ML] /).length <= 302);
  assert.ok(path.includes(" 4.00"));
  assert.ok(path.includes(" 58.00"));
  assert.equal(geometry.visible.length, 1800);
  assert.equal(findMonitorChartPoint(geometry.visible, "cpu", samples[699].at, 0), samples[699]);
  assert.equal(samples.length, 1800);
});

test("chart reduction preserves missing samples and cadence gaps", () => {
  const geometry = buildMonitorTrendGeometry([
    ...points,
    { ...points[0], at: 20000 },
    { ...points[0], at: 21000, cpu: Infinity },
    { ...points[0], at: 22000 },
  ], "cpu", 1, 1, 22000);
  assert.equal(geometry.segments.length, 4);
  assert.ok(geometry.segments.every((segment) => !segment.path.includes(" L ")));
});
