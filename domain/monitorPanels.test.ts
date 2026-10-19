import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMonitorPanels,
  rebaseMonitorPanel,
  type MonitorPanel,
  MONITOR_INTERVALS,
  reorderMonitorHosts,
} from "./monitorPanels";
import { mergeSyncPayloads } from "./syncMerge";
import type { SyncPayload } from "./sync";
import {
  applyLegacySyncPayload,
  createConvergentSyncState,
  materializeSyncPayloadFromConvergentState,
  mergeConvergentSyncStates,
} from "./convergentSync";
const panel: MonitorPanel = {
  id: "p1",
  name: "Production",
  description: "",
  hostIds: ["h2", "h1"],
  view: "charts",
  interval: 10,
  range: 15,
  sort: "manual",
};
const payload = (panels?: MonitorPanel[]): SyncPayload => ({
  hosts: [],
  keys: [],
  snippets: [],
  customGroups: [],
  syncedAt: 1,
  ...(panels === undefined ? {} : { monitorPanels: panels }),
});
test("drag ordering moves either direction without mutating saved references", () => {
  const saved = ["c", "a", "b", "hidden"];
  assert.deepEqual(reorderMonitorHosts(saved, "c", "b"), ["a", "b", "c", "hidden"]);
  assert.deepEqual(reorderMonitorHosts(saved, "b", "c"), ["b", "c", "a", "hidden"]);
  assert.deepEqual(saved, ["c", "a", "b", "hidden"]);
  assert.equal(reorderMonitorHosts(saved, "missing", "b"), saved);
  assert.equal(reorderMonitorHosts(saved, "a", "a"), saved);
});
test("monitor intervals include each supported cadence and default to five seconds", () => {
  assert.deepEqual(MONITOR_INTERVALS, [1, 2, 3, 5, 10, 30, 60]);
  for (const interval of MONITOR_INTERVALS)
    assert.equal(normalizeMonitorPanels([{ ...panel, interval }])[0].interval, interval);
  assert.equal(normalizeMonitorPanels([{ ...panel, interval: undefined }])[0].interval, 5);
});
test("portable panel sanitizer strips all runtime data and preserves ordered references", () => {
  const clean = normalizeMonitorPanels([
    {
      ...panel,
      hostIds: ["h2", "h1", "h2"],
      stats: { cpu: 42 },
      points: [1],
      running: true,
      error: "secret",
    },
  ]);
  assert.deepEqual(clean, [panel]);
  assert.equal(JSON.stringify(clean).includes("secret"), false);
});
test("concurrent local edits preserve unrelated fields and deletion does not resurrect", () => {
  const renamed = { ...panel, name: "New name" };
  const changed = { ...panel, view: "list" as const, hostIds: ["h3", "h2"] };
  assert.deepEqual(rebaseMonitorPanel([renamed], panel, changed), [
    { ...renamed, ...changed, name: renamed.name },
  ]);
  assert.throws(() => rebaseMonitorPanel([], panel, changed), /deleted/);
  assert.throws(
    () => rebaseMonitorPanel([panel], null, { ...panel, id: "p2" }),
    /duplicateName/,
  );
});
test("three-way sync merges panel fields, preserves legacy omission and propagates deletion", () => {
  const base = payload([panel]);
  const local = payload([{ ...panel, name: "Renamed" }]);
  const remote = payload([{ ...panel, hostIds: ["h3"], view: "list" }]);
  assert.deepEqual(
    mergeSyncPayloads(base, local, remote).payload.monitorPanels,
    [{ ...panel, name: "Renamed", hostIds: ["h3"], view: "list" }],
  );
  assert.deepEqual(
    mergeSyncPayloads(base, base, payload()).payload.monitorPanels,
    [panel],
  );
  assert.deepEqual(
    mergeSyncPayloads(base, base, payload([])).payload.monitorPanels,
    [],
  );
});
test("convergent replica carries panel creation, edits and deletion", () => {
  const empty = payload([]),
    initial = payload([panel]);
  const state = applyLegacySyncPayload(
    createConvergentSyncState(),
    empty,
    initial,
    "a",
    1,
  );
  const left = applyLegacySyncPayload(
    state,
    initial,
    payload([{ ...panel, name: "A" }]),
    "a",
    2,
  );
  const right = applyLegacySyncPayload(
    state,
    initial,
    payload([{ ...panel, hostIds: ["h3"], view: "list" }]),
    "b",
    3,
  );
  const joined = mergeConvergentSyncStates(left, right);
  assert.deepEqual(
    materializeSyncPayloadFromConvergentState(joined, { syncedAt: 3 })
      .monitorPanels,
    [{ ...panel, name: "A", hostIds: ["h3"], view: "list" }],
  );
  const removed = applyLegacySyncPayload(
    joined,
    materializeSyncPayloadFromConvergentState(joined, { syncedAt: 3 }),
    empty,
    "a",
    4,
  );
  assert.deepEqual(
    materializeSyncPayloadFromConvergentState(
      mergeConvergentSyncStates(removed, right),
      { syncedAt: 4 },
    ).monitorPanels,
    [],
  );
});

test("independent same-name panels remain distinct after merge/import regardless of order", () => {
  const left = { ...panel, id: "a", name: "Fleet" };
  const right = { ...panel, id: "b", name: "fleet" };
  const existingSuffix = { ...panel, id: "c", name: "Fleet (2)" };
  const normalizeById = (panels: MonitorPanel[]) =>
    normalizeMonitorPanels(panels).sort((a, b) => a.id.localeCompare(b.id));
  const merged = mergeSyncPayloads(
    payload([]),
    payload([left, existingSuffix]),
    payload([right]),
  ).payload.monitorPanels!;
  const clean = normalizeById(merged);
  const empty = payload([]);
  const l = applyLegacySyncPayload(createConvergentSyncState(), empty, payload([left, existingSuffix]), "a", 1);
  const r = applyLegacySyncPayload(createConvergentSyncState(), empty, payload([right]), "b", 1);
  const crdt = materializeSyncPayloadFromConvergentState(mergeConvergentSyncStates(l, r), { syncedAt: 2 });
  assert.deepEqual(normalizeById(crdt.monitorPanels!), clean);
  assert.deepEqual(
    clean.map((p) => [p.id, p.name]),
    [
      ["a", "Fleet"],
      ["b", "fleet (3)"],
      ["c", "Fleet (2)"],
    ],
  );
  assert.deepEqual(normalizeById([...merged].reverse()), clean);
  assert.deepEqual(normalizeById(clean), clean);
  const long = normalizeMonitorPanels([
    left,
    { ...right, name: "x".repeat(120) },
    { ...panel, id: "d", name: "x".repeat(120) },
  ]);
  assert.ok(long.every((p) => p.name.length <= 120));
  assert.equal(new Set(long.map((p) => p.name.toLowerCase())).size, 3);
});
