# Run one command on many sessions (`terminal_execute_bulk`)

`terminal_execute_bulk` runs the same short command on 2–20 open terminal sessions and
waits for all of them. It is available to MCP clients only (the in-app agents do not get it yet). Load it
over MCP with `load_netcatty_tools` and the `terminal_bulk` toolset. For a single host use
`terminal_execute`; fewer than 2 sessions is rejected. For long-running commands on many sessions use
`terminal_start_bulk` (see [terminal-bulk-jobs.md](terminal-bulk-jobs.md)).

## Input

| Field | Type | Notes |
|---|---|---|
| `command` | string | Same rules as `terminal_execute`. |
| `sessionIds` | string | JSON array of 2–20 unique session IDs, for example `["s-1","s-2"]`. Resolve IDs with `get_environment`. |
| `tailLines` | number, optional | Keep the last N lines of each distinct output. Default 100 (also used for 0), maximum 2000. |

## All-or-nothing

Before anything is sent, every target is checked with the same rules a single
`terminal_execute` uses: session scope, closing, already busy, connected, able to run
commands, and the command safety policy for that session's shell. If **any** target
fails, no command is sent to **any** host and the call fails, listing every bad target
at once:

```
Error: nothing was sent. 2 of 5 targets cannot run this command:
- s-9: Session "s-9" is not in the current scope.
- s-3 (web3): Session already has another command in progress. …
Remove or fix these session ids and retry.
```

Out-of-scope IDs are reported without a label, so a session outside the current scope is
never revealed.

## Approval and safety

- Observer mode refuses the call, and the live permission mode is re-read after the prompt and
  again just before the start, so switching to observer while a prompt is open refuses it.
  Confirm mode asks **once**, with a card that lists the
  command and every host.
- A fan-out approval is never satisfied by a remembered "always allow" grant, and it is
  never covered by "allow for this session" from an external MCP client. A pending
  fan-out is not approved by another request's session approval either. Each call asks.
- All targets are claimed before the prompt, so no other command can start on them while
  you decide. Everything is checked again right after approval; if anything changed,
  nothing is sent.
- In confirm mode no host is contacted before you answer. The checks before the prompt only
  read local state and apply the shell-independent safety patterns. The shell-kind probe
  (which opens an SSH exec channel, as a single command does just before it runs) and the
  shell-specific safety patterns run right after you approve, once the local guards (Stop,
  scope, privacy policy) have been rechecked and still before any command is sent. So a refusal that depends on the host's shell can appear after approval, and denying
  a call leaves every host untouched. Without a prompt (auto mode) the full check runs first.
- Every command still goes through the normal execution path, including the per-shell
  safety policy, shell readiness checks, privacy masking, and cancel.
- Sessions hosted by the terminal worker (the default) are checked the same way: the
  worker runs every deterministic check (transport, shell kind, the shell-specific safety
  patterns, unsupported local shells, a busy background job) in a no-send `precheck` mode,
  so a refusal there also cancels the whole call before any host receives the command.
- The one thing that cannot be known in advance is the live state of a terminal at the
  moment of sending, for example a pager, a password prompt, or a prompt that cannot be
  recognized. A host in that state reports `not_sent` (`SHELL_READINESS_UNKNOWN`) and the
  other hosts still run, because commands already sent cannot be taken back.

## Timeouts

Every host gets the same timeout, the global command timeout from Settings. Each host
has its own timer, started when that host's command starts, so a slow host never uses up
another host's time. All hosts start together, so the call takes about one timeout in
the worst case, like `terminal_execute`. As a backstop, a host that has not finished
3 seconds after the timeout is reported as `timeout` and the chat's running commands are cancelled, including those inside the
terminal worker, before the per-chat lock is released. The RPC timeout budget for this
tool is larger than for `terminal_execute` so the backstop always fires first.

## Output

JSON text, in the same style as the other Netcatty tools. Hosts with identical results
are grouped, which keeps the response small on large fleets.

```json
{
  "ok": true,
  "hostCount": 5,
  "counts": { "completed": 4, "timeout": 1 },
  "groups": [
    {
      "hosts": [
        { "sessionId": "s-web1", "label": "web1" },
        { "sessionId": "s-web2", "label": "web2" }
      ],
      "status": "completed",
      "exitCode": 0,
      "stdout": "active"
    },
    {
      "hosts": [{ "sessionId": "s-db1", "label": "db1" }],
      "status": "timeout",
      "exitCode": null,
      "stdout": "",
      "stderr": "connect: no route",
      "error": "Command timed out (60s)"
    }
  ]
}
```

- `status` records what happened, not whether it was good: `completed`, `timeout`,
  `cancelled`, `connection_lost`, `error`, or `not_sent`.
- `exitCode` is a number only for `completed`. A non-zero exit code is a normal result,
  not a tool failure. Serial and network-device sessions have no exit code (`null`).
- `stderr` and `error` are omitted when empty.
- Output is grouped on the full, untruncated result, so two hosts that differ only in the
  part that was cut off are never merged. `tailLines` and a per-group size cap are then
  applied; a cut group has `outputTruncated: true` (also set when the exec layer had already dropped the beginning of a very large output) and, when lines were dropped,
  `omittedLines`.
- If no host received the command, the call fails with `Error: No command was sent to any
  host.` and one line per host.
- `ok: false` results (invalid input, preflight failure, denial, cancel) are returned as
  `Error: …` text with `isError`, like every other tool.

## Not included

The in-app agents (Catty and the global agent) do not get this tool yet. A CLI command, targets by group or tag, opening missing sessions, per-host commands, and
a per-call timeout are not part of this tool. Plugin agents cannot call it.
