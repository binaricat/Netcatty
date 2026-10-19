import assert from "node:assert/strict";
import test from "node:test";
import { mergeMonitorSnapshotHistory, monitorStateSince, type MonitorHostState, type MonitorSnapshot } from "./monitorRuntime";

const state: MonitorHostState = {
  historyId: "endpoint-a",
  status: "live", at: 2000, stats: {
    cpu: 50, cpuCores: 4, cpuPerCore: [], memTotal: 100, memUsed: 25,
    memFree: 75, memBuffers: 0, memCached: 0, swapTotal: 0, swapUsed: 0,
    topProcesses: [], diskPercent: 30, diskUsed: 30, diskTotal: 100, disks: [],
    netRxSpeed: 10, netTxSpeed: 20, latencyMs: 1, netInterfaces: [],
  },
  points: [1000, 2000].map((at) => ({ at, cpu: 50, memory: 25, disk: 30, rx: 10, tx: 20 })),
};
test("starting or changing cadence clears all old readings and chart fields", () => {
  const cleared = monitorStateSince(state, 2000)!;
  assert.deepEqual(cleared.points, []);
  assert.equal(cleared.stats, null);
  assert.equal(cleared.at, 0);
  assert.equal(cleared.status, "queued");
  assert.equal(monitorStateSince(state, undefined), undefined);
});
test("only current-run readings are visible without mutating shared history", () => {
  const fresh = monitorStateSince(state, 1500)!;
  assert.deepEqual(fresh.points.map((p) => p.at), [2000]);
  assert.equal(fresh.stats, state.stats);
  assert.equal(fresh.status, "live");
  assert.equal(monitorStateSince({ ...state, status: "unsupported" }, 2000)?.status, "unsupported");
  assert.equal(monitorStateSince(state, 0)?.points.length, 2);
  assert.equal(state.points.length, 2);
  assert.equal(monitorStateSince(state, 1500)?.points, fresh.points);
  assert.equal(monitorStateSince({ ...state }, 1500)?.points, fresh.points);
  assert.notEqual(monitorStateSince(state, 1000)?.points, fresh.points);
});

const snapshot = (host: MonitorHostState): MonitorSnapshot => ({
  historyMode: "replace", runtimeId: "worker", epoch: 0, takenAt: 3000,
  running: ["p"], startedAt: { p: 0 }, count: 1, hostCount: 1, activeSessions: [], hosts: { h: host },
});
test("incremental snapshots retain history, deduplicate races and replace on worker reset", () => {
  const original = snapshot(state);
  const point = { ...state.points[1], at: 3000 };
  const delta: MonitorSnapshot = { ...snapshot({ ...state, points: [state.points[1], point] }), historyMode: "append", takenAt: 4000 };
  const merged = mergeMonitorSnapshotHistory(original, delta);
  assert.deepEqual(merged.hosts.h.points.map((point) => point.at), [1000, 2000, 3000]);
  assert.deepEqual(mergeMonitorSnapshotHistory(merged, delta).hosts.h.points, merged.hosts.h.points);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...original, takenAt: 2000 }), merged);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...delta, epoch: 1 }).hosts.h.points.length, 2);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...delta, historyMode: "replace" }).hosts.h.points.length, 2);
  assert.equal(original.hosts.h.points.length, 2);
});
test("incremental history expires after thirty minutes and remains bounded", () => {
  const points = Array.from({ length: 1800 }, (_, i) => ({ ...state.points[0], at: 10000 + i * 1000 }));
  const previous = snapshot({ ...state, points });
  const next = { ...snapshot({ ...state, points: [{ ...points.at(-1)!, at: 1810000 }] }), historyMode: "append" as const, takenAt: 1810000 };
  const merged = mergeMonitorSnapshotHistory(previous, next);
  assert.equal(merged.hosts.h.points.length, 1800);
  assert.equal(merged.hosts.h.points[0].at, 11000);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...next, takenAt: 4000000 }).hosts.h.points.length, 0);
});

test("delayed replies cannot restore a stopped epoch or retired worker", () => {
  const stopped: MonitorSnapshot = { ...snapshot(state), epoch: 1, takenAt: 4000, running: [], hosts: {}, startedAt: {} };
  const old = { ...snapshot(state), historyMode: "append" as const };
  assert.equal(mergeMonitorSnapshotHistory(stopped, old), stopped);
  assert.equal(mergeMonitorSnapshotHistory(stopped, { ...old, takenAt: 5000 }), stopped);
  const restarted = { ...stopped, runtimeId: "new-worker", epoch: 0 };
  assert.equal(mergeMonitorSnapshotHistory(restarted, old), restarted);
  const fresh = { ...restarted, runtimeId: "next-worker", takenAt: 5000 };
  assert.equal(mergeMonitorSnapshotHistory(restarted, fresh), fresh);
});

test("a new endpoint replaces retained points even when its first delta races a configuration response", () => {
  const original = snapshot(state);
  const changed: MonitorSnapshot = { ...snapshot({ ...state, historyId: "endpoint-b", points: [{ ...state.points[0], at: 2500 }] }), historyMode: "append", takenAt: 4000 };
  const merged = mergeMonitorSnapshotHistory(original, changed);
  assert.deepEqual(merged.hosts.h.points.map((point) => point.at), [2500]);
  assert.equal(merged.hosts.h.historyId, "endpoint-b");
});

test("unchanged stats are retained by reference while fresh, cleared and new-endpoint stats replace them", () => {
  const previous = snapshot(state);
  const delta = { ...snapshot({ ...state, stats: undefined, points: [] }), historyMode: "append" as const, takenAt: 4000 };
  const merged = mergeMonitorSnapshotHistory(previous, delta);
  assert.equal(merged.hosts.h.stats, state.stats);
  assert.equal(merged.hosts.h.points, state.points);
  assert.equal(monitorStateSince(merged.hosts.h, 0), merged.hosts.h);
  assert.deepEqual(merged.hosts.h.points, state.points);
  const fresh = { ...state.stats!, cpu: 67 };
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...delta, hosts: { h: { ...state, stats: fresh, points: [] } } }).hosts.h.stats, fresh);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...delta, hosts: { h: { ...state, stats: null, points: [] } } }).hosts.h.stats, null);
  assert.equal(mergeMonitorSnapshotHistory(merged, { ...delta, hosts: { h: { ...state, historyId: "endpoint-b", stats: null, points: [] } } }).hosts.h.stats, null);
});
