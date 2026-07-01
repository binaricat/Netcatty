"use strict";

function createAssetSessionService(ctx = {}) {
  const { invokeAssetAction } = ctx;

  function requireBridge() {
    if (typeof invokeAssetAction !== "function") {
      return { ok: false, error: "Asset action bridge is unavailable." };
    }
    return null;
  }

  function call(op, params = {}) {
    const bridgeErr = requireBridge();
    if (bridgeErr) return bridgeErr;
    return invokeAssetAction(op, params);
  }

  return {
    open: async (params = {}) => call("asset.open", params),
    connect: async (params = {}) => call("asset.connect", params),
    disconnect: async (params = {}) => call("asset.disconnect", params),
    reconnect: async (params = {}) => call("asset.reconnect", params),
  };
}

module.exports = {
  createAssetSessionService,
};
