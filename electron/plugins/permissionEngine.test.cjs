"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDefinitionValidator } = require("./contractValidator.cjs");
const { PluginDatabase } = require("./database.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const {
  canonicalizeNetworkOrigin,
  defaultSecurityPrincipal,
  permissionResourceCovers,
} = require("./permissionResources.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createDatabase(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-permissions-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PluginDatabase(path.join(root, "plugins.sqlite"));
}

function manifest(permissions) {
  return {
    manifestVersion: 1,
    id: "com.example.permissions",
    name: "permissions",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "index.js" },
    permissions,
  };
}

function runtimeContext(pluginManifest, overrides = {}) {
  return {
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("permission declarations are not grants and no renderer fails closed", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({ database });
  const pluginManifest = manifest({ required: ["storage"] });
  await assert.rejects(
    engine.authorize(runtimeContext(pluginManifest), {
      permission: "storage",
      resources: ["*"],
      reason: "Use storage",
    }),
    (error) => error.code === RPC_ERRORS.permissionDenied,
  );
  assert.equal(database.listPermissionGrants(pluginManifest.id).length, 0);
  assert.equal(database.listSecurityAudit(pluginManifest.id)[0].event, "permission.denied");
  database.close();
});

test("always grants are declaration-bound and reusable until permission semantics change", async (context) => {
  const database = createDatabase(context);
  let prompts = 0;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      prompts += 1;
      return { requestId: request.requestId, decision: "allow", scope: "always" };
    },
  });
  const optional = manifest({ optional: ["storage"] });
  const descriptor = { permission: "storage", resources: ["*"], reason: "Use storage" };
  await engine.authorize(runtimeContext(optional), descriptor);
  await engine.authorize(runtimeContext(optional), descriptor);
  assert.equal(prompts, 1);
  assert.equal(database.listPermissionGrants(optional.id).length, 1);

  const required = manifest({ required: ["storage"] });
  await engine.authorize(runtimeContext(required), descriptor);
  assert.equal(prompts, 2, "optional-to-required changes require a fresh decision");
  const newPublisher = { ...required, publisher: "different-publisher" };
  await engine.authorize(runtimeContext(newPublisher), descriptor);
  assert.equal(prompts, 3, "a different security principal requires a fresh decision");
  database.close();
});

test("permission decisions cannot persist resources broader than the manifest declaration", async (context) => {
  const database = createDatabase(context);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-declared-root-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "file.txt");
  fs.writeFileSync(file, "hello");
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "always",
      resources: [path.dirname(root)],
    }),
  });
  const pluginManifest = manifest({ optional: [{
    permission: "filesystem.read",
    resources: [root],
  }] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [file],
    reason: "Read file",
  }), /exceeds the manifest declaration/);
  assert.equal(database.listPermissionGrants(pluginManifest.id).length, 0);
  database.close();
});

test("an explicit empty allow-decision never widens to every requested resource", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "always",
      resources: [],
    }),
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    reason: "Use storage",
  }), /does not cover the requested resources/);
  assert.equal(database.listPermissionGrants(pluginManifest.id).length, 0);
  database.close();
});

test("application grants can be listed and revoked for the permission UI", async (context) => {
  const database = createDatabase(context);
  let prompts = 0;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      prompts += 1;
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  const descriptor = { permission: "storage", resources: ["*"], reason: "Storage" };
  await engine.authorize(runtimeContext(pluginManifest), descriptor);
  assert.equal(engine.listGrants(pluginManifest.id).application[0].permission, "storage");
  engine.revokeApplication(pluginManifest.id, "storage", "*");
  await engine.authorize(runtimeContext(pluginManifest), descriptor);
  assert.equal(prompts, 2);
  engine.revokeAll(pluginManifest.id);
  assert.deepEqual(engine.listGrants(pluginManifest.id), {
    always: [],
    application: [],
    session: [],
  });
  database.close();
});

test("permission decision provider failures are audited and fail closed", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async () => { throw new Error("renderer crashed"); },
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    reason: "Storage",
  }), /decision provider failed/);
  assert.equal(database.listSecurityAudit(pluginManifest.id)[0].details.reason, "decision-provider-failed");
  database.close();
});

