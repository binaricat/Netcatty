const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");

function fakeMcpBridge() {
  return {
    getOrCreateHost: async () => 54321,
    getScopedSessionIds: (chatId) => (chatId === "chat-1" ? ["s1", "s2"] : []),
    buildMcpServerConfig: (port, ids, chatId) => ({
      name: "netcatty-remote-hosts",
      type: "stdio",
      command: "/path/electron",
      args: ["/path/netcatty-mcp-server.cjs"],
      env: [
        { name: "NETCATTY_MCP_PORT", value: String(port) },
        { name: "NETCATTY_MCP_CHAT_SESSION_ID", value: chatId },
      ],
    }),
  };
}

test("mcp mode returns netcatty MCP stdio config", async () => {
  const res = await buildInjectedMcpServers({
    mcpServerBridge: fakeMcpBridge(),
    chatSessionId: "chat-1",
    toolIntegrationMode: "mcp",
  });
  assert.equal(res.length, 1);
  assert.equal(res[0].name, "netcatty-remote-hosts");
  assert.equal(res[0].type, "stdio");
  assert.equal(res[0].command, "/path/electron");
  const portPair = res[0].env.find((p) => p.name === "NETCATTY_MCP_PORT");
  assert.equal(portPair.value, "54321");
});

test("non-mcp mode returns empty (skills uses the CLI instead)", async () => {
  const res = await buildInjectedMcpServers({
    mcpServerBridge: fakeMcpBridge(),
    chatSessionId: "chat-1",
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(res, []);
});

test("getOrCreateHost failure degrades to empty, not throw", async () => {
  const bridge = fakeMcpBridge();
  bridge.getOrCreateHost = async () => { throw new Error("port boom"); };
  const res = await buildInjectedMcpServers({
    mcpServerBridge: bridge,
    chatSessionId: "chat-1",
    toolIntegrationMode: "mcp",
  });
  assert.deepEqual(res, []);
});
