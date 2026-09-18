"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");

const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
const {
  CORE_MCP_TOOL_NAMES,
  DEFERRED_MCP_TOOLSETS,
  MCP_TOOL_LOADER_NAME,
  buildProgressiveMcpCatalog,
  registerProgressiveMcpTools,
} = require("./progressiveMcpTools.cjs");

function createFakeServer() {
  const registrations = [];
  const handlers = new Map();
  return {
    registrations,
    handlers,
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (handlers.has(name)) throw new Error(`Tool ${name} is already registered`);
      const handler = typeof schemaOrHandler === "function" ? schemaOrHandler : maybeHandler;
      registrations.push(name);
      handlers.set(name, handler);
      return { enabled: true };
    },
  };
}

function createDeps() {
  return {
    rpcCall: async () => ({ ok: true }),
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  };
}

function readTextResult(result) {
  return JSON.parse(result.content[0].text);
}

test("progressive MCP catalog assigns every non-core catalog tool exactly once", () => {
  const allNames = listMcpTools().map(tool => tool.mcpTool);
  const deferredNames = Object.values(DEFERRED_MCP_TOOLSETS).flat();

  assert.deepEqual(CORE_MCP_TOOL_NAMES, [
    "get_environment",
    "session_close",
    "terminal_execute",
    "terminal_start",
    "terminal_poll",
    "terminal_stop",
    "sftp_list",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_download",
    "sftp_upload",
    "vault_hosts_list",
    "host_open",
    "terminal_read_context",
  ]);
  assert.equal(new Set(deferredNames).size, deferredNames.length);
  assert.deepEqual(
    new Set([...CORE_MCP_TOOL_NAMES, ...deferredNames]),
    new Set(allNames),
  );
  assert.doesNotThrow(() => buildProgressiveMcpCatalog());
});

test("progressive MCP registration initially exposes exactly 15 core tools", () => {
  const server = createFakeServer();
  const result = registerProgressiveMcpTools(server, createDeps());

  assert.equal(result.initialToolCount, 15);
  assert.equal(server.registrations.length, 15);
  assert.deepEqual(
    new Set(server.registrations),
    new Set([MCP_TOOL_LOADER_NAME, ...CORE_MCP_TOOL_NAMES]),
  );
});

test("loading a deferred MCP toolset is selective and idempotent", async () => {
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps());
  const loadTools = server.handlers.get(MCP_TOOL_LOADER_NAME);

  const first = readTextResult(await loadTools({ toolset: "attachments" }));
  assert.deepEqual(first.newlyLoaded, DEFERRED_MCP_TOOLSETS.attachments);
  assert.deepEqual(first.alreadyLoaded, []);
  assert.equal(server.registrations.length, 17);
  assert.equal(server.handlers.has("scripts_list"), false);

  const second = readTextResult(await loadTools({ toolset: "attachments" }));
  assert.deepEqual(second.newlyLoaded, []);
  assert.deepEqual(second.alreadyLoaded, DEFERRED_MCP_TOOLSETS.attachments);
  assert.equal(server.registrations.length, 17);
});

test("loading all makes every catalog MCP tool available", async () => {
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps());
  const loadTools = server.handlers.get(MCP_TOOL_LOADER_NAME);

  await loadTools({ toolset: "vault_notes" });
  const result = readTextResult(await loadTools({ toolset: "all" }));
  const catalogNames = listMcpTools().map(tool => tool.mcpTool);

  assert.deepEqual(result.alreadyLoaded, DEFERRED_MCP_TOOLSETS.vault_notes);
  assert.equal(result.loadedCatalogToolCount, catalogNames.length);
  assert.equal(result.visibleToolCount, catalogNames.length + 1);
  assert.equal(result.remainingCatalogToolCount, 0);
  assert.deepEqual(
    new Set(server.registrations),
    new Set([MCP_TOOL_LOADER_NAME, ...catalogNames]),
  );
});

test("MCP clients receive the updated tool list without reconnecting", async () => {
  const server = new McpServer({ name: "progressive-test", version: "1.0.0" });
  registerProgressiveMcpTools(server, createDeps());

  const client = new Client({ name: "progressive-test-client", version: "1.0.0" });
  let listChangedNotifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChangedNotifications += 1;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const initial = await client.listTools();
    assert.equal(initial.tools.length, 15);
    assert.equal(initial.tools.some(tool => tool.name === "list_attachments"), false);

    await client.callTool({
      name: MCP_TOOL_LOADER_NAME,
      arguments: { toolset: "attachments" },
    });

    const updated = await client.listTools();
    assert.ok(listChangedNotifications >= 1);
    assert.equal(updated.tools.length, 17);
    assert.equal(updated.tools.some(tool => tool.name === "list_attachments"), true);
    assert.equal(updated.tools.some(tool => tool.name === "read_attachment"), true);
  } finally {
    await client.close();
  }
});
