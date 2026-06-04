const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInjectedMcpServers } = require("./injectMcp.cjs");

function fakeMcpBridge() {
  let hostStartCount = 0;
  return {
    get hostStartCount() { return hostStartCount; },
    getOrCreateHost: async () => {
      hostStartCount += 1;
      return 54321;
    },
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

test("skills mode starts the CLI host and returns no injected MCP config", async () => {
  const bridge = fakeMcpBridge();
  const res = await buildInjectedMcpServers({
    mcpServerBridge: bridge,
    chatSessionId: "chat-1",
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(res, []);
  assert.equal(bridge.hostStartCount, 1);
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
