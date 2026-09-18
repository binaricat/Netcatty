"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  NETCATTY_MCP_SERVER_INSTRUCTIONS,
} = require("./netcattyMcpInstructions.cjs");

test("MCP server instructions route Netcatty terminal work through environment discovery", () => {
  assert.ok(NETCATTY_MCP_SERVER_INSTRUCTIONS.length <= 512);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /call get_environment first/i);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /label or hostname/i);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /sessionId/);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /Never use the local shell/i);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /vault_hosts_list and host_open/);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /load_netcatty_tools/);
  assert.match(NETCATTY_MCP_SERVER_INSTRUCTIONS, /15 core tools/);
});

test("stdio MCP server publishes the routing instructions during initialization", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "netcatty-mcp-server.cjs"),
    "utf8",
  );
  assert.match(source, /instructions:\s*NETCATTY_MCP_SERVER_INSTRUCTIONS/);
});
