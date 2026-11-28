"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PluginAISidebarService, buildQualifiedToolName, MAX_TOOLS_PER_PLUGIN } = require("./pluginAiSidebarService.cjs");

const manifest = Object.freeze({
  id: "com.example.db",
  name: "example-db",
  displayName: "Example DB",
  version: "1.0.0",
  features: {
    optional: ["ai.sidebar-tools"],
  },
  contributes: {
    views: [
      { id: "com.example.db.workbench", title: "Workbench", location: "vault-page" },
      { id: "com.example.db.panel", title: "Panel", location: "terminal-sidebar" },
    ],
  },
});

const manifestWithoutFeature = Object.freeze({
  ...manifest,
  features: {},
});

const ctx = (runtimeId = "rt-1") => ({
  pluginId: manifest.id,
  runtimeId,
  manifest,
});

test("PluginAISidebarService registers tools, enforces caps, and invokes via runtimeSupervisor", async () => {
  const calls = [];
  const stateUpdates = [];
  const service = new PluginAISidebarService({
    runtimeSupervisor: {
      async request(pluginId, method, params) {
        calls.push({ pluginId, method, params });
        return { ok: true, rows: 3 };
      },
    },
  });
  service.onDidChangeState((snapshot) => stateUpdates.push(snapshot));

  const regResult = service.registerTools({
    viewId: "com.example.db.workbench",
    tools: [
      {
        name: "db_list_tables",
        description: "List tables in active database",
        inputSchema: { type: "object", properties: { schema: { type: "string" } } },
        risk: "read",
      },
      {
        name: "db_pin_chart",
        description: "Pin chart to dashboard",
        inputSchema: { properties: { title: { type: "string" } } },
        risk: "write",
      },
    ],
  }, ctx());

  assert.equal(regResult.registered, 2);
  assert.equal(stateUpdates.length, 1);
  const state = service.getState();
  assert.equal(state.tools.length, 2);
  const listTool = state.tools.find((item) => item.name === "db_list_tables");
  assert.equal(listTool.qualifiedName, buildQualifiedToolName(manifest.id, "db_list_tables"));
  assert.ok(listTool.qualifiedName.length <= 64);
  assert.match(listTool.qualifiedName, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(listTool.risk, "read");
  assert.equal(state.tools.find((item) => item.name === "db_pin_chart").risk, "write");

  const result = await service.invokeTool({
    pluginId: manifest.id,
    toolName: "db_list_tables",
    args: { schema: "public" },
    viewId: "com.example.db.workbench",
    chatSessionId: "chat-1",
  });
  assert.deepEqual(result, { ok: true, rows: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "plugin.ai.invokeTool");
  assert.deepEqual(calls[0].params, {
    toolName: "db_list_tables",
    args: { schema: "public" },
    viewId: "com.example.db.workbench",
    chatSessionId: "chat-1",
  });

  // Cross-plugin viewId is rejected
  assert.throws(() => service.registerTools({
    viewId: "com.other.plugin.view",
    tools: [],
  }, ctx()), /another plugin|invalid/i);

  // Exceeding 16 tools per plugin is rejected
  const tooMany = Array.from({ length: MAX_TOOLS_PER_PLUGIN + 1 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool ${i}`,
    inputSchema: { type: "object", properties: {} },
  }));
  assert.throws(() => service.registerTools({ tools: tooMany }, ctx()), /invalid|at most 16/i);

  // Unregistered tool invocation rejects
  await assert.rejects(() => service.invokeTool({
    pluginId: manifest.id,
    toolName: "missing_tool",
    args: {},
  }), /not registered/i);

  service.shutdown();
});

test("PluginAISidebarService manages context, sidebar commands, lock, and runtime cleanup", () => {
  let locked = false;
  let lockListener = null;
  let contribListener = null;
  let revokeListener = null;
  const commands = [];

  const service = new PluginAISidebarService({
    isLocked: () => locked,
    subscribeLock: (cb) => { lockListener = cb; return () => { lockListener = null; }; },
    contributionService: { onDidChange: (cb) => { contribListener = cb; return { dispose() {} }; } },
    permissionEngine: { onDidRevoke: (cb) => { revokeListener = cb; return { dispose() {} }; } },
  });
  service.onDidEmitCommand((cmd) => commands.push(cmd));

  service.setContext({
    viewId: "com.example.db.workbench",
    title: "Production SQLite",
    subtitle: "12 tables",
    summary: "Tables: orders, customers, products",
    suggestedPrompts: [{ label: "Top revenue", prompt: "Show top products by revenue" }],
  }, ctx("rt-a"));
  assert.equal(service.getState().contexts.length, 1);
  assert.equal(service.getState().contexts[0].title, "Production SQLite");

  service.openSidebar({ prompt: "Analyze orders", autoSend: true }, ctx("rt-a"));
  service.closeSidebar({}, ctx("rt-a"));
  assert.equal(commands.length, 2);
  assert.equal(commands[0].action, "open");
  assert.equal(commands[0].viewId, "com.example.db.workbench");
  assert.equal(commands[0].autoSend, true);
  assert.equal(commands[1].action, "close");

  // App lock clears state and blocks mutations
  locked = true;
  lockListener({ locked: true });
  assert.equal(service.getState().contexts.length, 0);
  assert.throws(() => service.openSidebar({}, ctx("rt-a")), /locked/i);

  // Unlock and verify runtime/revocation/disable cleanup
  locked = false;
  service.setContext({ viewId: "com.example.db.workbench", title: "DB" }, ctx("rt-b"));
  assert.equal(service.getState().contexts.length, 1);
  service.releaseRuntime("rt-b");
  assert.equal(service.getState().contexts.length, 0);

  service.setContext({ viewId: "com.example.db.workbench", title: "DB2" }, ctx("rt-c"));
  contribListener({ reason: "plugin-disabled", pluginId: manifest.id });
  assert.equal(service.getState().contexts.length, 0);

  service.setContext({ viewId: "com.example.db.workbench", title: "DB3" }, ctx("rt-d"));
  revokeListener({ pluginId: manifest.id, permission: "ai.invoke" });
  assert.equal(service.getState().contexts.length, 0);

  // Host-side feature enforcement rejects plugins that do not declare ai.sidebar-tools
  const undeclaredCtx = { pluginId: manifest.id, runtimeId: "rt-e", manifest: manifestWithoutFeature };
  assert.throws(() => service.registerTools({ tools: [] }, undeclaredCtx), /ai\.sidebar-tools/i);
  assert.throws(() => service.setContext({ viewId: "com.example.db.workbench", title: "X" }, undeclaredCtx), /ai\.sidebar-tools/i);
  assert.throws(() => service.openSidebar({}, undeclaredCtx), /ai\.sidebar-tools/i);
  assert.throws(() => service.closeSidebar({}, undeclaredCtx), /ai\.sidebar-tools/i);

  service.shutdown();
});
