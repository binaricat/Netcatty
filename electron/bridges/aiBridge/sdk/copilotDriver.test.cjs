const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCopilotSessionOptions,
  buildCopilotPermissionHandler,
  approveNetcattyMcpOnly,
  approveNetcattyCliShellOnly,
  isLikelyNetcattyCliShellCommand,
  copilotBuiltinTools,
} = require("./copilotDriver.cjs");

test("copilotBuiltinTools exposes bash+skill only in skills mode", () => {
  assert.equal(copilotBuiltinTools("mcp"), null);
  assert.deepEqual(copilotBuiltinTools("skills"), ["builtin:bash", "builtin:skill"]);
});

test("buildCopilotSessionOptions whitelists bash in skills mode and keeps MCP servers in mcp mode", () => {
  const mcpServers = [{
    name: "netcatty-remote-hosts",
    command: "/abs/electron",
    args: ["/abs/server.cjs"],
    env: [{ name: "NETCATTY_MCP_PORT", value: "1" }],
  }];

  const mcp = buildCopilotSessionOptions({
    model: "gpt-5",
    injectedMcpServers: mcpServers,
    toolIntegrationMode: "mcp",
  });
  assert.equal(mcp.model, "gpt-5");
  assert.equal(mcp.streaming, true);
  assert.ok(mcp.mcpServers["netcatty-remote-hosts"]);
  assert.equal(mcp.availableTools, undefined);

  const skills = buildCopilotSessionOptions({
    model: "gpt-5",
    injectedMcpServers: [],
    toolIntegrationMode: "skills",
  });
  assert.deepEqual(skills.availableTools, ["builtin:bash", "builtin:skill"]);
  assert.deepEqual(skills.mcpServers, {});
});

test("approveNetcattyMcpOnly allows MCP and rejects shell", () => {
  assert.deepEqual(
    approveNetcattyMcpOnly({ kind: "mcp", toolName: "terminal_execute" }),
    { kind: "approve-once" },
  );
  assert.equal(
    approveNetcattyCliShellOnly({ kind: "shell", fullCommandText: "pwd" }).kind,
    "reject",
  );
  assert.equal(
    approveNetcattyMcpOnly({ kind: "shell", fullCommandText: "netcatty-tool-cli status --json" }).kind,
    "reject",
  );
});

test("approveNetcattyCliShellOnly allows Netcatty CLI shell commands only", () => {
  assert.deepEqual(
    approveNetcattyCliShellOnly({
      kind: "shell",
      fullCommandText: 'node "/Applications/Netcatty.app/.../netcatty-tool-cli.cjs" env --chat-session abc --json',
    }),
    { kind: "approve-once" },
  );
  assert.equal(
    approveNetcattyCliShellOnly({ kind: "shell", fullCommandText: "pwd" }).kind,
    "reject",
  );
  assert.equal(
    approveNetcattyCliShellOnly({ kind: "write", fileName: "foo.txt" }).kind,
    "reject",
  );
});

test("buildCopilotPermissionHandler selects MCP vs skills gate", () => {
  assert.equal(buildCopilotPermissionHandler("mcp"), approveNetcattyMcpOnly);
  assert.equal(buildCopilotPermissionHandler("skills"), approveNetcattyCliShellOnly);
});

test("isLikelyNetcattyCliShellCommand matches launcher and script invocations", () => {
  assert.equal(isLikelyNetcattyCliShellCommand('netcatty-tool-cli status --json'), true);
  assert.equal(isLikelyNetcattyCliShellCommand('node electron/cli/netcatty-tool-cli.cjs env --json'), true);
  assert.equal(isLikelyNetcattyCliShellCommand("ls -la"), false);
});
