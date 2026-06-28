"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const {
  getCapabilityByCliCommand,
  listCapabilities,
} = require("../registry.cjs");
const { TOOL_INPUT_FIELDS } = require("../schemas/toolInputs.cjs");

/** Maps TOOL_INPUT_FIELDS keys to CLI flag names and opts property names. */
const CLI_FIELD_BINDINGS = Object.freeze({
  hostId: { flag: "--host-id", optKey: "hostId" },
  snippetId: { flag: "--snippet-id", optKey: "snippetId" },
  scriptId: { flag: "--script-id", optKey: "scriptId" },
  runId: { flag: "--run-id", optKey: "runId" },
  ruleId: { flag: "--rule-id", optKey: "ruleId" },
  notes: { flag: "--notes", optKey: "notes" },
  sessionId: { flag: "--session", optKey: "sessionId" },
  variables: { flag: "--variables", optKey: "variables" },
  wait: { flag: "--wait", optKey: "wait" },
  scriptIds: { flag: "--script-ids", optKey: "scriptIds" },
  label: { flag: "--label", optKey: "label" },
  kind: { flag: "--kind", optKey: "kind" },
  trigger: { flag: "--trigger", optKey: "trigger" },
  triggerPattern: { flag: "--trigger-pattern", optKey: "triggerPattern" },
  targets: { flag: "--targets", optKey: "targets" },
  targetsAllHosts: { flag: "--targets-all-hosts", optKey: "targetsAllHosts" },
  description: { flag: "--description", optKey: "description" },
  language: { flag: "--language", optKey: "language" },
  package: { flag: "--package", optKey: "package" },
  shortkey: { flag: "--shortkey", optKey: "shortkey" },
  noAutoRun: { flag: "--no-auto-run", optKey: "noAutoRun" },
  path: { flag: "--remote-path", optKey: "remotePath" },
  remotePath: { flag: "--remote-path", optKey: "remotePath" },
  localPath: { flag: "--local-path", optKey: "localPath" },
  oldPath: { flag: "--old-remote-path", optKey: "oldRemotePath" },
  newPath: { flag: "--new-remote-path", optKey: "newRemotePath" },
  content: { flag: "--content", optKey: "content" },
  mode: { flag: "--mode", optKey: "mode" },
  command: { flag: "--", optKey: "command" },
  jobId: { flag: "--job", optKey: "jobId" },
  offset: { flag: "--offset", optKey: "offset" },
});

function resolveCliRpcMethod(capability) {
  if (!capability) return null;
  return capability.surfaces?.[CAPABILITY_SURFACES.BUILTIN]?.rpcMethod
    || capability.surfaces?.[CAPABILITY_SURFACES.GLOBAL]?.rpcMethod
    || capability.surfaces?.[CAPABILITY_SURFACES.PUBLIC]?.rpcMethod
    || null;
}

function getCliRpcMethod(commandParts) {
  const capability = getCapabilityByCliCommand(commandParts);
  return resolveCliRpcMethod(capability);
}

function listCliCapabilities(options = {}) {
  const surface = options.surface || CAPABILITY_SURFACES.CLI;
  const status = Object.prototype.hasOwnProperty.call(options, "status")
    ? options.status
    : CAPABILITY_STATUS.IMPLEMENTED;
  return listCapabilities({ surface, status: status || undefined })
    .filter((capability) => Array.isArray(capability.surfaces?.[surface]?.command))
    .map((capability) => ({
      id: capability.id,
      domain: capability.domain,
      status: capability.status,
      description: capability.description,
      command: capability.surfaces[surface].command,
      rpcMethod: resolveCliRpcMethod(capability),
      policy: capability.policy,
    }));
}

function formatCliHelpLines(options = {}) {
  return listCliCapabilities(options).flatMap((entry) => {
    const statusSuffix = entry.status === CAPABILITY_STATUS.PLANNED ? " (planned)" : "";
    return [`  netcatty-tool-cli ${entry.command.join(" ")}${statusSuffix}`];
  });
}

function buildCatalogCliParams(capabilityId, opts, createError) {
  const fields = TOOL_INPUT_FIELDS[capabilityId];
  if (!fields) {
    return {};
  }

  const params = {};
  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const binding = CLI_FIELD_BINDINGS[fieldName];
    if (!binding) continue;

    let value = opts[binding.optKey];
    if (fieldName === "command" && Array.isArray(value)) {
      value = value.length === 1 ? value[0] : null;
    }
    if (fieldName === "variables" && typeof value === "string" && value.trim()) {
      try {
        value = JSON.parse(value);
      } catch {
        throw createError("INVALID_ARGUMENT", `--variables must be valid JSON for ${capabilityId}.`);
      }
    }
    if (fieldName === "offset" && value != null) {
      value = Number(value);
    }

    if (value == null || value === "") {
      if (!fieldDef.optional) {
        throw createError(
          "INVALID_ARGUMENT",
          `Missing required ${binding.flag} for ${capabilityId}.`,
        );
      }
      continue;
    }

    params[fieldName] = value;
  }

  return params;
}

module.exports = {
  CLI_FIELD_BINDINGS,
  buildCatalogCliParams,
  getCliRpcMethod,
  listCliCapabilities,
  formatCliHelpLines,
  resolveCliRpcMethod,
};
