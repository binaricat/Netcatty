"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CAPABILITY_STATUS } = require("../../capabilities/constants.cjs");
const { ALL_CAPABILITIES } = require("../../capabilities/catalog/index.cjs");
const { buildBuiltinRpcHandlerRegistry } = require("./builtinRpcHandlers.cjs");

/** Capability ids wired in mcpServerBridge.getBuiltinRpcHandlerRegistry(). */
const MCP_BRIDGE_BUILTIN_CAPABILITY_IDS = [
  "session.environment",
  "meta.status",
  "attachment.list",
  "attachment.read",
  "terminal.execute",
  "sftp.list",
  "sftp.read",
  "sftp.write",
  "sftp.download",
  "sftp.upload",
  "sftp.mkdir",
  "sftp.delete",
  "sftp.rename",
  "sftp.stat",
  "sftp.chmod",
  "sftp.home",
  "session.cancel",
  "terminal.start",
  "terminal.poll",
  "terminal.stop",
];

test("buildBuiltinRpcHandlerRegistry maps catalog builtin rpcMethod to handlers", () => {
  const handlersByCapabilityId = Object.fromEntries(
    MCP_BRIDGE_BUILTIN_CAPABILITY_IDS.map((id) => [id, async () => ({ ok: true, id })]),
  );
  const registry = buildBuiltinRpcHandlerRegistry(handlersByCapabilityId);

  for (const capabilityId of MCP_BRIDGE_BUILTIN_CAPABILITY_IDS) {
    const capability = ALL_CAPABILITIES.find((entry) => entry.id === capabilityId);
    assert.ok(capability, `missing catalog entry for ${capabilityId}`);
    const rpcMethod = capability.surfaces?.builtin?.rpcMethod;
    assert.ok(rpcMethod, `missing builtin rpcMethod for ${capabilityId}`);
    assert.equal(typeof registry.get(rpcMethod), "function", rpcMethod);
  }
});

test("every implemented netcatty/* builtin rpc has a bridge handler", () => {
  const handlersByCapabilityId = Object.fromEntries(
    MCP_BRIDGE_BUILTIN_CAPABILITY_IDS.map((id) => [id, async () => ({ ok: true })]),
  );
  const registry = buildBuiltinRpcHandlerRegistry(handlersByCapabilityId);

  const implementedBuiltinRpcMethods = ALL_CAPABILITIES
    .filter((capability) => capability.status === CAPABILITY_STATUS.IMPLEMENTED)
    .map((capability) => capability.surfaces?.builtin?.rpcMethod)
    .filter((rpcMethod) => typeof rpcMethod === "string" && rpcMethod.startsWith("netcatty/"));

  const uniqueRpcMethods = [...new Set(implementedBuiltinRpcMethods)];
  for (const rpcMethod of uniqueRpcMethods) {
    assert.equal(
      registry.has(rpcMethod),
      true,
      `no handler registered for ${rpcMethod}`,
    );
  }
});
