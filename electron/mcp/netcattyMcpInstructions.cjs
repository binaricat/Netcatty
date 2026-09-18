"use strict";

const NETCATTY_MCP_SERVER_INSTRUCTIONS =
  "Use Netcatty tools for terminals, hosts, SFTP, vault, snippets/scripts, and port forwards. For terminal work, call get_environment first; select by label or hostname and pass sessionId to terminal_execute/terminal_start. Never use the local shell for Netcatty session commands. If none matches, use vault_hosts_list and host_open. 15 core tools start loaded. For attachments, advanced SFTP, vault/notes, snippets, scripts, or port forwards, call load_netcatty_tools with a toolset; use all for every tool.";

module.exports = { NETCATTY_MCP_SERVER_INSTRUCTIONS };
