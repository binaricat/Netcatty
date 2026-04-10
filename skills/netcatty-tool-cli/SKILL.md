---
name: netcatty-tool-cli
description: Use this skill when an external agent needs to operate on Netcatty sessions through Skills + CLI instead of the netcatty-remote-hosts MCP server.
---

# Netcatty Tool CLI

Use this skill for external ACP agents when Netcatty is configured for `Skills + CLI` mode.

For routine tasks, the host prompt is usually enough. Read only the reference that matches the task type.

## Router

1. Use the exact Netcatty CLI prefix provided by the host prompt.
2. Keep `--chat-session <chat-session-id>` on every Netcatty CLI call. Do not omit it.
3. Treat `--chat-session <chat-session-id>` as required for `env`, `session`, real `exec`, and every `sftp` operation. Treat `--session <session-id>` as required for `session`, `exec`, and every `sftp` operation.
4. Classify the task before choosing a command path:
   - Remote command execution tasks go through the exec reference.
   - Remote file or directory tasks go through the sftp reference.
   - If the user explicitly says to avoid shell or `exec`, do not use `exec`.
   - Treat `exec` as the short-command path only. If the command may exceed about 60 seconds, or streams output for an extended period, use the long-running job commands instead of plain `exec`.
5. If the host prompt already names a connected default target session, use that session directly for routine requests that do not mention another session or host, but still start with `session --session <id> --json --chat-session <chat-session-id>` instead of jumping straight to `exec` or `sftp`.
6. Only fall back to `env` lookup when the task is ambiguous, the user points to another session, or that direct `session` lookup fails.

## Core Rules

- Treat the host-provided CLI prefix as the only supported entrypoint for this session.
- Run Netcatty CLI commands strictly serially.
- Treat Netcatty CLI errors as authoritative.
- Never ask the user for SSH credentials, key paths, proxy settings, or jump-host details when Netcatty session access already exists.
- Do not pause to explain the plan, re-read this skill, or design scripts before trying that shortest path.
- When presenting structured results, prefer a concise table if it fits clearly.

## References

- Exec and session workflow: `references/exec.md`
- SFTP file workflow: `references/sftp.md`
- Session and device-type handling: `references/session-types.md`
- Cancel, resume, and runtime diagnostics: `references/control-commands.md`
- Error handling and authoritative failures: `references/errors.md`
