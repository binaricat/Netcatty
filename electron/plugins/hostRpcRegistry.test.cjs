"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PluginHostRpcRegistry,
  assertHostMethod,
  cloneAndFreezeMetadata,
} = require("./hostRpcRegistry.cjs");

function identity(overrides = {}) {
  return {
    pluginId: "com.example.registry",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    ...overrides,
  };
}

test("host RPC registry separates requests from notifications and rejects duplicate ownership", async () => {
  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("settings.get", async (params, context) => ({
    params,
    kind: context.kind,
    pluginId: context.pluginId,
  }));
  assert.throws(
    () => registry.registerNotification("settings.get", () => {}),
    /already registered/,
  );
  registry.registerNotification("telemetry.write", () => undefined);
  const routes = registry.createRoutes(identity());
  assert.deepEqual(
    await routes.requestHandlers["settings.get"]({ key: "theme" }, { signal: AbortSignal.timeout(10) }),
    { params: { key: "theme" }, kind: "request", pluginId: "com.example.registry" },
  );
  assert.equal(routes.notificationHandlers["settings.get"], undefined);
  assert.equal(routes.requestHandlers["telemetry.write"], undefined);
});

test("host RPC middleware receives immutable host identity, method metadata, and transport context", async () => {
  const registry = new PluginHostRpcRegistry();
  const seen = [];
  const metadata = { permission: { name: "vault.metadata", resources: ["hosts"] } };
  registry.use(async (context, next) => {
    seen.push(context);
    return next();
  });
  registry.registerRequest("vault.read", async (_params, context) => context.runtimeId, {
    metadata,
  });
  metadata.permission.name = "spoofed";
  metadata.permission.resources.push("credentials");
  const routes = registry.createRoutes(identity());
  const signal = AbortSignal.timeout(100);
  assert.equal(await routes.requestHandlers["vault.read"](
    { hostId: "host-1" },
    {
      cancellationId: "cancel-1",
      deadlineMs: 100,
      pluginId: "com.attacker.spoofed",
      requestId: 7,
      runtimeId: "spoofed-runtime",
      signal,
    },
  ), "runtime-1");
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(seen[0].pluginVersion, "1.0.0");
  assert.equal(seen[0].pluginId, "com.example.registry");
  assert.equal(seen[0].runtimeId, "runtime-1");
  assert.equal(seen[0].method, "vault.read");
  assert.deepEqual(seen[0].metadata.permission, { name: "vault.metadata", resources: ["hosts"] });
  assert.equal(Object.isFrozen(seen[0].metadata.permission), true);
  assert.equal(Object.isFrozen(seen[0].metadata.permission.resources), true);
  assert.deepEqual(seen[0].params, { hostId: "host-1" });
  assert.equal(seen[0].requestId, 7);
  assert.equal(seen[0].signal.aborted, signal.aborted);
  assert.equal(typeof seen[0].addAuthorizationGuard, "function");
  assert.equal(typeof seen[0].assertActive, "function");
});

test("method parameters are validated and normalized before capability middleware", async () => {
  const registry = new PluginHostRpcRegistry();
  const seen = [];
  registry.use(async (context, next) => {
    seen.push(context.params);
    return next();
  });
  registry.registerRequest("filesystem.stat", async (params) => params, {
    validateParams(params) {
      if (typeof params?.path !== "string") throw new TypeError("path is required");
      return { path: params.path.normalize("NFC") };
    },
  });
  const routes = registry.createRoutes(identity());
  const normalized = await routes.requestHandlers["filesystem.stat"](
    { path: "cafe\u0301" },
    { signal: AbortSignal.timeout(100) },
  );
  assert.deepEqual(normalized, { path: "caf\u00e9" });
  assert.deepEqual(seen, [{ path: "caf\u00e9" }]);
  await assert.rejects(
    routes.requestHandlers["filesystem.stat"]({}, { signal: AbortSignal.timeout(100) }),
    /path is required/,
  );
  assert.equal(seen.length, 1);
});

