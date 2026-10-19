import { test } from "node:test";
import assert from "node:assert/strict";
import type { MonitorPanel } from "../domain/monitorPanels";
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  },
});
const {
  buildCloudSyncPayload,
  buildLocalVaultPayload,
  applySyncPayload,
  applyLocalVaultPayload,
} = await import("./syncPayload");
const {
  writeMonitorPanels,
  readMonitorPanels,
  saveMonitorPanel,
  deleteMonitorPanel,
} = await import("./state/monitorPanelsStorage");
const panel: MonitorPanel = {
  id: "p",
  name: "Fleet",
  description: "",
  hostIds: ["h1", "h2"],
  view: "charts",
  interval: 10,
  range: 15,
  sort: "manual",
};
const vault = {
  hosts: [],
  keys: [],
  identities: [],
  snippets: [],
  customGroups: [],
  knownHosts: [],
};
const opts = { collectPluginSidecars: () => undefined };
const importers = { importVaultData: () => {} };
test("real builders and importers round-trip panel configuration through cloud and backups without runtime state", async () => {
  store.clear();
  writeMonitorPanels([
    {
      ...panel,
      stats: { cpu: 42 },
      running: true,
      points: [1],
      error: "never-save",
    },
  ]);
  const cloud = await buildCloudSyncPayload(vault, [], opts);
  const backup = buildLocalVaultPayload(vault);
  assert.deepEqual(cloud.monitorPanels, [panel]);
  assert.deepEqual(backup.monitorPanels, [panel]);
  assert.ok(!JSON.stringify(cloud).includes("never-save"));
  writeMonitorPanels([]);
  await applySyncPayload(cloud, importers);
  assert.deepEqual(readMonitorPanels(), [panel]);
  delete backup.aiSessions;
  writeMonitorPanels([]);
  await applyLocalVaultPayload(backup, importers);
  assert.deepEqual(readMonitorPanels(), [panel]);
  const renamed = {
    ...panel,
    name: "Changed",
    hostIds: ["h2"],
    view: "list" as const,
  };
  await applySyncPayload({ ...cloud, monitorPanels: [renamed] }, importers);
  assert.deepEqual(readMonitorPanels(), [renamed]);
  const legacy = { ...cloud };
  delete legacy.monitorPanels;
  await applySyncPayload(legacy, importers);
  assert.deepEqual(readMonitorPanels(), [renamed]);
  await applySyncPayload({ ...cloud, monitorPanels: [] }, importers);
  assert.deepEqual(readMonitorPanels(), []);
});
test("serialized window mutations rebase stale fields and do not resurrect a deletion", async () => {
  store.clear();
  writeMonitorPanels([panel]);
  await Promise.all([
    saveMonitorPanel(panel, { ...panel, name: "Rename" }),
    saveMonitorPanel(panel, { ...panel, hostIds: ["h3"], view: "list" }),
  ]);
  assert.deepEqual(readMonitorPanels(), [
    { ...panel, name: "Rename", hostIds: ["h3"], view: "list" },
  ]);
  await deleteMonitorPanel("p");
  await assert.rejects(
    saveMonitorPanel(panel, { ...panel, name: "Stale" }),
    /deleted/,
  );
  assert.deepEqual(readMonitorPanels(), []);
});

test("cloud apply preserves panel edits committed after preparation", async () => {
  store.clear();
  writeMonitorPanels([panel]);
  const { prepareSyncPayloadApply } = await import("./syncPayload");
  const prepared = await prepareSyncPayloadApply(
    {
      hosts: [],
      keys: [],
      snippets: [],
      customGroups: [],
      syncedAt: 1,
      monitorPanels: [{ ...panel, name: "From cloud" }],
    },
    importers,
  );
  await saveMonitorPanel(panel, { ...panel, hostIds: ["h3"], view: "list" });
  await prepared();
  assert.deepEqual(readMonitorPanels(), [
    { ...panel, name: "From cloud", hostIds: ["h3"], view: "list" },
  ]);
});

test("cloud and backup imports preserve both independently created same-name panels", async () => {
  store.clear();
  const original = { ...panel, id: "a", name: "Fleet" };
  const other = { ...panel, id: "b", name: "FLEET" };
  writeMonitorPanels([original]);
  await applySyncPayload(
    {
      hosts: [],
      keys: [],
      snippets: [],
      customGroups: [],
      syncedAt: 1,
      monitorPanels: [other, original],
    },
    importers,
  );
  assert.deepEqual(
    readMonitorPanels().map((p) => [p.id, p.name]),
    [
      ["a", "Fleet"],
      ["b", "FLEET (2)"],
    ],
  );
  const backup = buildLocalVaultPayload(vault);
  delete backup.aiSessions;
  writeMonitorPanels([]);
  await applyLocalVaultPayload(backup, importers);
  assert.equal(readMonitorPanels().length, 2);
  assert.equal(
    new Set(readMonitorPanels().map((p) => p.name.toLowerCase())).size,
    2,
  );
});
