"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PluginDatabase } = require("./database.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { PluginHostInteractionService } = require("./hostInteractionService.cjs");
const { PluginNetworkBroker } = require("./networkBroker.cjs");
const { registerSecurePluginCapabilities } = require("./secureCapabilities.cjs");
const { OFFICIAL_SOURCE } = require("./sourceIdentity.cjs");

const manifest = { id: "com.example.policy", publisher: "example", version: "1.0.0",
  permissions: { optional: ["storage", "ui.interact", "clipboard.read", "clipboard.write", { permission: "network", resources: ["https://example.com"] }] } };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-policy-"));
  const filename = path.join(root, "plugins.sqlite");
  const database = new PluginDatabase(filename);
  const decisions = [], prompts = [], writes = [];
  let approve = true;
  const engine = new PluginPermissionEngine({ database, requestDecision: async (request) => {
    decisions.push(request); return { requestId: request.requestId, decision: approve ? "allow" : "deny", ...(approve ? { scope: "once" } : {}) };
  } });
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (_channel, prompt) => prompts.push(prompt) });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const interactions = new PluginHostInteractionService({ database, permissionEngine: engine, getWindow: () => window, isLocked: () => false,
    clipboard: { readText: () => "SYNTHETIC PRIVATE BODY", writeText: (text) => writes.push(text) }, quotaManager: { chargeBytes() {} } });
  interactions.setReady(sender, true);
  const registry = new PluginHostRpcRegistry(); registry.use(engine.createMiddleware()); interactions.registerRpcCapabilities(registry);
  const context = { pluginId: manifest.id, pluginVersion: manifest.version, runtimeId: "runtime-policy", runtimeKind: "browser", manifest };
  const handlers = registry.createRoutes(context).requestHandlers;
  const call = (method, params) => handlers[method](params, {});
  const set = (permission, mode) => engine.setMode({ id: manifest.id, manifest }, permission, mode);
  t.after(() => { interactions.shutdown(); engine.shutdown(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, filename, engine, registry, context, call, set, decisions, prompts, writes, interactions, sender, approve: (v) => { approve = v; } };
}

test("registered clipboard API defaults Allow with no permission UI; Ask has one scoped host dialog; Deny has no side effects", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.call("ui.interact", { kind: "clipboard.read", title: "Read" }), { cancelled: false, value: "SYNTHETIC PRIVATE BODY" });
  await f.call("ui.interact", { kind: "clipboard.write", title: "Copy", text: "SYNTHETIC PRIVATE BODY" });
  assert.equal(f.decisions.length, 0); assert.equal(f.prompts.length, 0); assert.equal(f.writes.length, 1);
  f.set("clipboard.read", "ask");
  const result = f.call("ui.interact", { kind: "clipboard.read", title: "Read" });
  await new Promise(setImmediate);
  const prompt = f.prompts.find((p) => !p.closed);
  assert.equal(prompt.phase, "preview"); assert.equal(prompt.permissionMode, "ask"); assert.equal(f.decisions.length, 0);
  await f.interactions.respond(f.sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action: "submit" });
  assert.equal((await result).value, "SYNTHETIC PRIVATE BODY");
  assert.equal(f.prompts.filter((p) => !p.closed).length, 1);
  f.set("clipboard.write", "deny");
  await assert.rejects(f.call("ui.interact", { kind: "clipboard.write", title: "Copy", text: "NEVER COPY" }), /disabled/);
  assert.equal(f.writes.length, 1);
  assert.equal(JSON.stringify(f.database.listSecurityAudit(manifest.id, 1000)).includes("SYNTHETIC PRIVATE BODY"), false);
});

test("pending workflow tokens and in-flight resource work cannot survive a Deny flip", async (t) => {
  const f = fixture(t); f.set("clipboard.write", "ask");
  const operation = f.call("ui.interact", { kind: "clipboard.write", title: "Copy", text: "NEVER COPY" });
  const rejected = assert.rejects(operation, /changed|revoked/);
  await new Promise(setImmediate);
  const prompt = f.prompts.find((p) => !p.closed);
  f.set("clipboard.write", "deny"); await rejected;
  assert.equal(await f.interactions.respond(f.sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action: "submit" }), false);
  assert.deepEqual(f.writes, []);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  f.registry.registerRequest("test.await", async (_params, context) => { await gate; await context.assertActive(); return "SECRET"; }, { authorization: { permission: "storage", resources: ["*"] } });
  const work = f.registry.createRoutes(f.context).requestHandlers["test.await"]({}, {});
  const stopped = assert.rejects(work, /changed/); await new Promise(setImmediate); f.set("storage", "deny"); release(); await stopped;
});