test("permission decision providers cannot bypass the canonical decision shape", async (context) => {
  const database = createDatabase(context);
  const pluginManifest = manifest({ optional: ["storage"] });
  const descriptor = { permission: "storage", resources: ["*"], reason: "Storage" };
  for (const decision of [
    { decision: "allow", scope: "always", resources: { 0: "*", length: 1 } },
    { decision: "allow", scope: "always", resources: Array(129).fill("*") },
    { decision: "allow", scope: "always", resources: ["x".repeat(9_000)] },
    { decision: "deny", scope: "always" },
  ]) {
    const engine = new PluginPermissionEngine({
      database,
      requestDecision: async (request) => ({ requestId: request.requestId, ...decision }),
    });
    await assert.rejects(engine.authorize(runtimeContext(pluginManifest), descriptor), /decision/);
  }
  assert.equal(database.listPermissionGrants(pluginManifest.id).length, 0);
  database.close();
});

test("permission requests stay inside the canonical UI contract bounds", async (context) => {
  const database = createDatabase(context);
  let captured;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      captured = request;
      return { requestId: request.requestId, decision: "deny" };
    },
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    reason: "r".repeat(2_048),
    operationId: `filesystem:${"p".repeat(2_048)}`,
  }), /denied/);
  assert.equal(captured.reason.length, 1_024);
  assert.match(captured.operationId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(captured, "sessionId"), false);
  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(captured.resourceKinds, ["exact"]);
  assert.equal(Object.isFrozen(captured.resourceKinds), true);
  const validateRequest = createDefinitionValidator("PermissionRequest");
  assert.equal(validateRequest(captured), true, JSON.stringify(validateRequest.errors));
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: Array(129).fill("*"),
    reason: "Too many resources",
  }), /resources are invalid/);
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    resourceKinds: [],
    reason: "Misaligned resource kinds",
  }), /resource kinds are invalid/);
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    reason: "Invalid session",
    sessionId: "bad\0session",
  }), /session ID is invalid/);
  database.close();
});

test("coalesced prompts do not widen a once decision to concurrent callers", async (context) => {
  const database = createDatabase(context);
  let prompts = 0;
  const decisions = [];
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: (request) => {
      prompts += 1;
      return new Promise((resolve) => decisions.push(() => resolve({
        requestId: request.requestId,
        decision: "allow",
        scope: "once",
      })));
    },
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  const descriptor = {
    permission: "storage",
    resources: ["*"],
    reason: "Storage",
    operationId: "storage:concurrent",
  };
  const first = engine.authorize(runtimeContext(pluginManifest), descriptor);
  const second = engine.authorize(runtimeContext(pluginManifest), descriptor);
  assert.equal(prompts, 1);
  decisions.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 2);
  decisions.shift()();
  await second;
  database.close();
});

test("permission shutdown aborts pending prompts before grants can persist", async (context) => {
  const database = createDatabase(context);
  let resolveDecision;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: (request) => new Promise((resolve) => {
      resolveDecision = () => resolve({
        requestId: request.requestId,
        decision: "allow",
        scope: "always",
      });
    }),
  });
  const pluginManifest = manifest({ optional: ["storage"] });
  const pending = engine.authorize(runtimeContext(pluginManifest), {
    permission: "storage",
    resources: ["*"],
    reason: "Storage",
  });
  engine.shutdown();
  resolveDecision();
  await assert.rejects(pending, /unavailable/);
  assert.equal(database.listPermissionGrants(pluginManifest.id).length, 0);
  database.close();
});

