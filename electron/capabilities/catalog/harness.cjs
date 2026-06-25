"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** Catty-only harness tools (sidebar agent; renderer-local; not MCP/CLI). */
/** @type {import("../types.cjs").CapabilityDefinition[]} */
const HARNESS_CAPABILITIES = [
  {
    id: "harness.tool_output.read",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read stored tool output by handle id when a prior tool result was truncated.",
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
      catty: { toolName: "tool_output_read" },
    },
  },
  {
    id: "harness.workspace.get_info",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get information about the current workspace, including all terminal sessions and their connection status.",
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
      catty: { toolName: "workspace_get_info" },
    },
  },
  {
    id: "harness.workspace.get_session_info",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Get detailed information about a specific terminal or SFTP session.",
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
      catty: { toolName: "workspace_get_session_info" },
    },
  },
  {
    id: "harness.web.search",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Search the web for current information when configured in AI settings.",
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
      catty: { toolName: "web_search" },
    },
  },
  {
    id: "harness.url.fetch",
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Fetch and read the content of an HTTPS URL.",
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
      catty: { toolName: "url_fetch" },
    },
  },
];

module.exports = { HARNESS_CAPABILITIES };
