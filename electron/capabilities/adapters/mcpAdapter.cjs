"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const {
  getCapabilityByMcpTool,
  getCapabilityByRpcMethod,
  listCapabilities,
} = require("../registry.cjs");

function listMcpTools(surface = CAPABILITY_SURFACES.BUILTIN, options = {}) {
  const status = options.status || CAPABILITY_STATUS.IMPLEMENTED;
  return listCapabilities({ surface, status })
    .filter((capability) => capability.surfaces?.[surface]?.mcpTool)
    .map((capability) => ({
      id: capability.id,
      toolName: capability.surfaces[surface].mcpTool,
      rpcMethod: capability.surfaces[surface].rpcMethod,
      description: capability.description,
      policy: capability.policy,
      status: capability.status,
    }));
}

function getMcpToolRpcMethod(toolName, surface = CAPABILITY_SURFACES.BUILTIN) {
  const capability = getCapabilityByMcpTool(toolName, surface);
  return capability?.surfaces?.[surface]?.rpcMethod || null;
}

function getMcpToolNameForRpcMethod(rpcMethod, surface = CAPABILITY_SURFACES.BUILTIN) {
  const capability = getCapabilityByRpcMethod(rpcMethod, surface);
  return capability?.surfaces?.[surface]?.mcpTool || null;
}

module.exports = {
  listMcpTools,
  getMcpToolRpcMethod,
  getMcpToolNameForRpcMethod,
};
