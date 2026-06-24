"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("../constants.cjs");
const {
  getCapabilityByCliCommand,
  listCapabilities,
} = require("../registry.cjs");

function getCliRpcMethod(commandParts) {
  const capability = getCapabilityByCliCommand(commandParts);
  if (!capability) return null;
  return capability.surfaces?.[CAPABILITY_SURFACES.BUILTIN]?.rpcMethod || null;
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
      rpcMethod: capability.surfaces?.[CAPABILITY_SURFACES.BUILTIN]?.rpcMethod || null,
      policy: capability.policy,
    }));
}

function formatCliHelpLines(options = {}) {
  return listCliCapabilities(options).flatMap((entry) => {
    const statusSuffix = entry.status === CAPABILITY_STATUS.PLANNED ? " (planned)" : "";
    return [`  netcatty-tool-cli ${entry.command.join(" ")}${statusSuffix}`];
  });
}

module.exports = {
  getCliRpcMethod,
  listCliCapabilities,
  formatCliHelpLines,
};
