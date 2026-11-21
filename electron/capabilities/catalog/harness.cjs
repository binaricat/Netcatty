"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/** Renderer-local harness tools; terminal reading also exposes a scoped MCP entry. */
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
    id: "harness.terminal.read_context",
    agentKinds: ["sidebar", "global"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Read a bounded slice of the current terminal screen or scrollback from the active AI scope.",
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
      catty: { toolName: "terminal_read_context" },
      builtin: { rpcMethod: "netcatty/readContext", mcpTool: "terminal_read_context" },
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
  {
    id: "harness.vendor_assistant.ask",
    agentKinds: ["sidebar"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Ask a network vendor's official AI assistant (Huawei WeiKnow, Ruijie AZAI, H3C Zhiliao, Juniper, Aruba, Cisco) in a signed-in browser and return its answer text.",
    policy: {
      write: false,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "vendor_assistant_ask" },
      public: { rpcMethod: "netcatty/vendorAsk", mcpTool: "vendor_assistant_ask" },
      builtin: { rpcMethod: "netcatty/vendorAsk", mcpTool: "vendor_assistant_ask" },
    },
  },
  {
    id: "harness.vendor_assistant.list",
    agentKinds: ["sidebar"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List the supported vendor AI assistants with their sign-in state before asking one.",
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
      catty: { toolName: "vendor_assistant_list" },
      public: { rpcMethod: "netcatty/vendorList", mcpTool: "vendor_assistant_list" },
      builtin: { rpcMethod: "netcatty/vendorList", mcpTool: "vendor_assistant_list" },
    },
  },
  {
    id: "harness.ensp.list",
    agentKinds: ["sidebar"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "List eNSP Pro sandboxes and their devices (names and node ids) so one can be opened and driven with terminal tools.",
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
      catty: { toolName: "ensp_list" },
      public: { rpcMethod: "netcatty/enspList", mcpTool: "ensp_list" },
      builtin: { rpcMethod: "netcatty/enspList", mcpTool: "ensp_list" },
    },
  },
  {
    id: "harness.ensp.open",
    agentKinds: ["sidebar"],
    domain: "harness",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description: "Open an eNSP Pro device console by sandbox name/id and device name/node id, returning a sessionId that terminal_execute can drive.",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: true,
      bypassesChatCancel: true,
    },
    surfaces: {
      catty: { toolName: "ensp_open" },
      public: { rpcMethod: "netcatty/enspOpen", mcpTool: "ensp_open" },
      builtin: { rpcMethod: "netcatty/enspOpen", mcpTool: "ensp_open" },
    },
  },
];

module.exports = { HARNESS_CAPABILITIES };
