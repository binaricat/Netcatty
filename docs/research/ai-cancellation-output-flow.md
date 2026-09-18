# AI cancellation and terminal output flow

Shell-backed AI execution listens to the same readable PTY/SSH stream as the
terminal. If renderer flow control pauses that stream, an interrupt can reach
the remote process while its end marker or returned prompt remains buffered.
The AI job then stays in `stopping` and retries ETX despite the remote reply.

Manual interruption already resets session flow state. Shell execution entry
points now supply `onInterrupt` to `startPtyJob`/`execViaPty` to perform the same
flow-state recovery for AI cancellation. Recovery runs in a microtask after the
interrupt write so cancellation timers are installed before buffered output can
complete the job. Recovery failures do not disable the cancellation deadline.
Normal execution does not invoke the hook.

The worker regression uses a real Node `Duplex`, the production flow pause
helper, and the job-start/stop/poll handlers. Its simulated remote immediately
returns an end marker on ETX. Before recovery, polling returns `stopping`; with
recovery it returns `cancelled` after a single ETX.

This test establishes the paused-output cancellation defect, not the reason a
particular renderer stopped acknowledging output. It also does not establish
that every unresponsive command has this cause, or guarantee that a remote
process honors SIGINT. Raw network-device execution and SSH exec channels have
separate cancellation paths.
