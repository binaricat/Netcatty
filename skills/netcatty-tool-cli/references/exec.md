# Exec Reference

Use this reference for remote command execution tasks.

## Shortest Path

`exec` calls are internal agent transport calls. Always include both `--session <session-id>` and `--chat-session <chat-session-id>`.

1. If the host prompt already gives a connected default target session, prefer it directly:
   - `<netcatty-cli-prefix> exec --session <default-session-id> --json --chat-session <chat-session-id> -- <command>`
2. Otherwise:
   - `<netcatty-cli-prefix> env --json --chat-session <chat-session-id>`
   - Choose a `connected` session.
   - `<netcatty-cli-prefix> session --session <session-id> --json --chat-session <chat-session-id>`
   - `<netcatty-cli-prefix> exec --session <session-id> --json --chat-session <chat-session-id> -- <command>`

## Rules

- Use `exec` for command-style tasks such as hostname, IP address, CPU info, memory info, disk usage, pwd, whoami, uname, or process checks.
- Prefer one straightforward command over temporary scripts or multi-step shell orchestration.
- Avoid shell command substitution such as `$()` and backticks, because Netcatty safety policy may block them.
- Avoid wrapping simple commands in `sh -c`, `bash -c`, or similar shell launchers unless truly necessary.
- Only write a script when the task genuinely needs branching, loops, or structured parsing that cannot fit cleanly in one direct command.
