"use strict";

function createNotImplementedResult(capabilityId) {
  return {
    ok: false,
    code: "CAPABILITY_NOT_IMPLEMENTED",
    error: `Capability "${capabilityId}" is not implemented yet.`,
  };
}

function createNotImplementedHandler(capabilityId) {
  return async () => createNotImplementedResult(capabilityId);
}

module.exports = {
  createNotImplementedResult,
  createNotImplementedHandler,
};
