"use strict";

const { CAPABILITY_STATUS, CAPABILITY_SURFACES } = require("./constants.cjs");
const { getCapabilityByRpcMethod } = require("./registry.cjs");

function createRegistryDispatcher({
  surface = CAPABILITY_SURFACES.BUILTIN,
  handlers = {},
  fallback,
}) {
  if (typeof fallback !== "function") {
    throw new Error("fallback handler is required");
  }

  return async function dispatchRpc(rpcMethod, params = {}) {
    const capability = getCapabilityByRpcMethod(rpcMethod, surface);
    if (!capability) {
      return fallback(rpcMethod, params);
    }
    if (capability.status !== CAPABILITY_STATUS.IMPLEMENTED) {
      return {
        ok: false,
        error: `Capability "${capability.id}" is not implemented yet.`,
        code: "CAPABILITY_NOT_IMPLEMENTED",
      };
    }

    const handler = handlers[capability.id];
    if (typeof handler !== "function") {
      return fallback(rpcMethod, params, capability);
    }

    return await handler(params, capability);
  };
}

module.exports = {
  createRegistryDispatcher,
};
