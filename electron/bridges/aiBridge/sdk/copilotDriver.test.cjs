const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCopilotClientOptions, buildCopilotSessionOptions, extractCopilotContent, mapCopilotModels } = require("./copilotDriver.cjs");

test("buildCopilotClientOptions pins cliPath", () => {
  const o = buildCopilotClientOptions({ cliPath: "/abs/copilot" });
  assert.equal(o.cliPath, "/abs/copilot");
});

test("buildCopilotSessionOptions maps injected MCP to local stdio servers", () => {
  const o = buildCopilotSessionOptions({
    model: "claude-sonnet-4.5",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts", command: "/abs/electron",
      args: ["/abs/server.cjs"], env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
    }],
  });
  assert.equal(o.model, "claude-sonnet-4.5");
  const srv = o.mcpServers["netcatty-remote-hosts"];
  assert.equal(srv.type, "stdio");
  assert.equal(srv.command, "/abs/electron");
  assert.deepEqual(srv.env, { NETCATTY_MCP_PORT: "1" });
  assert.deepEqual(srv.tools, ["*"]);
  // onPermissionRequest is wired in runCopilotTurn via the SDK's approveAll,
  // not in buildCopilotSessionOptions.
});

test("extractCopilotContent reads response data.content", () => {
  assert.equal(extractCopilotContent({ data: { content: "hi" } }), "hi");
  assert.equal(extractCopilotContent(null), "");
  assert.equal(extractCopilotContent({ data: {} }), "");
});

test("mapCopilotModels maps {id,name} and drops entries without id", () => {
  const out = mapCopilotModels([
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "gpt-5" },
    { name: "no id -> dropped" },
  ]);
  assert.deepEqual(out, [
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "gpt-5", name: "gpt-5" },
  ]);
  assert.deepEqual(mapCopilotModels(undefined), []);
});
