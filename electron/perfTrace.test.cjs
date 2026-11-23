"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPerfTrace } = require("./perfTrace.cjs");

function fakeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
  };
}

function captureTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    pending,
  };
}

test("perfTrace is a no-op unless NETCATTY_PERF_TRACE=1", () => {
  const timers = captureTimers();
  const trace = createPerfTrace({ env: {}, setTimer: timers.setTimer });
  trace.mark("main:entry");
  trace.noteRendererReady({ app: {}, webContents: {} });
  assert.equal(trace.isEnabled(), false);
  assert.deepEqual(trace.getMarks(), {});
  assert.equal(timers.pending.length, 0);
});

test("perfTrace keeps only the first occurrence of each mark", () => {
  const clock = fakeClock();
  const trace = createPerfTrace({ env: { NETCATTY_PERF_TRACE: "1" }, now: clock.now, uptimeSeconds: () => 0.5 });
  trace.mark("main:entry");
  clock.advance(25);
  trace.mark("main:entry");
  trace.mark("main:when-ready");
  assert.deepEqual(trace.getMarks(), { "main:entry": 1_000, "main:when-ready": 1_025 });
});

test("perfTrace writes one report after the first renderer-ready and quits when asked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-perf-trace-"));
  const outputFile = path.join(dir, "trace.json");
  const timers = captureTimers();
  const trace = createPerfTrace({
    env: {
      NETCATTY_PERF_TRACE: "1",
      NETCATTY_PERF_TRACE_FILE: outputFile,
      NETCATTY_PERF_TRACE_EXIT: "1",
      NETCATTY_PERF_TRACE_SETTLE_MS: "50",
    },
    now: fakeClock(5_000).now,
    uptimeSeconds: () => 2,
    setTimer: timers.setTimer,
  });
  let quitCalls = 0;
  const app = {
    getAppMetrics: () => [{ type: "Browser", memory: { workingSetSize: 2048, privateBytes: 1024 } }],
    getPath: () => dir,
    quit: () => { quitCalls += 1; },
  };
  const webContents = {
    executeJavaScript: async () => ({ marks: [{ name: "netcatty:renderer:ready", at: 5_400 }] }),
  };

  trace.mark("main:entry");
  trace.noteRendererReady({ app, webContents });
  trace.noteRendererReady({ app, webContents });
  assert.equal(timers.pending.length, 1, "only the first renderer-ready schedules a report");
  assert.equal(timers.pending[0].ms, 50);

  await timers.pending[0].fn();
  const report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(report.processStartAt, 3_000);
  assert.equal(report.main["main:entry"], 5_000);
  assert.equal(report.main["main:renderer-ready"], 5_000);
  assert.deepEqual(report.renderer.marks, [{ name: "netcatty:renderer:ready", at: 5_400 }]);
  assert.deepEqual(report.processes, [{ type: "Browser", workingSetKB: 2048, privateKB: 1024 }]);
  assert.equal(quitCalls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
