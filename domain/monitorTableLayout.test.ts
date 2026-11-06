import test from "node:test";
import assert from "node:assert/strict";
import {
  MONITOR_COLUMNS,
  clampMonitorColumnWidth,
  normalizeMonitorColumnWidths,
  normalizeMonitorHiddenColumns,
  monitorGridColumns,
} from "./monitorTableLayout";

test("saved column sizes cannot hide data or create unbounded table widths", () => {
  const widths = normalizeMonitorColumnWidths({
    host: -1,
    latency: Infinity,
    notes: 100000,
    terminal: NaN,
    unknown: 400,
  });
  assert.equal(widths.host, 160);
  assert.equal(widths.latency, 90);
  assert.equal(widths.notes, 640);
  assert.equal(widths.terminal, 56);
  assert.equal(Object.keys(widths).length, MONITOR_COLUMNS.length);
  assert.deepEqual(
    normalizeMonitorColumnWidths(null),
    normalizeMonitorColumnWidths({}),
  );
  for (const column of MONITOR_COLUMNS) {
    assert.equal(clampMonitorColumnWidth(column.key, -100), column.min);
    assert.equal(
      clampMonitorColumnWidth(column.key, 10000),
      column.key === "terminal" ? 200 : 640,
    );
  }
});
test("virtual card rows adapt to narrow panes and do not allocate empty columns", () => {
  assert.equal(monitorGridColumns(200, 1000), 1);
  assert.equal(monitorGridColumns(575, 1000), 1);
  assert.equal(monitorGridColumns(576, 1000), 2);
  assert.equal(monitorGridColumns(1248, 1000), 4);
  assert.equal(monitorGridColumns(1248, 2), 2);
  assert.equal(monitorGridColumns(0, 1000), 1);
});

test("old saved layouts gain a resizable disk I/O column after disk capacity", () => {
  const keys = MONITOR_COLUMNS.map(column => column.key);
  assert.equal(keys[keys.indexOf("disks") + 1], "diskIo");
  const widths = normalizeMonitorColumnWidths({ disks: 280, network: 170 });
  assert.equal(widths.disks, 280);
  assert.equal(widths.network, 170);
  assert.equal(widths.diskIo, 230);
  assert.deepEqual(normalizeMonitorHiddenColumns(["diskIo"]), ["diskIo"]);
});

test("hidden columns always preserve host and terminal and discard unknown settings", () => {
  assert.deepEqual(
    normalizeMonitorHiddenColumns([
      "host",
      "terminal",
      "cpu",
      "cpu",
      "unknown",
      "status",
    ]),
    ["cpu", "status"],
  );
  assert.deepEqual(normalizeMonitorHiddenColumns(null), []);
  assert.deepEqual(normalizeMonitorHiddenColumns({ cpu: true }), []);
  assert.equal(
    normalizeMonitorHiddenColumns(MONITOR_COLUMNS.map((c) => c.key)).length,
    MONITOR_COLUMNS.length - 2,
  );
});