for (const scope of ["application", "session", "always"]) {
test(`${scope} directory grants canonicalize origins and cover filesystem descendants`, async (context) => {
  const database = createDatabase(context);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-permission-root-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child", "file.txt");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, "hello");
  let prompts = 0;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      prompts += 1;
      return {
        requestId: request.requestId,
        decision: "allow",
        scope,
      };
    },
  });
  const pluginManifest = manifest({ optional: ["network", "filesystem.read"] });
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "network",
    resources: ["HTTPS://EXAMPLE.COM:443"],
    reason: "Network",
    ...(scope === "session" ? { sessionId: "terminal-session-1" } : {}),
  });
  if (scope === "always") {
    assert.equal(database.listPermissionGrants(pluginManifest.id)[0].resource, "https://example.com");
  }
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [root],
    resourceKinds: ["directory"],
    reason: "Read directory",
    ...(scope === "session" ? { sessionId: "terminal-session-1" } : {}),
  });
  const promptsBeforeDescendant = prompts;
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [child],
    reason: "Read descendant again",
    ...(scope === "session" ? { sessionId: "terminal-session-1" } : {}),
  });
  assert.equal(prompts, promptsBeforeDescendant);
  assert.equal(permissionResourceCovers("filesystem.read", root, child), false);
  assert.equal(permissionResourceCovers("filesystem.read", root, child, "directory"), true);
  assert.equal(permissionResourceCovers("filesystem.read", root, `${root}-outside`, "directory"), false);
  assert.equal(canonicalizeNetworkOrigin("https://example.com/"), "https://example.com");
  assert.throws(() => canonicalizeNetworkOrigin("https://example.com/path"), /without credentials or a path/);
  database.close();
});
}

test("an exact file grant cannot become a directory subtree grant after replacement", async (context) => {
  const database = createDatabase(context);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-permission-file-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = path.join(root, "selected");
  fs.writeFileSync(selected, "file");
  let prompts = 0;
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      prompts += 1;
      return { requestId: request.requestId, decision: "allow", scope: "always" };
    },
  });
  const pluginManifest = manifest({ optional: [{
    permission: "filesystem.read",
    resources: [root],
  }] });
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [selected],
    resourceKinds: ["exact"],
    reason: "Read file",
  });
  fs.rmSync(selected);
  fs.mkdirSync(selected);
  const child = path.join(selected, "child.txt");
  fs.writeFileSync(child, "child");
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [selected],
    resourceKinds: ["directory"],
    reason: "Read replacement directory",
  });
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [child],
    resourceKinds: ["exact"],
    reason: "Read replacement child",
  });
  assert.equal(prompts, 2);
  assert.deepEqual(database.listPermissionGrants(pluginManifest.id).map((grant) => (
    [grant.resource, grant.resourceKind]
  )), [[selected, "directory"]]);
  database.close();
});

test("companion resources accept canonical contribution identifiers", () => {
  const { canonicalizeCompanionResource } = require("./permissionResources.cjs");
  assert.equal(
    canonicalizeCompanionResource("com.example2.plugin.helper.process"),
    "com.example2.plugin.helper.process",
  );
  assert.throws(() => canonicalizeCompanionResource("com.example"));
  const pluginManifest = manifest({ optional: [] });
  const firstPackage = defaultSecurityPrincipal(pluginManifest, "a".repeat(64));
  const secondPackage = defaultSecurityPrincipal(pluginManifest, "b".repeat(64));
  assert.notEqual(firstPackage, secondPackage, "unsigned package updates cannot inherit grants");
  assert.match(firstPackage, /^unsigned-package:/u);
});

test("session grants require a host-owned session identifier", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "session",
    }),
  });
  const pluginManifest = manifest({ optional: ["terminal.metadata"] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "terminal.metadata",
    resources: ["*"] ,
    reason: "Read terminal metadata",
  }), /host-owned session/);
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "terminal.metadata",
    resources: ["*"],
    reason: "Read terminal metadata",
    sessionId: "terminal-session-1",
  });
  engine.revokeSession("terminal-session-1");
  database.close();
});

test("revoking a session aborts its pending permission prompt before it can grant", async (context) => {
  const database = createDatabase(context);
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: (_request, { signal }) => new Promise((_resolve, reject) => {
      promptStarted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const pluginManifest = manifest({ optional: ["terminal.metadata"] });
  const pending = engine.authorize(runtimeContext(pluginManifest), {
    permission: "terminal.metadata",
    resources: ["*"],
    reason: "Read terminal metadata",
    sessionId: "terminal-session-pending",
    allowedScopes: ["session"],
  });
  await started;
  engine.revokeSession("terminal-session-pending");
  await assert.rejects(pending, /session ended/u);
  assert.equal(engine.sessionGrants.size, 0);
  database.close();
});

test("host state is revalidated before a permission decision can persist", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "application",
    }),
  });
  const pluginManifest = manifest({ optional: ["terminal.metadata"] });
  await assert.rejects(engine.authorize(runtimeContext(pluginManifest), {
    permission: "terminal.metadata",
    resources: ["*"],
    reason: "Read terminal metadata",
    validateBeforeGrant: () => { throw new Error("runtime changed"); },
  }), /runtime changed/u);
  assert.equal(engine.applicationGrants.size, 0);
  database.close();
});

