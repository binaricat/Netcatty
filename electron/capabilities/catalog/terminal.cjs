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
    id: "terminal.executeBulk",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Execute the same short command on several terminal sessions at once and wait for all of them.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
      // One approval covers many hosts, so remembered grants and session-wide
      // approvals must never satisfy it.
      requiresFreshApproval: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/execBulk", mcpTool: "terminal_execute_bulk" },
      public: { rpcMethod: "public/terminalExecuteBulk", mcpTool: "terminal_execute_bulk" },
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
  {
    id: "terminal.startBulk",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Start the same long-running command as a background job on several terminal sessions at once.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
      // One approval covers many hosts, so remembered grants and session-wide
      // approvals must never satisfy it.
      requiresFreshApproval: true,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/jobStartBulk", mcpTool: "terminal_start_bulk" },
      public: { rpcMethod: "public/terminalStartBulk", mcpTool: "terminal_start_bulk" },
    },
  },
  {
    id: "terminal.pollBulk",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Poll incremental output from several long-running terminal jobs at once.",
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
      builtin: { rpcMethod: "netcatty/jobPollBulk", mcpTool: "terminal_poll_bulk" },
      public: { rpcMethod: "public/terminalPollBulk", mcpTool: "terminal_poll_bulk" },
    },
  },
  {
    id: "terminal.stopBulk",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Stop several long-running terminal jobs at once.",
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
      builtin: { rpcMethod: "netcatty/jobStopBulk", mcpTool: "terminal_stop_bulk" },
      public: { rpcMethod: "public/terminalStopBulk", mcpTool: "terminal_stop_bulk" },
    },
  },
];

module.exports = { TERMINAL_CAPABILITIES };
