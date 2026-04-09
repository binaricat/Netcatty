# Session Types

Read this only when the target session is not a routine shell session or when you are unsure how to execute the command safely.

## Rules

- Always call `session --session <id> --json --chat-session <chat-session-id>` before any `exec`.
- Do not guess protocol, shell type, device type, or connection state from the `env` payload alone.
- For normal shell sessions, pass the command after `--` so Netcatty can return `stdout`, `stderr`, and `exitCode`.
- For serial/raw sessions and sessions with `deviceType: network`, commands are sent as-is without shell wrapping.
- For serial/raw and network-device sessions, use vendor CLI commands directly and avoid pipes, redirects, subshells, and shell-only syntax.

## Decision Guide

- If the session metadata shows a normal shell: use one direct shell command.
- If the session metadata shows `protocol: serial`, `shellType: raw`, or `deviceType: network`: use device-native commands only.
- If the session is not connected: do not execute commands in it.
