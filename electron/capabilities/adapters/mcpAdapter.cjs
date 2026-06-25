"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const {
  getCapabilityByMcpTool,
  getCapabilityByRpcMethod,
  listCapabilities,
} = require("../registry.cjs");

function getSurfaceBinding(capability, surface) {
  return capability?.surfaces?.[surface] || null;
}

function getSurfaceImplementationStatus(capability, surface) {
  const binding = getSurfaceBinding(capability, surface);
  return binding?.implementationStatus || "implemented";
}

function getSurfaceNotImplementedReason(capability, surface) {
  const binding = getSurfaceBinding(capability, surface);
  return binding?.notImplementedReason || null;
}

function buildZodField(parameter, zod) {
  let field;
  switch (parameter.type) {
    case "number":
      field = zod.number();
      break;
    case "integer":
      field = zod.number().int();
      break;
    case "boolean":
      field = zod.boolean();
      break;
    case "string":
    default:
      field = zod.string();
      break;
  }
  if (typeof parameter.min === "number" && typeof field.min === "function") {
    field = field.min(parameter.min);
  }
  if (parameter.description && typeof field.describe === "function") {
    field = field.describe(parameter.description);
  }
  if (parameter.optional && typeof field.optional === "function") {
    field = field.optional();
  }
  return field;
}

function buildMcpInputSchema(parameters = {}, zod) {
  if (!zod) return {};
  return Object.fromEntries(
    Object.entries(parameters).map(([name, parameter]) => [
      name,
      buildZodField(parameter, zod),
    ]),
  );
}

function toMcpToolEntry(capability, surface, zod = null) {
  const binding = getSurfaceBinding(capability, surface);
  return {
    id: capability.id,
    toolName: binding.mcpTool,
    rpcMethod: binding.rpcMethod,
    description: capability.description,
    parameters: capability.parameters || {},
    inputSchema: buildMcpInputSchema(capability.parameters, zod),
    policy: capability.policy,
    status: capability.status,
    implementationStatus: getSurfaceImplementationStatus(capability, surface),
    notImplementedReason: getSurfaceNotImplementedReason(capability, surface),
  };
}

function listMcpTools(surface = CAPABILITY_SURFACES.BUILTIN, options = {}) {
  const status = options.status || CAPABILITY_STATUS.IMPLEMENTED;
  const zod = options.zod || null;
  return listCapabilities({ surface, status })
    .filter((capability) => capability.surfaces?.[surface]?.mcpTool)
    .map((capability) => toMcpToolEntry(capability, surface, zod));
}

function getMcpToolRpcMethod(toolName, surface = CAPABILITY_SURFACES.BUILTIN) {
  const capability = getCapabilityByMcpTool(toolName, surface);
  return capability?.surfaces?.[surface]?.rpcMethod || null;
}

function getMcpToolNameForRpcMethod(rpcMethod, surface = CAPABILITY_SURFACES.BUILTIN) {
  const capability = getCapabilityByRpcMethod(rpcMethod, surface);
  return capability?.surfaces?.[surface]?.mcpTool || null;
}

function getMcpToolDefinition(toolName, surface = CAPABILITY_SURFACES.BUILTIN, zod = null) {
  const capability = getCapabilityByMcpTool(toolName, surface);
  if (!capability) return null;
  return toMcpToolEntry(capability, surface, zod);
}

module.exports = {
  listMcpTools,
  getMcpToolRpcMethod,
  getMcpToolNameForRpcMethod,
  getMcpToolDefinition,
  buildMcpInputSchema,
};
