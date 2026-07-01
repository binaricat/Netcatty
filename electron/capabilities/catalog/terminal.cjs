"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const TERMINAL_CAPABILITIES = [
  {
    id: "terminal.execute",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Execute a short command in a terminal session and wait for completion.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/exec", mcpTool: "terminal_execute" },
      public: { rpcMethod: "public/terminalExecute", mcpTool: "terminal_execute" },
      cli: { command: ["exec"] },
    },
  },
  {
    id: "terminal.start",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Start a long-running command in a terminal session.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/jobStart", mcpTool: "terminal_start" },
      public: { rpcMethod: "public/terminalStart", mcpTool: "terminal_start" },
      cli: { command: ["job-start"] },
    },
  },
  {
    id: "terminal.poll",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Poll incremental output from a long-running terminal job.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/jobPoll", mcpTool: "terminal_poll" },
      public: { rpcMethod: "public/terminalPoll", mcpTool: "terminal_poll" },
      cli: { command: ["job-poll"] },
    },
  },
  {
    id: "terminal.stop",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Stop a long-running terminal job.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: false,
      requiresChatSession: true,
      bypassesObserverBlock: true,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/jobStop", mcpTool: "terminal_stop" },
      public: { rpcMethod: "public/terminalStop", mcpTool: "terminal_stop" },
      cli: { command: ["job-stop"] },
    },
  },
];

module.exports = { TERMINAL_CAPABILITIES };
