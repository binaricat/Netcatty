"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  listMcpTools,
  getMcpToolRpcMethod,
  getMcpToolNameForRpcMethod,
} = require("./mcpAdapter.cjs");
const { CAPABILITY_SURFACES } = require("../constants.cjs");

test("listMcpTools exposes builtin terminal tools", () => {
  const tools = listMcpTools(CAPABILITY_SURFACES.BUILTIN);
  assert.ok(tools.some((tool) => tool.toolName === "terminal_execute"));
  assert.ok(tools.every((tool) => tool.rpcMethod));
});

test("getMcpToolRpcMethod resolves tool names", () => {
  assert.equal(
    getMcpToolRpcMethod("terminal_execute", CAPABILITY_SURFACES.BUILTIN),
    "netcatty/exec",
  );
});

test("public surface includes sftp tools for future public mcp registration", () => {
  const tools = listMcpTools(CAPABILITY_SURFACES.PUBLIC);
  assert.ok(tools.some((tool) => tool.toolName === "sftp_list"));
  assert.equal(
    getMcpToolNameForRpcMethod("public/sftp/list", CAPABILITY_SURFACES.PUBLIC),
    "sftp_list",
  );
});
