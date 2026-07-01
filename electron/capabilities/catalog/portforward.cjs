"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const PORT_FORWARD_CAPABILITIES = [
  {
    id: "portforward.rules.list",
    domain: "portforward",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List persisted port forwarding rules.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["portforward", "rules", "list"] },
      global: { rpcMethod: "portforward/rules/list" },
      public: { rpcMethod: "public/portforward/rules/list", mcpTool: "portforward_rules_list" },
    },
  },
  {
    id: "portforward.tunnels.list",
    domain: "portforward",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List active port forwarding tunnels.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      cli: { command: ["portforward", "tunnels", "list"] },
      global: { rpcMethod: "portforward/tunnels/list" },
      public: { rpcMethod: "public/portforward/tunnels/list", mcpTool: "portforward_tunnels_list" },
    },
  },
  {
    id: "portforward.start",
    domain: "portforward",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Start a port forwarding tunnel for a rule.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      cli: { command: ["portforward", "start"] },
      global: { rpcMethod: "portforward/start" },
      public: { rpcMethod: "public/portforward/start", mcpTool: "portforward_start" },
    },
  },
  {
    id: "portforward.stop",
    domain: "portforward",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Stop an active port forwarding tunnel.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: false,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      cli: { command: ["portforward", "stop"] },
      global: { rpcMethod: "portforward/stop" },
      public: { rpcMethod: "public/portforward/stop", mcpTool: "portforward_stop" },
    },
  },
];

module.exports = { PORT_FORWARD_CAPABILITIES };
