"use strict";

/**
 * Opt-in startup timeline used by scripts/perf-startup.live.cjs.
 *
 * Disabled unless NETCATTY_PERF_TRACE=1: every export is then a cheap no-op,
 * so production startup is unaffected. When enabled, the first occurrence of
 * each mark is recorded as epoch milliseconds (performance.timeOrigin based,
 * comparable with the renderer's own marks). After the first renderer-ready
 * signal plus a settle delay, the main-window renderer timeline and process
 * metrics are written to NETCATTY_PERF_TRACE_FILE (default:
 * <userData>/perf-trace.json); NETCATTY_PERF_TRACE_EXIT=1 then quits the app.
 */

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const DEFAULT_SETTLE_MS = 3000;

function createPerfTrace({
  env = process.env,
  now = () => performance.timeOrigin + performance.now(),
  uptimeSeconds = () => process.uptime(),
  setTimer = setTimeout,
} = {}) {
  const enabled = env.NETCATTY_PERF_TRACE === "1";
  const processStartAt = now() - uptimeSeconds() * 1000;
  const marks = new Map();
  let reportScheduled = false;

  function mark(name) {
    if (!enabled || marks.has(name)) return;
    marks.set(name, now());
  }

  function getMarks() {
    return Object.fromEntries(marks);
  }

  function resolveSettleMs() {
    const parsed = Number(env.NETCATTY_PERF_TRACE_SETTLE_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTLE_MS;
  }

  async function collectRendererTimeline(webContents) {
    try {
      return await webContents.executeJavaScript(`(() => {
        const origin = performance.timeOrigin;
        const nav = performance.getEntriesByType("navigation")[0];
        return {
          timeOrigin: origin,
          navigation: nav ? {
            responseEnd: origin + nav.responseEnd,
            domInteractive: origin + nav.domInteractive,
            domContentLoaded: origin + nav.domContentLoadedEventEnd,
            load: origin + nav.loadEventEnd,
          } : null,
          marks: performance.getEntriesByType("mark")
            .filter((entry) => entry.name.startsWith("netcatty:"))
            .map((entry) => ({ name: entry.name, at: origin + entry.startTime })),
          paint: performance.getEntriesByType("paint")
            .map((entry) => ({ name: entry.name, at: origin + entry.startTime })),
          heap: performance.memory ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
          } : null,
        };
      })()`);
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }

  function collectProcessMetrics(app) {
    try {
      return app.getAppMetrics().map((metric) => ({
        type: metric.type,
        workingSetKB: metric.memory?.workingSetSize ?? null,
        privateKB: metric.memory?.privateBytes ?? null,
      }));
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }

  /**
   * Called for every renderer-ready IPC. Only the first one (the startup main
   * window) schedules the report.
   */
  function noteRendererReady({ app, webContents }) {
    if (!enabled) return;
    mark("main:renderer-ready");
    if (reportScheduled || !webContents) return;
    reportScheduled = true;
    setTimer(async () => {
      const report = {
        version: 1,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        processStartAt,
        main: getMarks(),
        renderer: await collectRendererTimeline(webContents),
        processes: collectProcessMetrics(app),
        mainHeapUsedBytes: process.memoryUsage().heapUsed,
      };
      const outputFile = env.NETCATTY_PERF_TRACE_FILE
        || path.join(app.getPath("userData"), "perf-trace.json");
      try {
        fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
      } catch (error) {
        console.warn("[PerfTrace] Failed to write report:", error?.message || error);
      }
      if (env.NETCATTY_PERF_TRACE_EXIT === "1") app.quit();
    }, resolveSettleMs());
  }

  return {
    isEnabled: () => enabled,
    mark,
    getMarks,
    noteRendererReady,
  };
}

module.exports = {
  createPerfTrace,
  ...createPerfTrace(),
};
