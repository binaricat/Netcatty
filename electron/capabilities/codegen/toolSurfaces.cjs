"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const { ALL_CAPABILITIES } = require("../catalog/index.cjs");
const { TOOL_INPUT_FIELDS, MODEL_DESCRIPTION_HINTS } = require("../schemas/toolInputs.cjs");

function buildZodShape(fields) {
  const shape = {};
  for (const [key, field] of Object.entries(fields || {})) {
    shape[key] = {
      type: field.type,
      optional: Boolean(field.optional),
      description: field.description || "",
    };
  }
  return shape;
}

function getMcpToolName(capability) {
  return capability.surfaces?.public?.mcpTool
    || capability.surfaces?.builtin?.mcpTool
    || null;
}

function getCattyToolName(capability) {
  return capability.surfaces?.[CAPABILITY_SURFACES.CATTY]?.toolName
    || getMcpToolName(capability)
    || capability.id.replace(/\./g, "_");
}

function buildToolDescription(capability) {
  const hint = MODEL_DESCRIPTION_HINTS[capability.id];
  if (!hint) return capability.description;
  return `${capability.description} ${hint}`;
}

function listToolSurfaces(options = {}) {
  const {
    surface = CAPABILITY_SURFACES.PUBLIC,
    status = CAPABILITY_STATUS.IMPLEMENTED,
    includeCatty = true,
  } = options;

  const tools = [];

  for (const capability of ALL_CAPABILITIES) {
    if (capability.status !== status) continue;
    const binding = capability.surfaces?.[surface] || capability.surfaces?.public || capability.surfaces?.builtin;
    if (!binding) continue;

    const mcpTool = getMcpToolName(capability);
    const cattyToolName = getCattyToolName(capability);
    if (!includeCatty && !mcpTool) continue;

    const builtinRpc = capability.surfaces?.builtin?.rpcMethod || binding.rpcMethod || null;

    tools.push({
      capabilityId: capability.id,
      domain: capability.domain,
      toolName: cattyToolName,
      mcpTool,
      rpcMethod: builtinRpc,
      publicRpcMethod: capability.surfaces?.public?.rpcMethod || null,
      description: buildToolDescription(capability),
      policy: capability.policy,
      inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
      cattyEnabled: includeCatty && Boolean(TOOL_INPUT_FIELDS[capability.id] != null || mcpTool),
    });
  }

  return tools;
}

function listMcpTools() {
  return listToolSurfaces({ surface: CAPABILITY_SURFACES.PUBLIC, includeCatty: false })
    .filter((tool) => tool.mcpTool);
}

/** Capabilities excluded from Catty even when implemented (CLI-only / meta). */
const CATTY_CAPABILITY_DENYLIST = new Set([
  "meta.status",
  "session.cancel",
  "session.resume",
  "session.get",
]);

function isCattyOnlyCapability(capability) {
  return Boolean(capability.surfaces?.[CAPABILITY_SURFACES.CATTY]?.toolName)
    && !capability.surfaces?.builtin?.rpcMethod
    && !capability.surfaces?.public?.mcpTool;
}

function isCattyEligible(capability) {
  if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) return false;
  if (CATTY_CAPABILITY_DENYLIST.has(capability.id)) return false;
  const hasInputFields = Object.prototype.hasOwnProperty.call(TOOL_INPUT_FIELDS, capability.id);
  if (!hasInputFields) return false;
  if (isCattyOnlyCapability(capability)) return true;
  const hasBuiltinRpc = Boolean(capability.surfaces?.builtin?.rpcMethod);
  return hasBuiltinRpc || Boolean(getMcpToolName(capability));
}

function listCattyToolSpecs() {
  return ALL_CAPABILITIES
    .filter((capability) => isCattyEligible(capability))
    .map((capability) => ({
      capabilityId: capability.id,
      toolName: getCattyToolName(capability),
      rpcMethod: capability.surfaces?.builtin?.rpcMethod || null,
      localExecution: isCattyOnlyCapability(capability),
      description: buildToolDescription(capability),
      inputShape: buildZodShape(TOOL_INPUT_FIELDS[capability.id]),
      policy: capability.policy,
    }));
}

module.exports = {
  buildZodShape,
  buildToolDescription,
  CATTY_CAPABILITY_DENYLIST,
  getCattyToolName,
  isCattyEligible,
  isCattyOnlyCapability,
  listToolSurfaces,
  listMcpTools,
  listCattyToolSpecs,
};
