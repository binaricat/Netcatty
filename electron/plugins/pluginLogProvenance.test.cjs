"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPluginLogProvenanceResolver } = require("./pluginLogProvenance.cjs");
const { PluginLogService } = require("./pluginLogService.cjs");

function sourceFixture(pluginId = "com.example.synthetic-source-logging") {
  const identity = { pluginId, pluginVersion: "1.0.0", archiveSha256: "a".repeat(64), runtimeId: "host-runtime-A", runtimeKind: "browser" };
  let source = { id: `third-party:${"b".repeat(64)}`, kind: "third-party", name: "Synthetic source", origin: "https://synthetic.example.com" };
  let active = { id: pluginId, activeVersion: identity.pluginVersion, archiveSha256: identity.archiveSha256, source };
  let retained = source;
  const owner = () => source ? `source:${source.id === "official" ? "c".repeat(64) : "d".repeat(64)}:${pluginId}` : null;
  const database = {
    getActivePlugin(id) { assert.equal(id, pluginId); return active; },
    getRetainedPluginSource(id) { assert.equal(id, pluginId); return retained; },
    privateOwner(id) { assert.equal(id, pluginId); return owner(); },
    publicPluginId(encoded) { return encoded === owner() ? pluginId : null; },
  };
  return { identity, database, plugin: () => active, setActive(value) { active = value; },
    setRetained(value) { retained = value; },
    replace() { source = { id: "official", kind: "official", name: "Not a maintenance claim", origin: "https://plugins.netcatty.app" }; active = { ...active, source }; retained = source; },
    uninstall() { active = null; },
  };
}

test("host provenance uses the bound owner and ignores plugin-supplied source metadata", () => {
  const f = sourceFixture();
  const resolver = createPluginLogProvenanceResolver(f.database);
  const result = resolver({ ...f.identity, sourceId: "official", source: { id: "official" }, owner: "spoof" });
  assert.equal(result.sourceId, f.plugin().source.id);
  assert.equal(result.sourceKind, "third-party");
  assert.equal(result.namespace, f.database.privateOwner(f.identity.pluginId));
  assert.equal(result.isCurrent(), true);
  assert.equal(Object.hasOwn(result, "officiallyMaintained"), false);
  assert.equal(Object.hasOwn(result, "origin"), false);
  f.replace();
  assert.equal(result.isCurrent(), false);
  assert.equal(resolver(f.identity).sourceId, "official");
});

test("missing source APIs, retained mismatch, orphaned owner and changed package remain unknown", () => {
  const f = sourceFixture();
  const resolve = createPluginLogProvenanceResolver(f.database);
  assert.equal(createPluginLogProvenanceResolver({ getActivePlugin: f.database.getActivePlugin })(f.identity), null);
  assert.equal(resolve({ ...f.identity, pluginVersion: "2.0.0" }), null);
  assert.equal(resolve({ ...f.identity, archiveSha256: "c".repeat(64) }), null);
  f.database.privateOwner = () => null;
  assert.equal(resolve(f.identity), null, "no bare pluginId fallback");
  f.database.privateOwner = () => f.identity.pluginId;
  f.database.publicPluginId = (owner) => owner;
  assert.equal(resolve(f.identity), null, "a bare owner is not an authenticated namespace");
  f.database.privateOwner = () => "source:orphan";
  assert.equal(resolve(f.identity), null);
  const g = sourceFixture();
  g.setRetained({ id: "different", kind: "third-party" });
  assert.equal(createPluginLogProvenanceResolver(g.database)(g.identity), null);
  const h = sourceFixture();
  const snapshot = createPluginLogProvenanceResolver(h.database)(h.identity);
  h.uninstall();
  assert.equal(snapshot.isCurrent(), false);
  assert.equal(createPluginLogProvenanceResolver(h.database)(h.identity), null, "retained source alone cannot authenticate an installed activation");
});

