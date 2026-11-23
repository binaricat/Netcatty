"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

function freezeJson(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

module.exports = {
  invalidArgument,
  freezeJson,
};
