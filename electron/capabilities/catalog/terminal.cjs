"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** @type {import("../types.cjs").CapabilityDefinition[]} */
const TERMINAL_CAPABILITIES = [
  {
    id: "terminal.execute",
    domain: "terminal",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Execute a short command on a Netcatty terminal session and wait for the full result. Use this only for commands expected to finish within about 60 seconds. For long-running commands such as builds, scans, log-following, or anything likely to exceed that budget, use terminal_start and then terminal_poll instead.",
    parameters: {
      sessionId: {
        type: "string",
        description: "The terminal session ID (from get_environment or workspace_get_info) to execute on.",
      },
      command: {
        type: "string",
        description: "The command to execute in the target session.",
      },
    },
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
    description: "Start a long-running command on a Netcatty terminal session without waiting for final completion. The command still runs in the visible terminal/PTTY so the user can watch live output. Prefer this whenever the command may exceed about 2 minutes, or when it streams output for an extended period, such as builds, scans, watch commands, and log-follow commands. After starting, wait at least about 30 seconds before the first terminal_poll unless you have a strong reason to check sooner.",
    parameters: {
      sessionId: {
        type: "string",
        description: "The terminal session ID (from get_environment or workspace_get_info) to execute on.",
      },
      command: {
        type: "string",
        description: "The command to start in the target session.",
      },
    },
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
    description: "Poll a long-running Netcatty command that was started with terminal_start. Returns incremental output since the given offset and the current status. Use the returned nextOffset for the next poll. If outputTruncated is true, only the retained tail starting at outputBaseOffset is still available. Do not poll aggressively: wait at least about 30 seconds between polls unless the tool output explicitly justifies checking sooner. As soon as completed is true, stop polling and analyze the final result immediately.",
    parameters: {
      jobId: {
        type: "string",
        description: "The background job ID returned by terminal_start.",
      },
      offset: {
        type: "integer",
        optional: true,
        min: 0,
        description: "Character offset previously returned as nextOffset. Omit or use 0 on the first poll.",
      },
    },
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
    description: "Stop a long-running Netcatty command that was started with terminal_start. This sends Ctrl+C to the running terminal job and returns its latest state.",
    parameters: {
      jobId: {
        type: "string",
        description: "The background job ID returned by terminal_start.",
      },
    },
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
