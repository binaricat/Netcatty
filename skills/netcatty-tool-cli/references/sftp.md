# SFTP Reference

Use this reference for remote file or directory tasks.

## Default Path

- Treat file and directory tasks as SFTP tasks by default, not shell tasks.
- If the user explicitly says to use only `sftp`, do not call `exec`.
- Every `sftp` command must include both `--session <session-id>` and `--chat-session <chat-session-id>`.
- Do not use reusable SFTP handles or `--sftp <id>`.
- After choosing a target session, first run `session --session <id> --json --chat-session <chat-session-id>` and inspect the returned metadata.
- Use SFTP only when that `session` result shows a connected SSH-backed session. For local, Mosh, Telnet, serial/raw, or network-device sessions, do not use SFTP.
- Keep path semantics strict:
  - `--remote-path` always means a path on the remote host.
  - `--local-path` always means a path on the local machine running Netcatty.
- If the user says "download" to a local destination such as `/tmp`, `~/Downloads`, or Desktop, use `sftp download`.
- If the user says to create or modify a file on the remote host, use `sftp write`, `sftp upload`, or another remote SFTP operation. Do not reinterpret that as a local download.

## One-Off Commands

- List a directory:
  - `<netcatty-cli-prefix> sftp list --session <session-id> --remote-path <remote-path> --json --chat-session <chat-session-id>`
- Read a file:
  - `<netcatty-cli-prefix> sftp read --session <session-id> --remote-path <remote-path> --json --chat-session <chat-session-id>`
- Write a small text file with known content:
  - `<netcatty-cli-prefix> sftp write --session <session-id> --remote-path <remote-path> --content <text> --json --chat-session <chat-session-id>`
- Download a remote file to an existing local path:
  - `<netcatty-cli-prefix> sftp download --session <session-id> --remote-path <remote-path> --local-path <local-path> --json --chat-session <chat-session-id>`
- Upload an existing local file:
  - `<netcatty-cli-prefix> sftp upload --session <session-id> --local-path <local-path> --remote-path <remote-path> --json --chat-session <chat-session-id>`
- Delete a remote path:
  - `<netcatty-cli-prefix> sftp delete --session <session-id> --remote-path <remote-path> --json --chat-session <chat-session-id>`

## Rules

- Use `sftp write` directly for creating or updating a small text file with known content.
- Use `sftp upload` only when a real local file already exists and must be transferred.
- Use `sftp download` when the result must be saved to the local filesystem.
- Do not create temporary local files just to upload text that could be sent with `sftp write`.
- Do not use `sftp read` as a substitute for `sftp download` when the user asked for a local saved file.
- Do not use `sftp write` as a substitute for `sftp download`; writing to `/tmp/foo` with `sftp write` writes to the remote host's `/tmp`, not the local machine.
- Do not use shell commands like `cat`, `touch`, redirection, or ad hoc SCP/SSH usage for remote file tasks.