test("permission revocation aborts matching prompts and publishes a revocation event", async (context) => {
  const database = createDatabase(context);
  let started;
  const promptStarted = new Promise((resolve) => { started = resolve; });
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: (_request, { signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const events = [];
  engine.onDidRevoke((event) => events.push(event));
  const pluginManifest = manifest({ optional: ["terminal.metadata"] });
  const pending = engine.authorize(runtimeContext(pluginManifest), {
    permission: "terminal.metadata",
    resources: ["*"],
    reason: "Read terminal metadata",
  });
  await promptStarted;
  engine.revokeApplication(pluginManifest.id, "terminal.metadata", "*");
  await assert.rejects(pending, /revoked/u);
  assert.deepEqual(events, [{
    pluginId: pluginManifest.id,
    permission: "terminal.metadata",
    resource: "*",
    scope: "application",
  }]);
  database.close();
});

test("required preflight rejects missing or wildcard resource-scoped activation bounds", async (context) => {
  const database = createDatabase(context);
  const requested = [];
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      requested.push(request.permission);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  const pluginManifest = manifest({ required: ["network"] });
  await assert.rejects(engine.authorizeRequired({
    id: pluginManifest.id,
    activeVersion: pluginManifest.version,
    manifest: pluginManifest,
  }), /must declare resources/u);
  const wildcardManifest = manifest({ required: [{ permission: "network", resources: ["*"] }] });
  await assert.rejects(engine.authorizeRequired({
    id: wildcardManifest.id,
    activeVersion: wildcardManifest.version,
    manifest: wildcardManifest,
  }), /must not use wildcard resources/u);
  assert.deepEqual(requested, []);
  database.close();
});

test("required preflight prompts for non-resource permissions and bounded resources", async (context) => {
  const database = createDatabase(context);
  const requested = [];
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      requested.push({ permission: request.permission, resources: request.resources });
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  const pluginManifest = {
    ...manifest({ required: [
      "runtime.advanced",
      { permission: "network", resources: ["https://example.com"] },
    ] }),
    main: { node: "index.js" },
  };
  await engine.authorizeRequired({
    id: pluginManifest.id,
    activeVersion: pluginManifest.version,
    manifest: pluginManifest,
  });
  assert.deepEqual(requested, [
    { permission: "runtime.advanced", resources: ["*"] },
    { permission: "network", resources: ["https://example.com"] },
  ]);
  database.close();
});

test("required filesystem preflight preserves declared directory scope", async (context) => {
  const database = createDatabase(context);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-required-directory-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child.txt");
  let prompts = 0;
  const requests = [];
  const engine = new PluginPermissionEngine({
    database,
    requestDecision: async (request) => {
      prompts += 1;
      requests.push(request);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  const pluginManifest = manifest({ required: [{
    permission: "filesystem.read",
    resources: [root],
  }] });
  await engine.authorizeRequired({
    id: pluginManifest.id,
    activeVersion: pluginManifest.version,
    manifest: pluginManifest,
  });
  assert.deepEqual(requests[0].resourceKinds, ["directory"]);
  await engine.authorize(runtimeContext(pluginManifest), {
    permission: "filesystem.read",
    resources: [child],
    resourceKinds: ["exact"],
    reason: "Read declared descendant",
  });
  assert.equal(prompts, 1);
  database.close();
});

test("permission middleware rejects unclassified methods and permits explicit public methods", async (context) => {
  const database = createDatabase(context);
  const engine = new PluginPermissionEngine({ database });
  const middleware = engine.createMiddleware();
  await assert.rejects(middleware({
    pluginId: "com.example.permissions",
    method: "unclassified.method",
    metadata: {},
  }, async () => null), /no authorization policy/);
  assert.equal(await middleware({
    pluginId: "com.example.permissions",
    method: "log.write",
    metadata: { public: true },
  }, async () => "ok"), "ok");
  database.close();
});
