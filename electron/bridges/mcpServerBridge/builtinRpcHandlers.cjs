"use strict";

const { getCapabilityById } = require("../../capabilities/registry.cjs");

/**
 * Build rpcMethod → handler map from capability-id-keyed handlers.
 * Keeps dispatch aligned with catalog builtin RPC names.
 *
 * @param {Record<string, (params: object) => Promise<unknown> | unknown>} handlersByCapabilityId
 * @returns {{ get: (rpcMethod: string) => ((params: object) => unknown) | null, has: (rpcMethod: string) => boolean }}
 */
function buildBuiltinRpcHandlerRegistry(handlersByCapabilityId) {
  const byRpcMethod = new Map();

  for (const [capabilityId, handler] of Object.entries(handlersByCapabilityId)) {
    if (typeof handler !== "function") continue;
    const capability = getCapabilityById(capabilityId);
    const rpcMethod = capability?.surfaces?.builtin?.rpcMethod;
    if (!rpcMethod) continue;
    byRpcMethod.set(rpcMethod, handler);
  }

  return {
    get(rpcMethod) {
      return byRpcMethod.get(rpcMethod) || null;
    },
    has(rpcMethod) {
      return byRpcMethod.has(rpcMethod);
    },
  };
}

module.exports = {
  buildBuiltinRpcHandlerRegistry,
};
