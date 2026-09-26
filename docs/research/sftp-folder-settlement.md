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
it is the exact row captured at the destination/checkpoint reset, after stage
deletion has finished. This includes files completed during session setup or
traversal. Newer
completion, pause and cancellation still win. Reset byte checkpoints and source
fingerprints are published with that admission. Ordinary recovery continues to
reuse valid completed work.

Settlement observations retain identity-conflict evidence before compaction,
including explicit admission changes. Before each admission attempt, an observed identity conflict stops the old
invocation from reclaiming an active row after a pause. A displaced invocation fails explicitly
instead of waiting for completion evidence belonging to another file. Both live
and dedicated walks report that failure without overwriting the new owner's
child row; dedicated recovery discards its deferred update synchronously when
the observation detects displacement. This also prevents an automatic 512-entry
batch flush from publishing the old snapshot while its invoke reply is delayed.
Exact completion evidence is retained independently of later ownership changes:
an old success still cannot overwrite a newer owner. Initial retained identities
are distinguished from changes observed while waiting, and newer same-file
attempts supersede old failed evidence. Missing rows alone still do not prove
success. Observations remain scoped to their waiter or its pending child update and are disposed after the final write or discard.

These cases explain specific large-history recovery failures. They do not prove
that the original Windows v1.1.82 freeze was caused by either case; its file count,
transfer direction, server and logs remain unavailable.

## Ownership rules for the follow-up

The expected identity is the tuple of task ID, source path, target path, parent
ID, manifest index and manifest identity. Successful completion evidence and
permission to update the current row are separate: an old completion never grants
permission to overwrite a different identity. Identity conflict is sticky for a
waiter, immediately discards its deferred child update, and ends the old walk
without writing that child or reporting the walk as successful.

Only two initial-state allowances exist, both bounded to one waiter:

1. An initial **inactive** row (`paused`, `failed`, `interrupted`, `attention`)
   can precede a fresh recovery plan. It is tolerated only while identity,
   status, lifecycle epoch and owner still match that initial snapshot. It
   does not authorize dispatch: the ordinary pause/cancel/admission gates remain.
2. An exact completed row captured **after** destination/checkpoint reset is
   obsolete completion evidence for the deleted destination. Only that row
   object can be restarted. A newer completion cannot inherit this permission.

| Boundary | Same expected identity | Different identity | Missing row |
| --- | --- | --- | --- |
| Registration | Capture current state immediately; completion may be reused unless it is the exact reset-invalidated row | Tolerate only the unchanged initial inactive snapshot or exact reset-invalidated completion; already-active differences conflict immediately | No evidence of completion; continue to normal admission |
| Waiting for admission | A new active/paused state replaces old failed/cancelled evidence; a later success is retained. Pause/cancel gates still apply | Status, epoch or owner changes end the initial inactive allowance; any non-allowed mismatch records conflict and discards pending updates immediately | Retained exact success can settle the wait; absence alone cannot |
| Before every admission | Check cancellation and recorded conflict first. Reuse exact completion, or restart only the exact reset-invalidated row. An unchanged captured pause requires an active parent and released pause latches | Recorded conflict stops before `admitTaskRun` can overwrite the row; structural mismatch is also rejected by admission | Dispatch only if normal admission allows it and no retained completion/conflict settles the waiter |
| Invocation resolves | Check conflict before interpreting success or superseded. A superseded call follows observed same-file state | Fail with an ownership-change error; do not write old success/failure into the new row | A superseded call needs retained exact settlement evidence; ordinary success retains existing invocation semantics |
| Invocation rejects | Without conflict, preserve the original transport error | Convert to ownership-change error so caller does not overwrite the winner | Do not infer success; preserve original error unless conflict was already observed |
| Exit | Live waiters dispose on every path; dedicated child handlers keep the same observation until their final update is synchronously applied or handed to the batcher | Live/dedicated walks count failure, skip old child writes; dedicated recovery also discards deferred updates | Never recreate a compacted winning row from an obsolete invocation |

For the same expected file identity, an epoch change alone is not an identity
conflict: the bridge still owns invocation deduplication and lifecycle ordering.
Epoch/status/owner changes matter when deciding whether a *different* initial
inactive identity is still the unchanged pre-recovery record. This follow-up does
not replace the existing same-file control/epoch machinery or introduce a new
persistent attempt protocol.

Evidence maps directly to these rules: `transferSettlementObservation.test.ts`
covers registration, waiting, pre-admission, initial inactive/active states,
old failure versus new success, compacted completion, newer epochs and original
error propagation. `dedicatedTransferResume.test.ts` exercises actual recovery
with immediate/batched updates, automatic flush before delayed replies, new
active/completed owners, old success/rejection, and real filesystem stage reset
including completion during setup. `transferDirectoryOps.discovery.test.tsx`
checks the actual live hook does not overwrite replacement owners. Existing
pause/cancel, directory/store and batching tests remain in the targeted run.

Observation updates follow state writes, not UI notification type. Explicit
admission, direct row patches and background event ingestion synchronously
capture the affected row, including progress-only epoch/status/owner changes.
Lifecycle publication still captures settlement before history compaction.
The background path reuses its existing row index; progress does not gain a
full-history scan, serialization or synchronous persistence.

Deferred child writes retain the original observation, without another store
lookup or observer registration. Dedicated recovery owns it while handling the
invocation result; the update callback returns `true` only when its consumer
accepts responsibility for disposal. The batcher stores the update and observation
together, checks conflict immediately before writing, and disposes on write or
discard. A callback that does not accept ownership leaves disposal to recovery's
`finally`. This also covers a new identity appearing after one file finishes
while other directory files are still running. Evidence includes both old
success/failure and active/compacted replacement rows after waiter exit.

The write/discard is the ownership deadline for a deferred update, not the end
of the entire directory. A completed child already written successfully may
legitimately be replaced later; that does not retroactively fail the old success.
A completed child still waiting to be written is provisional: if replaced before
its write, its pending completion count is withdrawn and the old directory fails.
Observation starts before source validation and is passed into the waiter, so
validation errors and attention outcomes obey the same write-ownership rule.

Recovery flushes child updates before deciding the directory result or promoting
a replacement stage. Its later asynchronous connection cleanup cannot outlive
provisional success. The outer cleanup retains an idempotent flush as an error
fallback. A regression replaces a child during connection close and verifies its
old completion was already committed and the legitimate new owner survives.
