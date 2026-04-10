# ACP + Skills + CLI Regression Notes

Purpose: keep branch review findings in one place so future smoke tests and automated coverage can target the fragile paths directly.
Maintenance rule: any newly discovered issue or review finding for this branch/workspace should be appended to this file so it becomes part of later regression.

Context:
- Branch: `ACP+SKILLS+CLI`
- Recorded: `2026-04-10`
- Scope: current working tree review notes plus the fixes landed during this branch hardening pass

Status values:
- `open`: currently present in the working tree and not fixed yet
- `carry-over`: older note kept for follow-up; not revalidated in this edit
- `fixed-in-worktree`: fixed in the current working tree; keep as a regression case
- `watch`: subtle behavior that should be rechecked whenever the related area changes

## Open Findings

None currently open.

## Carry-over Review Notes

None currently open.

## Fixed Regressions To Keep Covered

### RG-001: CLI per-call scope narrowing was ignored
- Status: `fixed-in-worktree`
- Area: CLI scoping / session narrowing
- Summary: `--scope-session` used to be dropped whenever `--chat-session` was present, so CLI calls ran against the full chat scope instead of the explicit narrowed scope.
- Current code:
  - `electron/cli/netcatty-tool-cli.cjs`
- Regression check:
  1. Run `env` with both `--chat-session` and `--scope-session`.
  2. Verify the returned hosts are narrowed to the requested session set.
  3. Repeat for `session`, `resource environment`, and at least one `sftp` command.

### RG-002: `sftp/download` approval wait exceeded CLI timeout budget
- Status: `fixed-in-worktree`
- Area: Skills + CLI approval flow
- Summary: `netcatty/sftp/download` needed confirm-mode approval, but the CLI timeout table originally did not wait for the approval budget.
- Current code:
  - `electron/cli/netcattyRpcClient.cjs`
- Regression check:
  1. Set AI safety mode to `confirm`.
  2. Trigger `sftp download` through Skills + CLI.
  3. Delay approval close to the approval timeout window.
  4. Confirm the CLI waits for approval instead of failing early with `RPC_TIMEOUT`.

### RG-003: Tool integration mode switching could tear down unrelated sessions
- Status: `fixed-in-worktree`
- Area: ACP host lifecycle
- Summary: switching between `skills` and `mcp` used to shut down the shared host and cancel unrelated approvals, execs, and background jobs in other chats.
- Current code:
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Start one chat in `skills` mode and begin a long-running task.
  2. Start a second chat in `mcp` mode.
  3. Confirm the first chat keeps running and no shared host teardown occurs.

### RG-004: `sftp/download` bypassed the write gate
- Status: `fixed-in-worktree`
- Area: MCP / Skills write permission enforcement
- Summary: download writes to a local file, so it must be treated as a write operation for observer and confirm modes.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
- Regression check:
  1. Set AI safety mode to `observer` and verify `sftp download` is denied.
  2. Set AI safety mode to `confirm` and verify `sftp download` requires approval.

### RG-005: Stopping a Skills SFTP transfer did not stop the transfer
- Status: `fixed-in-worktree`
- Area: session-scoped cancellation
- Summary: session-backed SFTP transfers used to keep running after ACP Stop or CLI `cancel`.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Start a large Skills `sftp download` or `sftp upload`.
  2. Trigger ACP Stop or CLI `cancel`.
  3. Confirm the transfer is aborted and the run stops immediately.

### RG-006: ACP Stop could wait on SFTP teardown before aborting the run
- Status: `fixed-in-worktree`
- Area: ACP stop responsiveness
- Summary: stop handling briefly regressed into awaiting SFTP cleanup before aborting the model stream, which delayed Stop on slow SSH teardown.
- Current code:
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Start a large Skills SFTP transfer.
  2. Click Stop during the transfer.
  3. Confirm the UI stops the run immediately while SFTP cleanup continues in the background.

### RG-007: Skills SFTP upload/download scaled memory with file size
- Status: `fixed-in-worktree`
- Area: main-process SFTP transfer path
- Summary: the session-backed Skills SFTP path used to buffer entire files in memory for upload and download. It now streams instead.
- Current code:
  - `electron/bridges/sftpBridge.cjs`
- Regression check:
  1. Transfer a large file through Skills + CLI.
  2. Watch app memory and responsiveness during both download and upload.
  3. Confirm there is no full-file buffering spike in the main process.