test("queued diagnostics and host facts are revalidated after async I/O before commit", async (t) => {
  const f = sourceFixture(`com.${"a".repeat(120)}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-source-log-"));
  const service = new PluginLogService({ paths: { root, logs: path.join(root, "logs") }, resolveProvenance: createPluginLogProvenanceResolver(f.database) });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await service.ready;
  assert.equal(service.status().saveToDisk, false);
  await service.configure({ saveToDisk: true, verbose: true });
  const loggerA = service.createLogger(f.identity, f.plugin());
  loggerA.audit({ operation: "runtime.running", authorization: "not-required", result: "ok" });
  await service.sink.flush();
  let release;
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const prune = service.sink.prune.bind(service.sink);
  service.sink.prune = async () => { entered(); await gate; return prune(); };
  loggerA.audit({ operation: "synthetic.pending-source-A", authorization: "allowed", result: "ok" });
  await loggerA.write("info", "synthetic pending diagnostic A");
  await paused;
  f.replace();
  release();
  await service.sink.flush();
  assert.equal(service.status().droppedRecords, 2);
  const loggerB = service.createLogger({ ...f.identity, runtimeId: "host-runtime-B" }, f.plugin());
  loggerB.audit({ operation: "runtime.running", authorization: "not-required", result: "ok" });
  await service.sink.flush();
  const records = (await fs.readFile(service.sink.file(0), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.match(records[0].sourceId, /^third-party:/u);
  assert.equal(records[1].sourceId, "official");
  assert.notEqual(records[0].namespace, records[1].namespace);
  assert.equal(records[0].runtimeId, "host-runtime-A");
  assert.equal(records[1].runtimeId, "host-runtime-B");
  assert.doesNotMatch(JSON.stringify(records), /synthetic.pending-source-A|pending diagnostic|example.com|maintenance/i);
  f.uninstall();
  await loggerB.write("info", "synthetic stale callback");
  loggerB.audit({ operation: "synthetic.after-uninstall", result: "ok" });
  assert.equal(service.status().droppedRecords, 4);
});

test("a thrown source revalidation fails closed without breaking plugin execution", async (t) => {
  const f = sourceFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-source-failure-"));
  const service = new PluginLogService({ paths: { root, logs: path.join(root, "logs") }, resolveProvenance: createPluginLogProvenanceResolver(f.database) });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await service.ready;
  await service.configure({ saveToDisk: true, verbose: true });
  const logger = service.createLogger(f.identity, f.plugin());
  f.database.getActivePlugin = () => { throw new Error("synthetic unavailable source database"); };
  await logger.write("info", "synthetic ignored");
  logger.audit({ operation: "storage.get", result: "ok" });
  await service.sink.flush();
  assert.equal(service.status().droppedRecords, 2);
  assert.equal(service.status().writeErrors, 0);
});

test("a stale queued source cannot rotate away existing audit evidence", async (t) => {
  const f = sourceFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-source-rotation-"));
  const service = new PluginLogService({ paths: { root, logs: path.join(root, "logs") }, limits: { maxFiles: 1 }, resolveProvenance: createPluginLogProvenanceResolver(f.database) });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await service.ready;
  await service.configure({ saveToDisk: true, verbose: false });
  const logger = service.createLogger(f.identity, f.plugin());
  logger.audit({ operation: "runtime.running", authorization: "not-required", result: "ok" });
  await service.sink.flush();
  const before = await fs.readFile(service.sink.file(0), "utf8");
  service.sink.maxBytes = Buffer.byteLength(before) + 16;
  let resume;
  let entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const prune = service.sink.prune.bind(service.sink);
  service.sink.prune = async () => { entered(); await gate; return prune(); };
  logger.audit({ operation: "runtime.running", authorization: "not-required", result: "ok" });
  await paused;
  f.replace();
  resume();
  await service.sink.flush();
  assert.equal(service.status().droppedRecords, 1);
  assert.equal(await fs.readFile(service.sink.file(0), "utf8"), before);
});