test("parameter validators must be synchronous and metadata cloning cannot invoke __proto__", async () => {
  const cloned = cloneAndFreezeMetadata(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
  assert.equal(Object.hasOwn(cloned, "__proto__"), true);
  assert.equal(cloned.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);

  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("network.fetch", () => null, {
    validateParams: async (params) => params,
  });
  const routes = registry.createRoutes(identity());
  await assert.rejects(
    routes.requestHandlers["network.fetch"]({}, { signal: AbortSignal.timeout(100) }),
    /must be synchronous/,
  );
});

test("host RPC identity is rechecked after asynchronous middleware and handler work", async () => {
  const registry = new PluginHostRpcRegistry();
  let current = true;
  let releaseMiddleware;
  let handlerCalls = 0;
  registry.use(async (_context, next) => {
    await new Promise((resolve) => { releaseMiddleware = resolve; });
    return next();
  });
  registry.registerRequest("vault.write", async () => {
    handlerCalls += 1;
    return null;
  });
  const routes = registry.createRoutes(identity({
    assertCurrent() {
      if (!current) throw new Error("stale activation");
    },
  }));
  const pending = routes.requestHandlers["vault.write"]({}, { signal: AbortSignal.timeout(100) });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  releaseMiddleware();
  await assert.rejects(pending, /stale activation/);
  assert.equal(handlerCalls, 0);
});

test("host RPC results are discarded when identity becomes stale during handler work", async () => {
  const registry = new PluginHostRpcRegistry();
  let current = true;
  let releaseHandler;
  registry.registerRequest("vault.read", async () => new Promise((resolve) => {
    releaseHandler = resolve;
  }));
  const routes = registry.createRoutes(identity({
    assertCurrent() {
      if (!current) throw new Error("stale activation");
    },
  }));
  const pending = routes.requestHandlers["vault.read"]({}, { signal: AbortSignal.timeout(100) });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  releaseHandler({ secret: "stale" });
  await assert.rejects(pending, /stale activation/);
});

test("async capability handlers can recheck activation immediately before committing", async () => {
  const registry = new PluginHostRpcRegistry();
  let current = true;
  let releasePreparation;
  let commits = 0;
  registry.registerRequest("settings.set", async (_params, context) => {
    await new Promise((resolve) => { releasePreparation = resolve; });
    await context.assertActive();
    commits += 1;
    return null;
  });
  const routes = registry.createRoutes(identity({
    assertCurrent() {
      if (!current) throw new Error("stale activation");
    },
  }));
  const pending = routes.requestHandlers["settings.set"]({}, { signal: AbortSignal.timeout(100) });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  releasePreparation();
  await assert.rejects(pending, /stale activation/);
  assert.equal(commits, 0);
});

test("capability commit guards reject requests cancelled while handler work is pending", async () => {
  const registry = new PluginHostRpcRegistry();
  let releaseWork;
  const work = new Promise((resolve) => { releaseWork = resolve; });
  let committed = false;
  registry.registerRequest("filesystem.write", async (_params, context) => {
    await work;
    await context.assertActive();
    committed = true;
    return null;
  });
  const controller = new AbortController();
  const routes = registry.createRoutes({
    pluginId: "com.example.cancelled",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-cancelled",
    runtimeKind: "utility",
  });
  const pending = routes.requestHandlers["filesystem.write"]({}, {
    signal: controller.signal,
  });
  controller.abort(new Error("request cancelled"));
  releaseWork();
  await assert.rejects(pending, /request cancelled/);
  assert.equal(committed, false);
});

test("cancelled middleware cannot enter a privileged capability handler", async () => {
  const registry = new PluginHostRpcRegistry();
  let releaseMiddleware;
  const middlewareWork = new Promise((resolve) => { releaseMiddleware = resolve; });
  let invoked = false;
  registry.use(async (_context, next) => {
    await middlewareWork;
    return next();
  });
  registry.registerRequest("network.fetch", async () => {
    invoked = true;
    return null;
  });
  const controller = new AbortController();
  const routes = registry.createRoutes({
    pluginId: "com.example.cancelled",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-cancelled",
    runtimeKind: "utility",
  });
  const pending = routes.requestHandlers["network.fetch"]({}, {
    signal: controller.signal,
  });
  controller.abort(new Error("approval cancelled"));
  releaseMiddleware();
  await assert.rejects(pending, /approval cancelled/);
  assert.equal(invoked, false);
});

test("host RPC route snapshots remain stable while later registrations apply after restart", () => {
  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("first.call", () => null);
  const first = registry.createRoutes(identity());
  registry.registerRequest("second.call", () => null);
  const second = registry.createRoutes(identity({ runtimeId: "runtime-2" }));
  assert.equal(first.requestHandlers["second.call"], undefined);
  assert.equal(typeof second.requestHandlers["second.call"], "function");
  assert.ok(second.revision > first.revision);
});

test("incoming streams route to the first owner and expose a host-assigned runtime identity", async () => {
  const registry = new PluginHostRpcRegistry();
  const seen = [];
  registry.registerIncomingStream(async (stream, context) => {
    seen.push([stream.streamId, context.runtimeId]);
    return false;
  });
  registry.registerIncomingStream(async (stream) => stream.streamId === "owned");
  const routes = registry.createRoutes(identity());
  assert.equal(await routes.onIncomingStream({ streamId: "owned" }), true);
  assert.equal(await routes.onIncomingStream({ streamId: "unknown" }), false);
  assert.deepEqual(seen, [["owned", "runtime-1"], ["unknown", "runtime-1"]]);
});

test("incoming stream owners receive cancellation through the shared active guard", async () => {
  const registry = new PluginHostRpcRegistry();
  let releaseOwner;
  const ownerWork = new Promise((resolve) => { releaseOwner = resolve; });
  let committed = false;
  registry.registerIncomingStream(async (_stream, context) => {
    await ownerWork;
    await context.assertActive();
    committed = true;
    return true;
  });
  const routes = registry.createRoutes(identity());
  const controller = new AbortController();
  const pending = routes.onIncomingStream({
    streamId: "cancelled",
    signal: controller.signal,
  });
  controller.abort(new Error("stream owner cancelled"));
  releaseOwner();

  await assert.rejects(pending, /stream owner cancelled/);
  assert.equal(committed, false);
});

test("reserved lifecycle and transport methods cannot be claimed as host capabilities", () => {
  const registry = new PluginHostRpcRegistry();
  for (const method of ["plugin.initialize", "plugin.activate", "plugin.deactivate", "$/progress"]) {
    assert.throws(() => assertHostMethod(method), /reserved/);
    assert.throws(() => registry.registerRequest(method, () => null), /reserved/);
  }
  assert.equal(assertHostMethod("commands.execute"), "commands.execute");
});