### RG-008: One-off SFTP handles lost auto-detected filename encoding
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / filename encoding
- Summary: each CLI file operation used to open a fresh `sftpId`, while filename encoding auto-detection was cached only per `sftpId`. A `list` call could detect `gb18030`, but the next `read`, `stat`, or `write` reopened a new handle and fell back to UTF-8, breaking non-ASCII paths unless the caller pinned `--encoding`.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/bridges/sftpBridge.cjs`
- Regression check:
  1. Use Skills + CLI against a host with non-UTF-8 remote filenames.
  2. Run `sftp list` with auto encoding and confirm the names render correctly.
  3. Immediately run `sftp read`, `sftp stat`, or `sftp write` on one of the listed non-ASCII paths without passing `--encoding`.
  4. Confirm the operation succeeds and reuses the detected encoding across the per-call SFTP handles.

### RG-009: `cancel` now stops running background jobs for the chat scope
- Status: `fixed-in-worktree`
- Area: Skills + CLI / ACP lifecycle / background jobs
- Summary: `netcatty/setCancelled` now cancels `job-start` work alongside in-flight `exec` and session-backed SFTP transfers, so the implementation matches the documented "abort outstanding Netcatty work" behavior again.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `skills/netcatty-tool-cli/references/control-commands.md`
- Regression check:
  1. Start a long-running command through `job-start`.
  2. Issue `cancel --chat-session <id>`.
  3. Confirm the job transitions to stopping and the remote work is interrupted.
  4. Confirm the docs still describe `cancel` consistently with the implementation.

### RG-010: Explicit `--scope-session` can no longer widen chat-session scope
- Status: `fixed-in-worktree`
- Area: CLI scoping / session isolation
- Summary: when a request carries both `chatSessionId` and `scopedSessionIds`, the bridge now resolves the effective scope as the intersection of those two sets. Explicit `--scope-session` values can still narrow a chat, but they can no longer reach sessions outside the chat's real scope.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/cli/netcatty-tool-cli.cjs`
- Regression check:
  1. Create a chat whose real scope contains session `A` but not session `B`.
  2. Run `env --chat-session <id> --scope-session <B> --json`.
  3. Verify session `B` is not returned.
  4. Repeat with `session`, `exec`, and one `sftp` command to confirm explicit scope never widens the chat scope.

### RG-011: CLI preserves empty string content for `sftp write`
- Status: `fixed-in-worktree`
- Area: Skills + CLI / argument parsing / remote file writes
- Summary: CLI flag parsing now preserves `--content ""` instead of collapsing it to `null`, so `sftp write` can create empty files or truncate existing files to zero bytes.
- Current code:
  - `electron/cli/netcatty-tool-cli.cjs`
- Regression check:
  1. Run `sftp write --content ""` against a remote path through the CLI.
  2. Confirm the CLI accepts the empty string instead of raising `Missing required --content <text>`.
  3. Verify the target file is created or truncated to zero bytes.

