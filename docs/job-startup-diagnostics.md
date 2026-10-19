# Job startup diagnostics

This opt-in trace helps investigate issue #3443. It does not establish or repair
that issue's underlying cause, and does not change retries, recovery or job routing.

Set `NETCATTY_JOB_DIAG=1` before launching Netcatty (the existing
`NETCATTY_TERMINAL_DEBUG=1` also enables it). `[Netcatty JobDiag]` records from the
terminal worker are forwarded over its existing IPC channel to the main process
console, alongside the main-process routing records. The worker does not also
write these records to its own console. Collect the main process log from the
launch, including both stdout and stderr. For a development checkout on macOS or
Linux, for example:

```sh
NETCATTY_JOB_DIAG=1 npm run dev > job-startup.log 2>&1
```

For Windows PowerShell development launches:

```powershell
$env:NETCATTY_JOB_DIAG = "1"
npm run dev *> job-startup.log
```

The IPC collection path is covered by automated tests and a real macOS Electron
worker run. Native Windows capture still needs verification on that platform.

Correlate records using `sessionId` and `jobId` (and `chatSessionId` where present).
`probe-write` and `cmd-write` mark entry into a paced input attempt, not confirmed
transport delivery. `probe-output-arrived` means output reached the job while it
was probing, even if a partial character has not decoded yet; only
`probe-reply-parsed` proves a valid reply was parsed. Write records use `bytes`
for the outbound command size, separately from received output counters.
`probeBytes` counts raw bytes delivered to the job during probing. A zero count
does not prove the remote shell sent nothing. On a paused SSH stream,
`session.stream.readableLength` reports queued readable bytes without consuming
or resuming them; compare it with `isPaused` and the delivered-byte counters.

A `job-missing` lookup means no local job was found; it alone cannot prove a lost
worker route. Correlate it with earlier `job-start-accepted` / `route-removed` records.
`scope-mismatch`, `worker-unavailable` and `worker-job-missing` retain their
separate meanings. No new route provenance or retention is introduced.

Session snapshots include `hostname`. Redact hostnames, session/chat identifiers
and any other sensitive content from logs before sharing them. Disable the flag
after collection.
