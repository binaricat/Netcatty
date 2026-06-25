"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALL_CAPABILITIES,
  getCapabilityById,
  getCapabilityByRpcMethod,
  getCapabilityByMcpTool,
  getCapabilityByCliCommand,
  listCapabilities,
} = require("./registry.cjs");
const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("./constants.cjs");

test("registry contains implemented capabilities", () => {
  assert.ok(ALL_CAPABILITIES.length >= 20);
  const implemented = listCapabilities({ status: CAPABILITY_STATUS.IMPLEMENTED });
  assert.ok(implemented.length >= 20);
});

test("registry resolves builtin rpc methods and mcp tools", () => {
  const exec = getCapabilityByRpcMethod("netcatty/exec", CAPABILITY_SURFACES.BUILTIN);
  assert.equal(exec?.id, "terminal.execute");
  const tool = getCapabilityByMcpTool("terminal_execute", CAPABILITY_SURFACES.BUILTIN);
  assert.equal(tool?.id, "terminal.execute");
});

test("registry resolves public rpc aliases for future surfaces", () => {
  const publicExec = getCapabilityByRpcMethod("public/terminalExecute", CAPABILITY_SURFACES.PUBLIC);
  assert.equal(publicExec?.id, "terminal.execute");
  assert.equal(publicExec?.status, CAPABILITY_STATUS.IMPLEMENTED);
});

test("registry resolves cli commands", () => {
  const env = getCapabilityByCliCommand(["env"]);
  assert.equal(env?.id, "session.environment");
  const sftpList = getCapabilityByCliCommand(["sftp", "list"]);
  assert.equal(sftpList?.id, "sftp.list");
});

test("vault and portforward capabilities are implemented", () => {
  assert.equal(getCapabilityById("vault.host.notes.get")?.status, CAPABILITY_STATUS.IMPLEMENTED);
  assert.equal(getCapabilityById("portforward.start")?.status, CAPABILITY_STATUS.IMPLEMENTED);
});