test("Deny beats saved grants; policy persists across restart and package changes while sources and plugins stay isolated", async (t) => {
  const f = fixture(t);
  const oldOwner = f.database.privateOwner(manifest.id);
  f.set("storage", "deny");
  f.database.upsertPermissionGrant({ pluginId: manifest.id, permission: "storage", resource: "*", resourceKind: "exact", declarationHash: "old-grant" });
  const restarted = new PluginDatabase(f.filename); t.after(() => restarted.close());
  assert.equal(restarted.getPermissionMode(manifest.id, "storage"), "deny");
  const engine = new PluginPermissionEngine({ database: restarted }); t.after(() => engine.shutdown());
  await assert.rejects(engine.authorize({ ...f.context, pluginVersion: "2.0.0", securityPrincipal: "unsigned-package:new-package-principal" }, { permission: "storage" }), /disabled/);
  assert.equal(restarted.getPermissionMode("com.example.another", "storage"), "allow");
  // Source replacement is an explicit host reset. The new source receives none
  // of the old source's policies, grants or settings.
  restarted.clearUninstalledSourceData(manifest.id, "local");
  restarted.installVersion({ pluginId: manifest.id, version: "2.0.0", manifest, archiveSha256: "a".repeat(64), packageRelativePath: "test/package", source: OFFICIAL_SOURCE });
  assert.equal(restarted.getPermissionMode(manifest.id, "storage"), "allow");
  await assert.rejects(engine.authorize({ ...f.context, sourceOwner: oldOwner }, { permission: "storage" }), /source changed/);
});

test("registered network API enforces all modes and declared endpoint scope before fetch", async (t) => {
  const f = fixture(t); let fetched = 0;
  const broker = new PluginNetworkBroker({ permissionEngine: f.engine, fetch: async () => { fetched++; return new Response("ok"); } });
  const registry = new PluginHostRpcRegistry();
  registerSecurePluginCapabilities(registry, { permissionEngine: f.engine, quotaManager: { createMiddleware: () => (_context, next) => next() }, networkBroker: broker });
  const call = (url) => registry.createRoutes(f.context).requestHandlers["network.request"]({ url }, {});
  await call("https://example.com/path"); assert.equal(fetched, 1); assert.equal(f.decisions.length, 0);
  f.set("network", "ask"); await call("https://example.com/path"); assert.equal(f.decisions.length, 1); assert.equal(fetched, 2);
  f.approve(false); await assert.rejects(call("https://example.com/path"), /denied/); assert.equal(fetched, 2);
  f.set("network", "deny"); await assert.rejects(call("https://example.com/path"), /disabled/); assert.equal(fetched, 2);
  f.set("network", "allow"); await assert.rejects(call("https://other.example/path"), /did not declare/); assert.equal(fetched, 2);
  assert.equal(registry.createRoutes(f.context).requestHandlers["unknown.method"], undefined);
});

test("one Ask decision covers model invocation and exact selected handles only for that operation", async (t) => {
  const f = fixture(t);
  const currentManifest = { ...manifest, permissions: { optional: ["ai.invoke", "context.selected.read"] } };
  const context = { ...f.context, manifest: currentManifest };
  const plugin = { id: manifest.id, manifest: currentManifest };
  f.engine.setMode(plugin, "ai.invoke", "ask"); f.engine.setMode(plugin, "context.selected.read", "ask");
  const selected = { permission: "context.selected.read", resources: ["selected:host-handle:v1"] };
  await f.engine.authorize(context, { permission: "ai.invoke", relatedPermissions: [selected] });
  await f.engine.authorize(context, selected);
  assert.equal(f.decisions.length, 1);
  assert.deepEqual(f.decisions[0].relatedPermissions, [{ permission: selected.permission, resources: selected.resources }]);
  await f.engine.authorize({ ...context }, selected); assert.equal(f.decisions.length, 2, "receipt cannot cross RPC operations");
  f.engine.setMode(plugin, "context.selected.read", "deny");
  await assert.rejects(f.engine.authorize(context, selected), /disabled/);
});

test("Deny during an asynchronous authorization resolver invalidates the old call even after Allow", async (t) => {
  const f = fixture(t); let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let effects = 0;
  f.registry.registerRequest("test.resolve", async () => { effects++; return "SECRET"; }, {
    authorization: async () => { await pending; return { permission: "storage" }; },
  });
  const operation = f.registry.createRoutes(f.context).requestHandlers["test.resolve"]({}, {});
  const rejected = assert.rejects(operation, /changed/);
  await new Promise(setImmediate); f.set("storage", "deny"); f.set("storage", "allow"); release();
  await rejected; assert.equal(effects, 0);
});

test("Ask does not prompt twice for a same-origin redirect within one registered network request", async (t) => {
  const f = fixture(t); f.set("network", "ask"); let fetched = 0;
  const broker = new PluginNetworkBroker({ permissionEngine: f.engine, fetch: async () => ++fetched === 1
    ? new Response(null, { status: 302, headers: { location: "/final" } }) : new Response("ok") });
  const registry = new PluginHostRpcRegistry();
  registerSecurePluginCapabilities(registry, { permissionEngine: f.engine, quotaManager: { createMiddleware: () => (_context, next) => next() }, networkBroker: broker });
  const call = () => registry.createRoutes(f.context).requestHandlers["network.request"]({ url: "https://example.com/start" }, {});
  await call(); assert.equal(fetched, 2); assert.equal(f.decisions.length, 1);
  await call(); assert.equal(f.decisions.length, 2, "the decision does not leak to the next RPC operation");
});
