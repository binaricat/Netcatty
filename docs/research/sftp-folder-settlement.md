# Folder completion after same-ID ownership handoff

Both normal directory transfer and dedicated directory recovery can receive a
superseded stream result: another invocation now owns the same child transfer.
The old caller must wait for that owner rather than report premature completion.
Previously it polled the visible child row. Completed rows are compacted into
parent checkpoints, so a completion arriving before the superseded reply removes
the row first. Polling then waits forever; a stale panel row can mask this further.

Two regressions use the actual React directory hook / dedicated recovery entrypoint
and actual store compaction. Each records one completed file in the parent while
the transfer operation remains pending on the baseline.

The fix registers a bounded settlement observation before starting the stream.
The store captures terminal state for exact observed file identities before
history compaction. One shared helper waits for the actual owner in both paths,
then releases its observation on success, failure or cancellation. There is no
persistent per-file tombstone list and no inference that a missing row means
success. Reused IDs with different indexed file identities are not evidence.

This addresses a separately reproduced folder-never-settles condition relevant
to #2568 and #3155. It does not establish the original reporters' precise cause.

Large-history recovery follow-up: stream lifecycle events carry the current child hierarchy identity. Before dispatch, the store admits the explicit retry into the current row without a full history compaction, so a batched old failed row cannot reject the new completion. Admission distinguishes pause waiting, cancellation, identity conflict and exact prior completion; active lifecycle epochs and newer pause/cancel intent remain protected.

## Follow-up: retained completions and changed owners (#3155)

Two remaining #3287 review cases reproduce independently of the original
Windows report:

- With the 4096-row batching path enabled, a retained completed child at manifest
  index 1 can reach dispatch before index 0 is published. Rebuilding a replacement
  stage deletes that child's old output, but completion admission used to skip
  its new transfer. The actual recovery entrypoint returned success while the
  promoted directory omitted the file. A filesystem regression now checks both
  filenames and the retransferred contents; transport and source listing are
  controlled fixtures, not a real remote server.
- A superseded invocation waited forever after a new same-ID owner changed file
  identity, including when the new owner completed and its row was compacted.
  Both bounded regressions returned `still-waiting` before the fix.

Recovery now authorizes reuse of a completed row for a fresh transfer only when
it is the exact row captured before the destination/checkpoint reset. Newer
completion, pause and cancellation still win. Reset byte checkpoints and source
fingerprints are published with that admission. Ordinary recovery continues to
reuse valid completed work.

Settlement observations retain identity-conflict evidence before compaction,
including explicit admission changes. A displaced invocation fails explicitly
instead of waiting for completion evidence belonging to another file. Both live
and dedicated walks report that failure without overwriting the new owner's
child row; dedicated recovery also discards its deferred update for that child.
Existing
exact completion evidence remains authoritative; missing rows alone still do
not prove success. Observations remain scoped to their waiter and are disposed.

These cases explain specific large-history recovery failures. They do not prove
that the original Windows v1.1.82 freeze was caused by either case; its file count,
transfer direction, server and logs remain unavailable.
