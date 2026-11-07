"use strict";

const NETCATTY_MCP_SERVER_INSTRUCTIONS =
  "Call get_environment first; select by label or hostname and pass sessionId to terminal tools. Never use the local shell for Netcatty session commands. If none matches, use vault_hosts_list and host_open. 15 core tools start loaded. Use load_netcatty_tools: sessions, attachments, sftp_advanced, vault_hosts, vault_notes, snippets, scripts, portforward, or all. For disconnected in-scope sessions, load sessions; use session_reconnect/session_recover instead of host_open (creates a new tab).";

module.exports = { NETCATTY_MCP_SERVER_INSTRUCTIONS };
