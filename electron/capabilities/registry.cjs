"use strict";

const { ALL_CAPABILITIES } = require("./catalog/index.cjs");
const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("./constants.cjs");

function buildRegistryIndex(capabilities) {
  const byId = new Map();
  const byRpcMethod = new Map();
  const byMcpTool = new Map();
  const byCliCommand = new Map();
  const byDomain = new Map();

  for (const capability of capabilities) {
    byId.set(capability.id, capability);

    const domainList = byDomain.get(capability.domain) || [];
    domainList.push(capability);
    byDomain.set(capability.domain, domainList);

    for (const [surfaceName, binding] of Object.entries(capability.surfaces || {})) {
      if (binding?.rpcMethod) {
        byRpcMethod.set(`${surfaceName}:${binding.rpcMethod}`, capability);
      }
      if (binding?.mcpTool) {
        byMcpTool.set(`${surfaceName}:${binding.mcpTool}`, capability);
      }
      if (Array.isArray(binding?.command) && binding.command.length > 0) {
        byCliCommand.set(binding.command.join(" "), capability);
      }
    }
  }

  return {
    capabilities,
    byId,
    byRpcMethod,
    byMcpTool,
    byCliCommand,
    byDomain,
  };
}

const registryIndex = buildRegistryIndex(ALL_CAPABILITIES);

function listCapabilities(options = {}) {
  const { status, domain, surface } = options;
  return registryIndex.capabilities.filter((capability) => {
    if (status && capability.status !== status) return false;
    if (domain && capability.domain !== domain) return false;
    if (surface && !capability.surfaces?.[surface]) return false;
    return true;
  });
}

function getCapabilityById(id) {
  return registryIndex.byId.get(id) || null;
}

function getCapabilityByRpcMethod(rpcMethod, surface = CAPABILITY_SURFACES.BUILTIN) {
  return registryIndex.byRpcMethod.get(`${surface}:${rpcMethod}`) || null;
}

function getCapabilityByMcpTool(toolName, surface = CAPABILITY_SURFACES.BUILTIN) {
  return registryIndex.byMcpTool.get(`${surface}:${toolName}`) || null;
}

function getCapabilityByCliCommand(commandParts) {
  const key = Array.isArray(commandParts) ? commandParts.join(" ") : String(commandParts || "");
  return registryIndex.byCliCommand.get(key) || null;
}

function getRpcMethodsForSurface(surface, filter = {}) {
  const methods = new Set();
  for (const capability of registryIndex.capabilities) {
    const binding = capability.surfaces?.[surface];
    if (!binding?.rpcMethod) continue;
    if (filter.status && capability.status !== filter.status) continue;
    if (filter.write === true && !capability.policy.write) continue;
    if (filter.write === false && capability.policy.write) continue;
    if (filter.longRunning === true && !capability.policy.longRunning) continue;
    if (filter.longRunning === false && capability.policy.longRunning) continue;
    methods.add(binding.rpcMethod);
  }
  return methods;
}

function getImplementedRpcMethodsForSurface(surface) {
  return getRpcMethodsForSurface(surface, { status: CAPABILITY_STATUS.IMPLEMENTED });
}

module.exports = {
  ALL_CAPABILITIES,
  listCapabilities,
  getCapabilityById,
  getCapabilityByRpcMethod,
  getCapabilityByMcpTool,
  getCapabilityByCliCommand,
  getRpcMethodsForSurface,
  getImplementedRpcMethodsForSurface,
  buildRegistryIndex,
};