### RG-012: One-off session-backed SFTP commands now use the full command timeout budget
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / timeout cleanup
- Summary: `list`, `read`, `stat`, `home`, `mkdir`, `delete`, `rename`, and `chmod` now use the same bridge-side timeout as write/upload/download, and the CLI RPC timeout table waits on that budget for those methods too. A stalled one-off SFTP call now times out inside the bridge instead of leaving the transient `sftpId` alive after the CLI has already failed.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/cli/netcattyRpcClient.cjs`
- Regression check:
  1. Force a session-backed SFTP `list`, `read`, or `stat` call to stall past the command timeout.
  2. Confirm the bridge closes the one-off SFTP handle and returns a timeout error before the CLI RPC times out.
  3. Repeat for `mkdir` or `rename` in autonomous mode and verify the same bounded timeout behavior.

### RG-013: Skills file flow now distinguishes SSH-backed sessions from unsupported transports
- Status: `fixed-in-worktree`
- Area: Skills + CLI / SFTP routing / session compatibility
- Summary: the Skills prompt now tells the agent to use SFTP only for SSH-backed, connected sessions. Local sessions are routed to normal local filesystem tools, while serial/raw and network-device sessions are explicitly treated as non-SFTP transports. The CLI also fails fast with a clearer error if the caller still tries SFTP on a local, serial, or network-device session.
- Current code:
  - `electron/bridges/aiBridge.cjs`
  - `electron/cli/netcatty-tool-cli.cjs`
- Regression check:
  1. Open Skills mode on an SSH-backed session and confirm file operations still use SFTP.
  2. Open Skills mode on a local session and confirm the agent is told to use local tools instead of SFTP.
  3. Open Skills mode on a serial or network-device session and confirm the agent is not steered into unsupported SFTP calls.

### RG-014: Session-backed downloads now stage into Netcatty temp storage before replacing the destination
- Status: `fixed-in-worktree`
- Area: Skills + CLI / SFTP download lifecycle
- Summary: Skills downloads now stream into a temp file under Netcatty's dedicated temp directory and only move the completed file into the requested destination after the transfer finishes. If the transfer is cancelled or times out, the staged temp file is cleaned up and the destination path is left untouched.
- Current code:
  - `electron/bridges/sftpBridge.cjs`
  - `electron/bridges/tempDirBridge.cjs`
- Regression check:
  1. Start a large Skills `sftp download` to a local destination.
  2. Cancel it or force a timeout before completion.
  3. Verify the destination path does not retain a truncated partial file and the staged temp file is cleaned up from Netcatty's temp directory.

### RG-015: Confirm-mode RPC timeout now accounts for approval time and post-approval execution time together
- Status: `fixed-in-worktree`
- Area: Skills + CLI / approval flow / RPC timeout budgeting
- Summary: the CLI timeout calculator now sums the confirm-mode approval budget and the long-running execution budget for methods that need both. A user can approve late and still receive the full remaining command or transfer budget without a premature `RPC_TIMEOUT`.
- Current code:
  - `electron/cli/netcattyRpcClient.cjs`
- Regression check:
  1. Set AI safety mode to `confirm`.
  2. Trigger `exec`, `sftp download`, or `sftp upload` through Skills + CLI.
  3. Approve close to the approval timeout window, then let the command or transfer continue for several more seconds.
  4. Confirm the CLI still waits for the full approval-plus-execution budget instead of failing early with `RPC_TIMEOUT`.

### RG-016: Session-backed uploads now stage to a temp remote path and clean up partial files on cancel/timeout
- Status: `fixed-in-worktree`
- Area: Skills + CLI / SFTP upload lifecycle
- Summary: Skills uploads now write to a staged remote temp path first, then rename into place after the transfer completes. If the transfer is cancelled or times out, the bridge makes a best-effort cleanup pass on the staged remote file instead of leaving a truncated destination behind.
- Current code:
  - `electron/bridges/sftpBridge.cjs`
  - `electron/bridges/mcpServerBridge.cjs`
- Regression check:
  1. Start a large Skills `sftp upload` to a remote destination.
  2. Cancel it or force a timeout before completion.
  3. Verify the final remote path does not retain a truncated partial file and the staged temp remote path is cleaned up.

### RG-017: Staged uploads preserve overwrite behavior on non-OpenSSH SFTP servers
- Status: `fixed-in-worktree`
- Area: Skills + CLI / SFTP upload lifecycle / compatibility
- Summary: when `posix-rename@openssh.com` is unavailable, the upload finalization path now preserves the old overwrite behavior by temporarily renaming the existing destination out of the way, moving the staged upload into place, and then cleaning up the backup. Uploads that replace an existing remote file no longer regress into rename failures on standard SFTP servers.
- Current code:
  - `electron/bridges/sftpBridge.cjs`
- Regression check:
  1. Connect to an SFTP server that does not advertise `posix-rename@openssh.com`, or force the fallback path.
  2. Upload a local file to a remote path that already exists.
  3. Confirm the upload still replaces the existing remote file instead of failing during finalization.

### RG-018: Explicit MCP approval clears now remove renderer cards immediately
- Status: `fixed-in-worktree`
- Area: ACP / MCP approval lifecycle / renderer sync
- Summary: explicit clears through `clearPendingApprovals()` now send the same `netcatty:ai:mcp:approval-cleared` signal as timeout cleanup, so approval cards disappear from the renderer immediately when a chat is cancelled, deleted, or cleaned up from another surface.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `infrastructure/ai/shared/approvalGate.ts`
- Regression check:
  1. Trigger an ACP/MCP approval in confirm mode.
  2. Clear it via chat stop, CLI `cancel --chat-session`, or chat cleanup before the approval timeout.
  3. Confirm the approval card disappears from the renderer immediately instead of lingering as stale UI.

### RG-019: Concurrent bridge startup no longer spawns duplicate TCP hosts
- Status: `fixed-in-worktree`
- Area: MCP / Skills bridge host lifecycle / startup race
- Summary: `getOrCreateHost()` now reuses a single in-flight startup promise instead of letting concurrent callers bind multiple TCP servers at once. Concurrent ACP startup in `mcp` and/or `skills` mode no longer splits callers across different ports or leaves an orphaned listener behind after cleanup.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
- Regression check:
  1. Trigger two `getOrCreateHost()` calls concurrently, or start two ACP chats in parallel while no Netcatty bridge host exists yet.
  2. Verify both callers receive the same TCP port.
  3. Call bridge cleanup or shut down the app and confirm no orphan Netcatty TCP listener remains.

### RG-020: ACP startup failures no longer leave the renderer waiting forever
- Status: `fixed-in-worktree`
- Area: ACP renderer/main-process bridge / startup error handling
- Summary: `runAcpAgentTurn()` now treats an `aiAcpStream()` rejection or `{ ok: false, error }` startup response as terminal. The renderer no longer waits forever for `done`/`error` events that may never arrive when the ACP stream fails before streaming starts.
- Current code:
  - `infrastructure/ai/acpAgentAdapter.ts`
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Force `aiAcpStream()` to reject or return `{ ok: false, error }` before any ACP stream events are emitted.
  2. Confirm the chat surfaces the startup error immediately.
  3. Confirm the session does not remain stuck in a streaming state waiting for a `done` or `error` event that never comes.

### RG-021: Session-backed SFTP timeout/cancel now fail fast while teardown continues in the background
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / timeout and cancellation semantics
- Summary: `withSessionBackedSftp()` no longer waits for `closeSftp()` to finish before surfacing a timeout or cancellation. One-off Skills SFTP calls now reject promptly at the configured timeout boundary, and chat-scope cancellation returns immediately while the SFTP handle is torn down asynchronously in the background.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
- Regression check:
  1. Force a one-off session-backed SFTP command such as `list` or `read` to stall, then simulate a slow `client.end()` / SSH teardown.
  2. Confirm the RPC returns its timeout error at the configured timeout boundary instead of waiting for teardown to finish.
  3. Repeat with `cancel --chat-session <id>` during a Skills SFTP call and confirm the caller sees cancellation promptly while teardown continues in the background.

### RG-022: ACP startup-time cancels no longer leave the renderer waiting forever
- Status: `fixed-in-worktree`
- Area: ACP renderer/main-process bridge / cancellation lifecycle
- Summary: if the user aborted an ACP run before streaming actually began, the main process could return early without emitting `done` or `error`. `runAcpAgentTurn()` now treats the local abort signal itself as terminal, so startup-time cancels no longer leave the renderer-side promise waiting forever for events that will never arrive.
- Current code:
  - `infrastructure/ai/acpAgentAdapter.ts`
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Start an ACP run and abort it immediately, before any stream events are emitted.
  2. Confirm `aiAcpCancel()` is still issued to the main process.
  3. Confirm the renderer-side ACP turn resolves promptly without waiting for `done` or `error`.

### RG-023: Skills SFTP preflight now rejects non-SSH shell sessions such as Mosh and Telnet
- Status: `fixed-in-worktree`
- Area: Skills + CLI / SFTP routing / unsupported transports
- Summary: the CLI used to preflight-reject only local, serial, and network-device sessions, so Mosh and Telnet sessions slipped through even though session-backed SFTP only works on SSH connections. The CLI and skill guidance now reject those non-SSH transports consistently, so they fail fast with a transport-specific message instead of reaching the bridge and dying later with a generic SSH/SFTP error.
- Current code:
  - `electron/cli/netcatty-tool-cli.cjs`
  - `skills/netcatty-tool-cli/references/sftp.md`
- Regression check:
  1. Open a Mosh or Telnet session in scope.
  2. Run a Skills `sftp list` or `sftp read` command against it.
  3. Confirm the CLI rejects it immediately with a transport-specific unsupported-session error instead of attempting the bridge call.

### RG-024: Default-target Skills prompt now preserves the required `session` confirmation step
- Status: `fixed-in-worktree`
- Area: ACP prompting / Skills + CLI target selection
- Summary: the default-target hint previously told the agent to prefer direct `exec` on the default session, which conflicted with the later rule that every target must be confirmed with `session --session <id>` before execution or file routing. The runtime prompt and Skills references now skip `env` discovery for the default target but still keep the mandatory `session` confirmation step, so the agent can validate protocol and connection state consistently.
- Current code:
  - `electron/bridges/aiBridge.cjs`
  - `skills/netcatty-tool-cli/SKILL.md`
  - `skills/netcatty-tool-cli/references/exec.md`
- Regression check:
  1. Open Skills mode with a connected default target session.
  2. Give a routine request that does not mention another host.
  3. Confirm the injected prompt steers the agent to start with `session --session <id>` for that default target instead of jumping straight to `exec`.

### RG-025: MCP-mode prompt again teaches long-running commands to use `terminal_start`
- Status: `fixed-in-worktree`
- Area: ACP prompting / MCP tool routing
- Summary: during the prompt refactor, the MCP-mode context lost its explicit long-running command guidance and only mentioned `terminal_execute`. That regression would steer MCP agents toward `terminal_execute` even for builds, scans, watch mode, or other long tasks that should go through `terminal_start` / `terminal_poll` / `terminal_stop`. The long-running MCP guidance is now restored.
- Current code:
  - `electron/bridges/aiBridge.cjs`
- Regression check:
  1. Open ACP in `mcp` mode.
  2. Inspect the injected MCP prompt or run a long-running request such as a build or log-following task.
  3. Confirm the prompt tells the agent to use `terminal_start`, `terminal_poll`, and `terminal_stop` for long-running PTY-backed commands instead of defaulting to `terminal_execute`.

### RG-026: Session-backed SFTP channel open now honors the shared timeout/cancel budget
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / timeout + cancellation
- Summary: one-off session-backed SFTP calls now register their chat-scope abort handling and timeout budget before opening the SFTP channel. `openSftpForSession()` accepts the shared `AbortSignal` and timeout, so low command-timeout settings and Stop / CLI `cancel` now interrupt channel acquisition instead of waiting on a separate hard-coded open timeout.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/bridges/sftpBridge.cjs`
- Regression check:
  1. Set AI command timeout below 10 seconds.
  2. Force session-backed SFTP channel open to stall or respond slowly.
  3. Trigger a one-off Skills SFTP command such as `list` or `stat`.
  4. Confirm the request fails within the configured command timeout and that ACP Stop / CLI `cancel` interrupts the open attempt immediately.

