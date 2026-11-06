"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { createNdjsonRpcClient } = require("../capabilities/rpcTransport.cjs");
const { DelegatedAgentScopes } = require("../plugins/agent/delegatedScope.cjs");
const { buildInjectedMcpServers } = require("./aiBridge/sdk/injectMcp.cjs");
const bridge = require("./mcpServerBridge.cjs");
const privacy = require("../shared/aiPrivacyService.cjs");

test("actual main TCP gate binds delegated credentials, scope and policy at worker dispatch without global mode changes", { timeout: 10_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-agent-mcp-test-"));
  const clients = []; const registrations = [];
  let effects = 0; let inventoryRequests = 0; let decisions = 0; let allowed = true; let targetRevision = "v1";
  let beforeWorker = () => {}; let authorize = async () => {};
  t.after(() => {
    for (const registration of registrations) registration.dispose();
    for (const client of clients) client.close();
    bridge.setPermissionMode("confirm"); bridge.cleanup();
    privacy.configure({ enabled: false });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  privacy.configure({ enabled: false });
  bridge.init({ sessions: new Map(), cliDiscoveryFilePath: path.join(directory, "discovery.json"),
    terminalWorkerManager: { request: async (method, _payload, options) => {
      if (method !== "netcatty:ai:exec") { inventoryRequests++; return []; }
      beforeWorker(); options?.beforeExecute?.(); effects++;
      return { ok: true, stdout: "synthetic output", stderr: "", exitCode: 0 };
    } } });
  bridge.setPermissionMode("observer");
  const port = await bridge.getOrCreateHost();
  const coreId = `plugin-agent:${randomUUID()}`;
  const turnTag = randomUUID();
  const owner = Object.freeze({ runtimeId: "r1", pluginId: "com.example.assistant", privateOwner: "opaque-source-a", sourceKey: "source-a" });
  const context = {};
  const scopes = new DelegatedAgentScopes({ resolveOwner: async () => owner, assertHostActive: async () => {},
    authorizeAction: async () => { decisions++; await authorize(); if (!allowed) throw Error("Denied by source policy"); } });
  const target = { kind: "terminal", id: "synthetic-a", owner: "window-7", revision: "v1",
    isCurrent: (snapshot) => snapshot.revision === targetRevision };
  const scope = await scopes.issue(context, { backend: { key: "configured-claude", revision: "1", isCurrent: () => true },
    targets: [target], capabilities: ["terminal.execute", "session.environment"] });
  let ticket = await scopes.begin(scope.handle, context);
  registrations.push(bridge.registerPluginAgentDelegation(coreId, {
    senderId: 7, turnTag, tools: ["get_environment", "terminal_execute"],
    assertCurrent: () => { if (ticket.controller.signal.aborted || targetRevision !== target.revision) throw Error("Stale delegation"); },
    dispatch: (method, params, execute) => {
      const capabilityId = method === "netcatty/exec" ? "terminal.execute" : method === "netcatty/getContext" ? "session.environment" : "unsupported";
      const targets = params.sessionId ? [{ ...target, id: params.sessionId }] : [];
      return scopes.dispatch(ticket, context, { capabilityId, targets }, execute);
    },
  }));
  bridge.updateSessionMetadata([{ sessionId: target.id, hostname: "fixture.invalid", label: "Synthetic A", protocol: "ssh" }], coreId);
  const appToken = bridge.buildMcpServerConfig(port, [], coreId).env.find((entry) => entry.name === "NETCATTY_MCP_TOKEN").value;
  const injected = await buildInjectedMcpServers({ mcpServerBridge: bridge, chatSessionId: coreId, toolIntegrationMode: "mcp", delegationTag: turnTag });
  const environment = Object.fromEntries(injected[0].env.map((entry) => [entry.name, entry.value]));
  assert.notEqual(environment.NETCATTY_MCP_TOKEN, appToken);
  assert.equal(environment.NETCATTY_MCP_PERMISSION_MODE, "confirm");
  assert.deepEqual(JSON.parse(environment.NETCATTY_MCP_DELEGATED_TOOLS), ["get_environment", "terminal_execute"]);
  async function connect(token) {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const client = createNdjsonRpcClient({ socket }); clients.push(client);
    await client.call("auth/verify", { token }); return client;
  }
  const app = await connect(appToken);
  await assert.rejects(app.call("netcatty/getContext", { chatSessionId: coreId }), /Delegated Agent credentials/);
  const client = await connect(environment.NETCATTY_MCP_TOKEN);
  await assert.rejects(client.call("netcatty/getContext", { chatSessionId: "builtin-chat" }), /cannot change/);
  const selected = await client.call("netcatty/getContext", {});
  assert.deepEqual(Object.keys(selected).sort(), ["description", "environment", "hostCount", "hosts"]);
  assert.deepEqual(selected.hosts.map((item) => item.sessionId), ["synthetic-a"]);
  assert.equal(inventoryRequests, 0, "delegated context must not query app-wide tunnel inventory");
  await assert.rejects(client.call("netcatty/getStatus", {}), /outside the Agent delegation/);
  const run = (sessionId = target.id) => client.call("netcatty/exec", { sessionId, command: "printf synthetic" });
  const beforeDecision = decisions;
  assert.equal((await run()).stdout, "synthetic output");
  assert.equal(effects, 1); assert.equal(decisions, beforeDecision + 1); assert.equal(bridge.getPermissionMode(), "observer");
  await assert.rejects(run("unselected-session")); assert.equal(effects, 1);
  allowed = false; await assert.rejects(run(), /Denied by source policy/); assert.equal(effects, 1);
  allowed = true;
  const entered = new Promise((resolve) => { authorize = async () => { resolve(); await new Promise((done) => { authorize = done; }); }; });
  const pending = run(); await entered;
  scopes.finish(ticket); authorize(); await assert.rejects(pending); assert.equal(effects, 1);
  ticket = await scopes.begin(scope.handle, context); authorize = async () => {};
  beforeWorker = () => { targetRevision = "v2"; };
  await assert.rejects(run()); assert.equal(effects, 1);
  registrations[0].dispose();
  await assert.rejects(app.call("netcatty/getContext", { chatSessionId: coreId }));
  assert.throws(() => bridge.getPluginAgentMcpConfiguration(coreId));
});

for (const sessions of [null, new Map()]) test(`delegated empty environment omits global tool inventory (${sessions === null ? "uninitialized" : "empty scope"})`, async (t) => {
  bridge.init({ sessions });
  const id = `plugin-agent:${randomUUID()}`; const tag = randomUUID();
  const registration = bridge.registerPluginAgentDelegation(id, { senderId: 7, turnTag: tag, tools: ["get_environment"],
    assertCurrent: () => {}, dispatch: (_method, _params, execute) => execute() });
  t.after(() => { registration.dispose(); bridge.cleanup(); });
  const value = await bridge.dispatchBuiltinRpc("netcatty/getContext", { chatSessionId: id }, { trustedAgentSenderId: 7, trustedAgentTurnTag: tag });
  assert.equal(Object.hasOwn(value, "tools"), false); assert.deepEqual(value.hosts, []);
});

test("MCP bridge retains existing CJS namespace exports for actual Catty harness consumers", async () => {
  const namespace = await import("./mcpServerBridge.cjs");
  for (const name of ["init", "cleanup", "dispatchBuiltinRpc", "registerPluginAgentDelegation"]) assert.equal(typeof namespace[name], "function", name);
});
