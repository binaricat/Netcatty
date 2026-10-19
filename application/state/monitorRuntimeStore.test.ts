import test from "node:test";
import assert from "node:assert/strict";
import {
  publishMonitorSnapshot,
  getMonitorHistoryCursor,
} from "./monitorRuntimeStore";
import type { MonitorSnapshot } from "../../domain/monitorRuntime";

test("renderer cursor acknowledges GPU publication separately from CPU sample and history", () => {
  const snapshot: MonitorSnapshot = {
    historyMode: "replace",
    runtimeId: "gpu-cursor-test",
    epoch: 1,
    takenAt: 1000,
    running: ["panel"],
    count: 1,
    hostCount: 1,
    activeSessions: [],
    startedAt: { panel: 0 },
    hosts: {
      host: {
        historyId: "history",
        status: "live",
        at: 1000,
        statsAt: 1001,
        points: [
          { at: 1000, cpu: 10, memory: 20, disk: null, rx: null, tx: null },
        ],
      },
    },
  };
  publishMonitorSnapshot(snapshot);
  assert.deepEqual(getMonitorHistoryCursor().after.host, {
    at: 1000,
    statsAt: 1001,
    historyId: "history",
  });
  publishMonitorSnapshot({
    ...snapshot,
    historyMode: "append",
    takenAt: 2000,
    hosts: { host: { ...snapshot.hosts.host, statsAt: 2001, points: [] } },
  });
  assert.deepEqual(getMonitorHistoryCursor().after.host, {
    at: 1000,
    statsAt: 2001,
    historyId: "history",
  });
});
