"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  listMcpTools,
  getMcpToolRpcMethod,
  getMcpToolNameForRpcMethod,
  getMcpToolDefinition,
} = require("./mcpAdapter.cjs");
const { CAPABILITY_SURFACES } = require("../constants.cjs");
const { z } = require("zod");

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

test("getMcpToolDefinition derives zod input schema from catalog parameters", () => {
  const definition = getMcpToolDefinition("terminal_poll", CAPABILITY_SURFACES.BUILTIN, z);
  assert.equal(definition.toolName, "terminal_poll");
  const schema = z.object(definition.inputSchema);
  assert.deepEqual(schema.parse({ jobId: "job-1", offset: 3 }), { jobId: "job-1", offset: 3 });
  assert.throws(() => schema.parse({ jobId: "job-1", offset: -1 }));
});

test("public surface includes sftp tools for future public mcp registration", () => {
  const tools = listMcpTools(CAPABILITY_SURFACES.PUBLIC);
  const sftpList = tools.find((tool) => tool.toolName === "sftp_list");
  assert.ok(sftpList);
  assert.equal(sftpList.implementationStatus, "not_implemented");
  assert.match(sftpList.notImplementedReason, /not registered/);
  assert.equal(
    getMcpToolNameForRpcMethod("public/sftp/list", CAPABILITY_SURFACES.PUBLIC),
    "sftp_list",
  );
});
