# Control Commands

Read this when you need diagnostics, cancellation, or to re-enable a cancelled chat scope.

## Useful Commands

- Runtime diagnostics:
  - `<netcatty-cli-prefix> status --json`
- Cancel outstanding Netcatty work for this chat scope:
  - `<netcatty-cli-prefix> cancel --chat-session <chat-session-id> --json`
- Re-enable execution for that same chat scope:
  - `<netcatty-cli-prefix> resume --chat-session <chat-session-id> --json`

## Rules

- `cancel` affects the current chat scope; it requests cancellation for in-flight `exec`, session-backed SFTP transfers, and running `job-start` work in that scope. Later `exec` calls in that scope stay blocked until `resume`.
- Do not issue control commands concurrently with other Netcatty CLI commands for the same chat session.
