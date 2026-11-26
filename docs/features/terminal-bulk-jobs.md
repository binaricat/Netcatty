# Long-running jobs on many sessions (`terminal_start_bulk`, `terminal_poll_bulk`, `terminal_stop_bulk`)

These tools start the same long-running command as a background job on 2–20 open
terminal sessions, then poll and stop those jobs together. They are the bulk versions
of `terminal_start`, `terminal_poll` and `terminal_stop`, for upgrades, builds, scans
or log checks across hosts. For short commands on many sessions use
`terminal_execute_bulk` (see [terminal-execute-bulk.md](terminal-execute-bulk.md)).

They are available to MCP clients only. Load them over MCP with `load_netcatty_tools`
and the `terminal_bulk` toolset.

## `terminal_start_bulk`

| Field | Type | Notes |
|---|---|---|
| `command` | string | Same rules as `terminal_start`. |
| `sessionIds` | string | JSON array of 2–20 unique session IDs. Resolve IDs with `get_environment`. |

Before anything starts, every target is checked with the rules `terminal_start` uses:
session scope, closing, already busy, connected, a shell-backed PTY (network devices,
serial sessions and sessions without a writable terminal are refused), and the command
safety policy for that session's shell. If **any** target fails, no job starts on any
host and the call fails, listing every bad target at once. Out-of-scope IDs are
reported without a label.

Approval works like `terminal_execute_bulk`: observer mode refuses, confirm mode asks
**once** with a card listing the command and every host, and that approval is never
satisfied by a remembered grant or by "allow for this session". In confirm mode no host
is contacted before you answer; the shell-kind probe and the shell-specific safety
patterns run right after approval, before any job starts. Sessions hosted by the
terminal worker are checked the same way, with a no-send `precheck` of the worker's
job start.

```json
{
  "ok": true,
  "bulkId": "bulk_m1x2y3_ab12cd34",
  "hostCount": 3,
  "counts": { "running": 3 },
  "jobs": [
    { "sessionId": "s-web1", "label": "web1", "jobId": "job_…", "status": "running" },
    { "sessionId": "s-web2", "label": "web2", "jobId": "job_…", "status": "running" },
    { "sessionId": "s-db1",  "label": "db1",  "jobId": "job_…", "status": "running" }
  ],
  "recommendedPollIntervalMs": 30000
}
```

- `running` means the job was **launched**. As with `terminal_start`, a terminal that is
  not ready when the command is sent (a pager, a password prompt, a prompt that cannot
  be recognized) shows up as `failed` on the first poll.
- A host whose job could not be started at all is listed with `status: "not_started"` and
  an `error`; the other jobs keep running, because jobs already started are not undone.
  If no job started, the call fails with `Error: No background job was started.`
- Each session stays busy until its job ends (at most 1 hour), so other commands on it
  are refused meanwhile.
- Jobs keep running when the agent run is stopped. Stop them with `terminal_stop_bulk`.
- There is no way to answer prompts in a running job, so use non-interactive commands
  (`-y`, `DEBIAN_FRONTEND=noninteractive`, `sudo -n`).

## `terminal_poll_bulk`

| Field | Type | Notes |
|---|---|---|
| `bulkId` | string, optional | From `terminal_start_bulk`. Pass this or `jobIds`. |
| `jobIds` | string, optional | JSON array of 1–20 job IDs, instead of a `bulkId`. |
| `offsets` | string, optional | JSON object `{ "<jobId>": <nextOffset> }` from the previous poll. Missing jobs start at 0. |

```json
{
  "ok": true,
  "bulkId": "bulk_m1x2y3_ab12cd34",
  "jobCount": 3,
  "allCompleted": false,
  "counts": { "running": 1, "completed": 1, "failed": 1 },
  "jobs": [
    { "jobId": "job_…", "sessionId": "s-web1", "label": "web1", "status": "running", "exitCode": null, "nextOffset": 5120, "output": "…" },
    { "jobId": "job_…", "sessionId": "s-web2", "label": "web2", "status": "completed", "exitCode": 0, "nextOffset": 9000, "output": "…" },
    { "jobId": "job_…", "sessionId": "s-db1",  "label": "db1",  "status": "failed", "exitCode": 100, "nextOffset": 300, "output": "…", "error": "…" }
  ],
  "recommendedPollIntervalMs": 30000
}
```

- Each job returns at most 4 KB of new output, and all jobs together at most 32 KB.
  The total is shared by need: jobs with little new output take only what they need,
  and the rest goes to busy jobs (with 20 busy jobs, about 1.6 KB each). When a job has
  more new output than its share, the **newest** output is returned and `skippedChars`
  says how much was skipped. Output older than the job's kept window (the last 256 KB)
  also counts as skipped. Use `terminal_poll` on one job for its full output.
- Pass each job's `nextOffset` back in `offsets` to get only new output next time.
  Offsets count the raw output; progress redraws (`\r`) are collapsed to the latest frame.
- `allCompleted` is `true` when no job is `running` or `stopping`.
- A job that expired (10 minutes after it finished), is out of scope, or belongs to
  another chat is reported per job with `status: "unavailable"`; the poll itself still
  succeeds.

## `terminal_stop_bulk`

| Field | Type | Notes |
|---|---|---|
| `bulkId` | string, optional | From `terminal_start_bulk`. Pass this or `jobIds`. |
| `jobIds` | string, optional | JSON array of 1–20 job IDs, instead of a `bulkId`. |

Stops every job with the existing `terminal_stop` behavior: no approval, and it works
in observer mode, so a runaway rollout can always be stopped. Each job reports its
status (`stopping`, or its final status if it already ended); missing jobs are reported
per job as `unavailable`.

## `bulkId`

A `bulkId` names the jobs one `terminal_start_bulk` call started, so polling and
stopping need one ID instead of many. It belongs to the chat that created it, like each
job does, and expires after the jobs' lifetime (75 minutes). After that, poll or stop
the jobs by `jobIds`.

## Not included

The in-app agents (Catty and the global agent) do not get these tools yet, and plugin
agents cannot call them. Sending input to running jobs, targets by group or tag, and
opening missing sessions are not part of these tools.
