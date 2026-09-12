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
