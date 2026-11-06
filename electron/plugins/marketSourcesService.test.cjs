"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PluginDatabase } = require("./database.cjs");
const { PluginManager } = require("./pluginManager.cjs");
const { MarketSourcesService } = require("./marketSourcesService.cjs");
const { realFiles } = require("./fixtures/staticDistributionFixture.cjs");

test("source removal retains installed plugins, optional disabling is serialized, and no source silently takes over", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = new PluginDatabase(path.join(root, "db.sqlite"));
  t.after(() => database.close());
  const stopped = [];
  const manager = new PluginManager({ database, packageStore: { async initialize() {} }, runtimeSupervisor: {
    async startEnabled() {}, async stop(id) { stopped.push(id); },
  } });
  const requests = [];
  const service = new MarketSourcesService({ database, manager, createSourceFetch: (origin) => async (url) => {
    assert.equal(new URL(url).origin, origin); requests.push(url);
    return new Response(realFiles().get(new URL(url).pathname));
  }, fetch: async () => { assert.fail("third-party browsing must not fetch official upstream"); } });
  const source = await service.addSource({ name: "Community", address: "https://community.example.com" });
  const entry = (await service.list(source.id)).entries[0];
  database.installVersion({ pluginId: entry.id, version: entry.version, manifest: entry.manifest, source, archiveSha256: "a".repeat(64), packageRelativePath: "test" }, { enable: true });
  await assert.rejects(async () => service.install(entry.id, entry.selectionToken, source.id), /confirm/);
  await service.updateSource({ id: source.id, name: "Renamed", enabled: false });
  const count = requests.length;
  assert.throws(() => service.list(source.id), /disabled/);
  assert.equal(database.getActivePlugin(entry.id).enabled, true);
  await service.removeSource({ id: source.id, disablePlugins: true });
  assert.equal(database.getActivePlugin(entry.id).enabled, false);
  assert.equal(database.getActivePlugin(entry.id).source.id, source.id);
  assert.deepEqual(stopped, [entry.id]);
  assert.throws(() => service.readme(entry.id, entry.selectionToken, source.id), /removed/);
  assert.equal(requests.length, count);
});
