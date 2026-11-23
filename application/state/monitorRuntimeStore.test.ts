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

test("idle runtime polls do not notify subscribers until something changes", async () => {
  const React = await import("react");
  const { act, create } = await import("react-test-renderer");
  const { useMonitorSnapshot } = await import("./monitorRuntimeStore");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const idle = (takenAt: number): MonitorSnapshot => ({
    historyMode: "replace",
    runtimeId: "idle-poll-test",
    epoch: 7,
    takenAt,
    running: [],
    count: 0,
    hostCount: 0,
    activeSessions: [],
    startedAt: {},
    hosts: {},
  });
  let renders = 0;
  function Probe() {
    useMonitorSnapshot();
    renders += 1;
    return null;
  }
  // Later than anything earlier tests published, so this baseline wins.
  const base = 1_000_000_000;
  publishMonitorSnapshot(idle(base));
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Probe));
  });
  const baseline = renders;
  act(() => {
    for (let at = base + 1000; at <= base + 5000; at += 1000) publishMonitorSnapshot(idle(at));
  });
  assert.equal(renders, baseline, "unchanged idle replies must not re-render subscribers");
  act(() => {
    publishMonitorSnapshot({ ...idle(base + 6000), running: ["panel"], count: 1 });
  });
  assert.equal(renders, baseline + 1, "a real change still notifies");
  act(() => renderer.unmount());
});
