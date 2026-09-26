---
name: netcatty-mcp
description: Use when the user asks to inspect or operate Netcatty terminals, remote hosts, SSH or other live sessions, SFTP files, vault data, snippets, scripts, or port forwards through Netcatty MCP.
metadata:
  managed-by: netcatty
---

# Netcatty MCP

Use the Netcatty MCP tools whenever the task targets Netcatty or a remote session managed by Netcatty.

- For terminal work, call `get_environment` first. Select the current target by its label or hostname and pass its `sessionId` to terminal tools.
- Never use the local shell for commands intended for a Netcatty session.
- If a required specialized tool is not visible, call `load_netcatty_tools` with `attachments`, `sftp_advanced`, `vault_hosts`, `vault_notes`, `snippets`, `scripts`, or `portforward`. Use `all` only when several categories are needed.
- If no live session matches, use `vault_hosts_list` and `host_open`. Close only sessions opened for the current task when they are no longer needed.
- Use `terminal_execute` for short commands. Use `terminal_start`, `terminal_poll`, and `terminal_stop` for long-running or streaming commands.
- Treat Netcatty permission denials and tool errors as authoritative. Do not bypass them with local commands or alternate connection tools.