### RG-027: `sftp home` now shares the same abort/timeout semantics as other one-off SFTP calls
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / home-directory discovery
- Summary: the `sftp home` preflight probe now listens to the shared `AbortSignal`, so configured command timeouts and explicit cancellations can interrupt the SSH `echo ~` probe instead of waiting for its private 5-second fallback timer. The follow-up `realpath('.')` path now also propagates shared aborts instead of swallowing them.
- Current code:
  - `electron/bridges/mcpServerBridge.cjs`
  - `electron/bridges/sftpBridge.cjs`
- Regression check:
  1. Set AI command timeout below 5 seconds.
  2. Force the `echo ~` probe in `sftp home` to hang or respond slowly.
  3. Trigger `sftp home` through Skills + CLI, then try ACP Stop / CLI `cancel`.
  4. Confirm the request aborts within the shared command timeout instead of waiting for the private probe timer to finish.

### RG-028: Session-backed directory deletes no longer bypass the shared stop/timeout budget
- Status: `fixed-in-worktree`
- Area: Skills + CLI / session-backed SFTP / destructive operations
- Summary: UTF-8 directory deletes used to jump to the SSH `rm -rf` fast path even for session-backed one-off SFTP handles, which bypassed the shared `AbortSignal` and timeout budget from `withSessionBackedSftp()`. The fast path is now reserved for ordinary UI SFTP sessions, while session-backed or otherwise stop-sensitive deletes stay on an abort-aware recursive SFTP path.
- Current code:
  - `electron/bridges/sftpBridge.cjs`
  - `electron/bridges/mcpServerBridge.cjs`
- Regression check:
  1. Start a large Skills `sftp delete` against a directory tree.
  2. Trigger ACP Stop or CLI `cancel`.
  3. Confirm the request aborts promptly instead of waiting for an SSH `rm -rf` exec channel to finish.
  4. Repeat with a low command timeout and confirm the delete returns a timeout within the shared budget.

## Suggested Smoke Matrix

- `skills` + `confirm`: `exec`, approve near the timeout window, then let execution continue.
- `skills` + `confirm`: `sftp download`, delay approval, then approve and let the transfer continue.
- `skills` + `confirm`: large `sftp download`, then Stop.
- `skills` + `autonomous`: large `sftp upload`, then Stop.
- `skills` + `autonomous`: stalled one-off `sftp list` or `sftp stat` past the command timeout.
- mixed chats: one chat in `skills`, one chat in `mcp`, both active at the same time.
- scoped chat: one chat with multiple sessions, then narrow with `--scope-session` and confirm the CLI result is reduced.
- non-SSH targets: one local session and one serial or network-device session, then confirm file tasks do not route into unsupported SFTP paths.
