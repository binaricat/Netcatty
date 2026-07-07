"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function loadFreshBridge() {
  const bridgePath = require.resolve("../../bridges/mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("../../bridges/mcpServerBridge.cjs");
}

function envPairsToObject(envPairs) {
  const env = { ...process.env };
  for (const pair of envPairs || []) {
    if (!pair?.name) continue;
    env[pair.name] = String(pair.value ?? "");
  }
  return env;
}

test("MCP environment resource serializes terminal tool hints from Netcatty context", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const bridge = loadFreshBridge();
  const chatSessionId = `chat-resource-${Date.now()}`;
  let client = null;

  t.after(async () => {
    try {
      await client?.close();
    } catch {
      // Ignore teardown failures after a failed connect.
    }
    bridge.cleanup();
  });

  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      request() {
        throw new Error("resource context should not need a worker round trip");
      },
    },
  });
  bridge.setPermissionMode("auto");
  bridge.updateSessionMetadata([
    {
      sessionId: "ssh-1",
      hostname: "host.example",
      label: "Prod",
      username: "root",
      protocol: "ssh",
      shellType: "bash",
      connected: true,
    },
  ], chatSessionId);

  const port = await bridge.getOrCreateHost();
  const config = bridge.buildMcpServerConfig(port, [], chatSessionId);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: envPairsToObject(config.env),
  });
  client = new Client({ name: "netcatty-resource-test", version: "1.0.0" });
  await client.connect(transport);

  const resource = await client.readResource({ uri: "netcatty://context" });
  const text = resource.contents?.[0]?.text || "";
  const context = JSON.parse(text);

  assert.equal(context.hostCount, 1);
  assert.equal(context.hosts[0].sessionId, "ssh-1");
  assert.equal(context.tools.terminal.execute, "terminal_execute");
  assert.equal(context.tools.terminal.start, "terminal_start");
  assert.match(context.description, /terminal_execute/);
});
