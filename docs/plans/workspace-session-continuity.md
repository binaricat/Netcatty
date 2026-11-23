# Agent session continuity within a workspace

## Objective

Let an agent continue an authorized task across multiple sessions in its workspace, including recovery from transient disconnects, sleep/wake connection loss, slow shell startup, and an unresponsive terminal. A recoverable session problem should not automatically end the whole task or require the user to repeat its instructions.

The workspace is the collaboration and permission boundary. The host grants access to particular sessions and management operations; the main process enforces those grants across RPC, IPC, and CLI paths. Being displayed in a workspace does not itself grant access, transfer ownership, or authorize closing another chat's session. Existing task authorization should be reusable for permitted recovery without repeated permission questions.

## Merged foundation: PR 3885

- Open a new host session in an explicitly selected workspace and bind it to the requesting chat scope, or return an explicit binding failure.
- Preserve upstream reuse-first behavior and original ownership, including visibility of sessions already auto-reconnecting.
- Wait for a live shell prompt before delivering commands to tracked shell-backed PTYs, with bounded waits and cancellation.
- Document bounded recovery decisions using capabilities available in the running build.

Explicit reconnect, moving an existing session, and restarting a connection are not implemented by this PR. The larger objective explains this first increment; it is not a claim that the recovery lifecycle is already complete.

## Next increments

1. **Reconnect within the same tab.** Expose an authorized reconnect operation for disconnected sessions, preserving session identity, workspace placement, useful history, and scope. Reuse an in-flight reconnect instead of starting another connection. Return connected/ready only after those states are observed; surface authentication requirements separately.
2. **Open or attach a recovery session.** Allow a permitted existing session to join the selected workspace, or open an independent session to the same verified host when the old transport is unusable. Preserve its management permissions and scope throughout placement. Coalesce duplicate recovery requests and return whether a session was reused or created.
3. **Recover an unresponsive connection.** Expose explicit replacement/restart where permitted, fence old-generation writes and late callbacks, and preserve diagnostics. Reopening a connection does not prove the old remote process was terminated. Process termination requires a separately verified target and existing authorization.
4. **Coordinate ongoing work.** Keep per-session execution reservations and cancellation; track whether a command was not sent, acknowledged, completed, or has an unknown outcome. Multiple sessions can support independent jobs while tool calls remain serialized wherever the host requires it. Do not replay a possibly executed command to simulate progress.

Each increment starts with lifecycle and scope regressions, reuses existing session actions and permission checks, and is delivered as a small change against freshly fetched upstream main. Preserve observer/confirm/auto behavior and distinguish session visibility from management permission.

## Recovery policy

Use existing session recovery before creating a new tab. Defaults per target session/host in one incident: at most three recovery attempts including the first, wait 2 seconds and then 5 seconds before another attempt, and stop starting attempts after a 120-second elapsed budget including connection and waiting time. A smaller user/host limit takes precedence. A new chat turn or tab does not reset an ongoing incident's budget. Create at most one new recovery session for that incident; reuse it on subsequent checks.

Apply retry only to transient transport/startup conditions when it is known that no task command was delivered, or to an inspection/reconnect operation whose semantics permit retry. Authentication rejection, missing permission, revoked scope, invalid targets, and user cancellation need a different action; they are not transient retry signals. A program returning a nonzero exit code is not evidence that its terminal connection is broken.

After an ambiguous timeout or disconnect during execution, inspect the existing job, marker, process, output, or durable result before considering another execution. Exhausting recovery pauses only the blocked dependency; continue independent authorized work and report the session, observed state, attempted actions, and what remains unknown. Do not skip required work or report it as complete.

The Skill is operator guidance, not a backend retry controller or a grant of permissions. New lifecycle tools must enforce their own deadlines, generation checks, idempotency, and workspace permissions.

## Acceptance scenarios

| Scenario | Required result | Delivery |
| --- | --- | --- |
| Open a new connection for parallel work | Requested workspace, usable chat scope, explicit reuse/create result, no duplicate retry tabs | Placement/scope delivered; existing reuse preserved |
| Slow local shell or SSH shell startup | No command bytes before readiness; bounded cancellation and explicit not-sent failure | Delivered for tracked shell PTYs |
| Brief network loss or sleep/wake disconnect | Reconnect original tab within its grant, preserve scope, resume after observed readiness | Explicit reconnect implemented in the follow-up; live fault injection pending |
| Old terminal is unresponsive | Inspect/cancel appropriately, then use one permitted independent connection in the same workspace | Creation is available where exposed; automated recovery orchestration planned |
| A command may have executed before disconnect | Diagnose outcome; no automatic replay of a possibly mutating command | Skill guidance; richer delivery state planned |
| Permission revoked or user stops the task | No reconnect/reopen/resume that bypasses that decision | Existing enforcement retained; lifecycle regressions required for new tools |
| Same failure persists | Bounded retries/backoff, no tab storm, clear blocked-dependency report | Skill guidance; controller enforcement required with lifecycle tools |

## Follow-up: explicit reconnect (2026-10-26)

Implementation and validation are tracked in [scoped-session-reconnect-20261026.md](scoped-session-reconnect-20261026.md). The follow-up adds `session_reconnect` / CLI `session-reconnect` for existing scoped disconnected sessions, using the existing terminal lifecycle with no new tab or command replay. Main-process attempt limits and scope checks supplement the operator policy. Restart/move and independent recovery-tab orchestration remain later work.

The same open PR is being extended with `session_recover` / CLI `session-recover`: short bounded recovery calls inspect authentication, existing reconnects and tracked job activity, retry with the shared reconnect budget, and observe prompt readiness. Continuations retain the incident deadline. This orchestration does not create recovery tabs, move sessions, restart connected transports or replay task commands. Actual sleep/wake/network-fault acceptance remains outstanding.

## Status

PR 3885 is merged. The follow-up implements explicit scoped reconnect and bounded same-session recovery; restart/move remain planned. Apply Skill updates through the application's normal distribution/synchronization path; do not rely on overwriting a user's separately maintained interruption skill.

## Guidance validation

- The bundled skill passes skill-creator quick_validate.py; Markdown references and the existing control/error routes were inspected.
- Scenario walkthroughs: transient disconnect uses the bounded incident budget; a known busy job is polled rather than receiving new input; authentication/scope denial stops retry; uncertain command completion requires inspection before replay; a missing reconnect capability is reported rather than invented; explicit user cancellation is respected.
- This documentation/Skill increment adds no executable lifecycle behavior or installed-user-skill replacement. No runtime test or new production build is claimed for these text-only edits.
