"use strict";

const { createNotImplementedHandler } = require("./notImplemented.cjs");

/**
 * Port forwarding domain service skeleton. Implementation will delegate to
 * portForwardingBridge once rules are accessible from the main process.
 */
function createPortForwardService(_ctx = {}) {
  return {
    listRules: createNotImplementedHandler("portforward.rules.list"),
    listTunnels: createNotImplementedHandler("portforward.tunnels.list"),
    start: createNotImplementedHandler("portforward.start"),
    stop: createNotImplementedHandler("portforward.stop"),
  };
}

module.exports = {
  createPortForwardService,
};
