"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PluginDatabase } = require("./database.cjs");
const { createPluginHostService } = require("./hostService.cjs");

test("real source database replacement never reattributes old runtime log records", {
  skip: typeof PluginDatabase.prototype.getRetainedPluginSource !== "function" && "requires the source API from PR #3981; run on the documented integration worktree",
}, async (t) => {
  const { thirdPartySource, OFFICIAL_SOURCE } = require("./sourceIdentity.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-source-integration-"));
  const host = createPluginHostService({
    app: { getPath: () => root, getAppPath: () => process.cwd(), getVersion: () => "0.0.0" },
    electron: {}, env: {},
  });
  const database = host.database;
  const pluginId = "com.example.source-log-fixture";
  // The current source contract encodes every namespace, including local.
  const { LOCAL_SOURCE } = require("./sourceIdentity.cjs");
  database.installVersion({ pluginId: "com.example.local-source-fixture", version: "1.0.0", manifest: {}, archiveSha256: "b".repeat(64), packageRelativePath: "com.example.local-source-fixture/1.0.0", source: LOCAL_SOURCE });
  const localOwner = database.privateOwner("com.example.local-source-fixture");
  assert.notEqual(localOwner, "com.example.local-source-fixture");
  assert.equal(database.publicPluginId(localOwner), "com.example.local-source-fixture");

  const first = thirdPartySource("Synthetic first source", "https://synthetic-first.example.com");
  const install = (source) => database.installVersion({ pluginId, version: "1.0.0", manifest: {}, archiveSha256: "a".repeat(64), packageRelativePath: `${pluginId}/1.0.0`, source }, { enable: true });
  install(first);
  const service = host.logService;
  t.after(async () => { await host.manager.shutdown().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await service.ready;
  await service.configure({ saveToDisk: true, verbose: true });
  const activation = { pluginId, pluginVersion: "1.0.0", runtimeId: "source-fixture-A", runtimeKind: "browser" };
  const firstLogger = service.createLogger(activation, database.getActivePlugin(pluginId));
  firstLogger.audit({ operation: "runtime.running", result: "ok", authorization: "not-required" });
  await service.sink.flush();
  const oldOwner = database.privateOwner(pluginId);
  let resume;
  const queueGate = new Promise((resolve) => { resume = resolve; });
  service.sink.queue = service.sink.queue.then(() => queueGate);
  await firstLogger.write("info", "synthetic queued before replacement");
  database.removePlugin(pluginId);
  assert.equal(database.getRetainedPluginSource(pluginId).id, first.id);
  database.clearUninstalledSourceData(pluginId, first.id);
  install(OFFICIAL_SOURCE);
  assert.equal(database.publicPluginId(oldOwner), null);
  resume();
  await service.sink.flush();
  assert.equal(service.status().droppedRecords, 1);
  const replacement = service.createLogger({ ...activation, runtimeId: "source-fixture-B" }, database.getActivePlugin(pluginId));
  replacement.audit({ operation: "runtime.running", result: "ok", authorization: "not-required" });
  await service.sink.flush();
  const records = (await fs.readFile(service.sink.file(0), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].sourceId, first.id);
  assert.equal(records[0].namespace, oldOwner);
  assert.equal(records[1].sourceId, "official");
  assert.equal(records[1].namespace, database.privateOwner(pluginId));
  assert.equal(Object.hasOwn(records[1], "officiallyMaintained"), false);
  assert.doesNotMatch(JSON.stringify(records), /queued before replacement|synthetic-first.example.com/);
  replacement.audit({ operation: "synthetic.before-shutdown", result: "ok" });
  host.companionSupervisor.shutdown = async () => { throw new Error("synthetic companion shutdown failure"); };
  await assert.rejects(host.manager.shutdown(), /synthetic companion shutdown failure/);
  assert.equal(service.sink.closed, true);
  const drained = (await fs.readFile(service.sink.file(0), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(drained.at(-1).operation, "synthetic.before-shutdown");
  assert.equal(drained.at(-1).sourceId, "official");
});
