"use strict";

const portForwardingBridge = require("../../bridges/portForwardingBridge.cjs");

/**
 * Port forwarding domain service. Tunnels live in main; rules live in renderer vault.
 */
function createPortForwardService(ctx = {}) {
  const { invokeVaultAgent } = ctx;

  return {
    listRules: async () => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.rules.list", {});
    },
    listTunnels: async () => {
      const tunnels = await portForwardingBridge.listPortForwards();
      return { ok: true, tunnels };
    },
    start: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.start", {
        ruleId: params.ruleId,
        chatSessionId: params.chatSessionId,
      });
    },
    stop: async (params = {}) => {
      if (typeof invokeVaultAgent !== "function") {
        return { ok: false, error: "Vault agent bridge is unavailable." };
      }
      return invokeVaultAgent("portforward.stop", {
        ruleId: params.ruleId,
        chatSessionId: params.chatSessionId,
      });
    },
  };
}

module.exports = {
  createPortForwardService,
};
