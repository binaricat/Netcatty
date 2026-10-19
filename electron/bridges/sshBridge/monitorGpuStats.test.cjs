"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  startMonitorGpuProbe,
  withCachedMonitorGpu,
  cacheFullGpuStats,
  cancelMonitorGpuProbe,
} = require("./monitorGpuStats.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function stream() {
  const s = new EventEmitter();
  s.stderr = new EventEmitter();
  s.close = () => {};
  s.destroy = () => {};
  return s;
}
const sample = { success: true, stats: { cpu: 12, memTotal: 4096, gpu: null } };
test("GPU work is coalesced, cached independently, and never changes CPU readings", async (t) => {
  let now = 100000,
    calls = 0,
    current;
  t.mock.method(Date, "now", () => now);
  const conn = {
    exec(_command, cb) {
      calls++;
      current = stream();
      cb(null, current);
    },
  };
  t.after(() => cancelMonitorGpuProbe(conn));
  startMonitorGpuProbe(conn, "gpu");
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  assert.equal(calls, 1);
  assert.equal(withCachedMonitorGpu(conn, sample).stats.cpu, 12);
  assert.equal(withCachedMonitorGpu(conn, sample).stats.gpu, null);
  current.emit("data", Buffer.from("GPU:75 1024 8192 NVIDIA T4"));
  current.emit("close", 0);
  await tick();
  assert.equal(withCachedMonitorGpu(conn, sample).stats.gpu, 75);
  assert.equal(withCachedMonitorGpu(conn, sample).stats.gpuName, "NVIDIA T4");
  now += 9999;
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  assert.equal(calls, 1);
  now += 1;
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  assert.equal(calls, 2);
  current.emit("close", 0);
  await tick();
  assert.equal(withCachedMonitorGpu(conn, sample).stats.gpu, null);
  now += 29000;
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  assert.equal(calls, 2, "missing GPU probes back off");
});
test("cancelling optional GPU work preserves a full reader cache and ignores late results", async (t) => {
  let current;
  const conn = {
    exec(_command, cb) {
      current = stream();
      cb(null, current);
    },
  };
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  cacheFullGpuStats(conn, {
    gpu: 42,
    gpuName: "NVIDIA full",
    gpuMemUsed: 512,
    gpuMemTotal: 8192,
  });
  current.emit("data", Buffer.from("GPU:99 1 2 NVIDIA late"));
  current.emit("close", 0);
  await tick();
  assert.equal(withCachedMonitorGpu(conn, sample).stats.gpu, 42);
  assert.equal(withCachedMonitorGpu(conn, sample).stats.cpu, 12);
  cancelMonitorGpuProbe(conn);
  t.after(() => cancelMonitorGpuProbe(conn));
});

test("monitor snapshots include cached GPU without adding history samples or changing sample time", async () => {
  const { sampleSharedStats, readSharedStats } = require("./sharedStats.cjs");
  const conn = {};
  await sampleSharedStats({ conn, _monitorStats: true }, async () => sample);
  const before = readSharedStats(conn);
  cacheFullGpuStats(conn, {
    gpu: 42,
    gpuName: "NVIDIA cached",
    gpuMemUsed: 1,
    gpuMemTotal: 2,
  });
  const after = readSharedStats(conn);
  assert.equal(after.result.stats.gpu, 42);
  assert.equal(after.result.stats.cpu, 12);
  assert.equal(after.at, before.at);
  assert.deepEqual(after.points, before.points);
});
test("stopping GPU work before channel-open closes the late channel without disconnecting SSH", async () => {
  let callback,
    closed = 0,
    disconnected = 0;
  const conn = {
    exec(_command, cb) {
      callback = cb;
    },
    end() {
      disconnected++;
    },
  };
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  require("./sharedStats.cjs").cancelSharedStats(conn);
  const late = stream();
  late.close = () => closed++;
  callback(null, late);
  await tick();
  assert.ok(closed > 0);
  assert.equal(disconnected, 0);
});

test("optional GPU channel-open timeout neither disconnects SSH nor stacks repeated open requests", async () => {
  let callback,
    fireTimer,
    calls = 0,
    disconnected = 0,
    closed = 0;
  const conn = {
    exec(_command, cb) {
      calls++;
      callback = cb;
    },
    end() {
      disconnected++;
    },
    destroy() {
      disconnected++;
    },
  };
  startMonitorGpuProbe(conn, "gpu", {
    setTimeoutFn: (fn) => {
      fireTimer = fn;
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  await tick();
  fireTimer();
  await tick();
  assert.equal(
    disconnected,
    0,
    "optional channel timeout must leave the shared transport intact",
  );
  startMonitorGpuProbe(conn, "gpu");
  await tick();
  assert.equal(calls, 1, "one unresolved GPU open per transport at most");
  const late = stream();
  late.close = () => closed++;
  callback(null, late);
  await tick();
  assert.ok(closed > 0);
});
