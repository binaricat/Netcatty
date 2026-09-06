# SFTP transfer audit (September 2026)

Baseline: `7b964ead21c1e176999557147914f4975a63f5c8`.
Status: scoped audit completed, with five independently reproduced defects
fixed and submitted. This ledger distinguishes verified paths from reporter
environments unavailable to this audit.

## Completion requirements

Review the global transfer center, live and restored execution, admission and
connection ownership, pause/resume/cancel ordering, durable checkpoints, source
and destination integrity, folder replacement/traversal, history retention,
transfer responsiveness, and architectural duplication. Cross-reference actual
issue reports and mature open-source clients. Reproduce material findings before
fixing them. Submit verified fixes as PRs and retain evidence for unresolved
reporter-specific conditions.

## Confirmed finding: stale transfer control can defeat a newer pause

Priority: high. The user can pause a transfer and have an older request silently
restart it, or see the state return to transferring while the pause latch remains
set. File transfers and folder children share the affected control path.

Reproductions (each failed on the baseline before the implementation change):

- Two overlapping pauses: the first reply incorrectly compensates by calling
  resume, even though the second pause is still intended.
- Resume reply delayed until after a newer pause: old success overwrites the row
  and its lifecycle epoch.
- Dedicated single-file recovery held for the stream lifetime: its duplicated
  soft-resume implementation independently has the same stale reply problem.
- Pipelined upload: resume waits for outstanding writes, receives a newer pause,
  then resumes anyway when draining finishes.
- Worker reply fan-out: old successful resume, failed pause, or rejected pause
  emits a new resumed event after a later pause succeeded.

Fix contract: the newest pause/cancel decision wins over older replies; no late
result can revive a terminal task. Keep checkpoints and source verification.
Do not serialize controls behind a stream lifetime. Reuse the shared soft-resume
path for held single-file recovery instead of maintaining another state writer.

Verification so far:

- Original selected SFTP suite: 747 passed.
- Initial fixes with the three new regressions: 750 passed.
- Store and control suite after dedicated-path consolidation: 107 passed.
- Worker fan-out suite including three out-of-order cases: 9 passed.
- Loopback SSH/SFTP: 12 files of 128 MiB, two file jobs concurrently, each starts
  from a 32 MiB saved checkpoint and pauses/resumes during the remaining download.
  All final SHA-256 digests match. Pause acknowledgements 6-15 ms, resume checks
  1391-1493 ms. These are fixture measurements, not WAN throughput claims.
- Independent review found another held-run failure path: rejection or a dead
  stream response followed by a newer pause during wind-down could start a fresh
  resume. Two regressions reproduced it; shared rejection handling and epoch
  checks after wind-down now pass (109 store/control tests).
- First full suite: 11377 passed, 7 plugin archive failures traced to missing
  worktree-local nested dependency (yauzl 3.x). Reinstalled with npm ci; all 29
  plugin CLI tests then pass. Full rerun passed: 11386 passed, 0 failed,
  18 skipped.
- GitHub review found a cross-window gap: the obsolete worker result was a hard
  failure to a renderer whose local control epoch had not changed. Explicit
  superseded outcomes now bypass rollback, compensation and dedicated recovery,
  including rejected worker requests. Updated focused suite: 122 passed.
- Production build and lint pass after that follow-up; two independent reviewers
  found no actionable follow-up issues.
- Browser fixture exercised the actual transfer-center component/store with
  simulated transport: pause all, resume all, individual pause, paused filter,
  and cancel. State/buttons matched; no browser console errors. This is not a
  full Electron connection-path test.
- Separate real loopback SSH/SFTP audit experiments killed the transferring child
  process with SIGKILL and resumed the saved checkpoint in a fresh child process.
  Both 32 MiB download and upload completed with matching SHA-256. Persisted
  checkpoints were 30670848 and 14024704 bytes respectively. This validates the
  transfer engine and disk staging across process death, not the renderer's
  automatic history restoration or a real VPN/jump-host environment.

## Submitted fixes

| PR | Confirmed failure | Architectural change |
| --- | --- | --- |
| [3284](https://github.com/binaricat/Netcatty/pull/3284) | Late pause/resume replies revive a newer paused/cancelled task or overwrite its visible state, including cross-window and folder watcher paths | Shared held-file resume handling; obsolete controls carry the winning action to reconcile local barriers; compensation checks current intent rather than assuming every epoch change means resume. |
| [3285](https://github.com/binaricat/Netcatty/pull/3285) | Deleted recorded host or duplicate legacy display names can resume an upload against another saved server | Exact host-ID recovery; unique-match-only legacy resolution; preserve live-session recovery. |
| [3286](https://github.com/binaricat/Netcatty/pull/3286) | Publication/restoration can overwrite a concurrently saved local file; rollback can delete a replacement | One exclusive publication helper, a clear commit boundary, preserved recovery artifacts on conflicts or incomplete fallback copying. |
| [3287](https://github.com/binaricat/Netcatty/pull/3287) | Folder stays active after child completion was compacted out of visible history | One bounded settlement observer/helper for both live transfer and recovery; no persistent tombstone history. |
| [3288](https://github.com/binaricat/Netcatty/pull/3288) | Cancelling or timing out channel initialization disconnects shared SSH users | Channel cancellation is separated from shared-transport ownership; abandoned initialization is bounded until settlement. |

Additional engine experiments used actual loopback SSH/SFTP, killed the child
process, and resumed in a fresh process for remote-to-remote transfers. Both the
download phase and upload phase passed final 32 MiB SHA-256 comparison. The
upload-phase checkpoint was 16777216 bytes. These complement direct upload and
download recovery, not full-app history restoration or reporter confirmation.

## Historical issue evidence fetched in this audit

| Issue | Reported condition | Audit treatment |
| --- | --- | --- |
| [3213](https://github.com/binaricat/Netcatty/issues/3213) | macOS, 10+ files of 100-200 MB; pause/resume and force-quit recovery unreliable | Control ordering reproduced separately; source direction and server still absent from report. Do not claim reporter confirmation. |
| [3155](https://github.com/binaricat/Netcatty/issues/3155) | Windows, many-file transfer freezes; no count or logs | Recheck bounded discovery, scheduling, publication and history work. |
| [2973](https://github.com/binaricat/Netcatty/issues/2973) | VPN uploads disconnect SSH and SFTP; transfer spinner continues; later inode VPN report | Check transport loss and settlement. Network/security cause not established by the available logs. |
| [3186](https://github.com/binaricat/Netcatty/issues/3186) | Replacement changes permissions on 1.1.82 | Check mode/owner behavior on each replacement path; existing bot explanations are not proof. |
| [3149](https://github.com/binaricat/Netcatty/issues/3149) | Windows proxy + terminal drag-upload reports No such file | Check target pinning, path encoding, session and retry behavior. |
| [2832](https://github.com/binaricat/Netcatty/issues/2832) | Browsing works through VPN/jump host, transfers wait indefinitely, cancel works | Check dedicated connection admission/authentication/timeout. |
| [2568](https://github.com/binaricat/Netcatty/issues/2568) | Folder copy reaches 100% but remains active; pause ineffective | Check parent settlement and directory checkpoints. |
| [2458](https://github.com/binaricat/Netcatty/issues/2458) | Windows 1 GiB upload continues after Pause/Pause all from both terminal sidebar and SFTP tab | Motivates transport-plus-visible-state regressions; current delayed-control defects independently reproduced. |
| [3031](https://github.com/binaricat/Netcatty/issues/3031) | macOS jump-host/proxy drag upload: no such file | Missing full error, protocol, target path and direct-connect comparison prevent attribution. |
| [2556](https://github.com/binaricat/Netcatty/issues/2556) | Windows download of 1.9 GiB from local Linux VM; separate many-small-files progress complaint | Preserve verification correctness; distinguish network payload from verification and incremental discovery. No comparative reporter throughput available. |
| [2886](https://github.com/binaricat/Netcatty/issues/2886) | sudo terminal drop denied while SFTP upload succeeds | Existing terminal fallback fix is separate; contradictory bot explanations are not evidence of identity or permission correctness. |
| [2638](https://github.com/binaricat/Netcatty/issues/2638) | Recovery after network failure | Verify restore end to end; UI availability alone is insufficient. |

Issue state (open/closed) and automated comments do not substitute for runtime
proof. Initial title search hit its 100-result cap. Expanded SFTP search returned
308 issue matches, including reports without SFTP in the title. The reports
listed above were read as representative symptom clusters; this was not a claim
to have investigated all 308 matching issues individually.

## External reference points

- [Tabby SFTP implementation](https://github.com/Eugeny/tabby/blob/master/tabby-ssh/src/session/sftp.ts):
  stream transfer and temporary upload destination before rename. Useful as a
  separation-of-concerns comparison; this file does not establish durable
  restart recovery and must not be treated as a complete replacement design.
- [WinSCP resume documentation](https://winscp.net/eng/docs/resume): partial-file
  discovery and temporary filenames support interruption recovery; temporary
  creation can be unavailable under some permission layouts.
- [Electerm transfer implementation](https://github.com/electerm/electerm/blob/master/src/app/server/transfer.js):
  separates a per-transfer object from queue/UI state, opens a separate SFTP
  channel on the existing SSH connection when available, and uses 32 KiB chunks
  with 64 requests. Its live pause flag stops scheduling additional reads. Its
  ordinary transfer opens the destination with `w`; it is not evidence for
  durable checkpoint recovery. Retain Netcatty's staging and contiguous-offset
  protections when simplifying ownership.
- [Electerm action store](https://github.com/electerm/electerm/blob/master/src/client/components/file-transfer/transports-action-store.jsx)
  counts pending initializations toward admission; its
  [mutation queue](https://github.com/electerm/electerm/blob/master/src/client/components/file-transfer/transfer-queue.jsx)
  distinguishes completion of a state update from completion of transfer I/O.
  This supports keeping control requests independent of long-lived transfer runs.

## Coverage and practical limits

| Area | Evidence and result |
| --- | --- |
| Transfer controls and global center | Actual component/store browser interactions; delayed replies, direct/worker, folder watcher and cross-window action regressions. PR 3284 fixes confirmed ordering failures, including root-state reconciliation and failed resume settlement. |
| Upload/download and remote-to-remote durability | Four real SSH/SFTP fresh-process recovery experiments, including both remote-to-remote phases, all compare final bytes by SHA-256. Existing transfer tests cover changed source, sparse ranges, cancellation and publication. |
| Local/SCP publication | Real filesystem conflict regressions and SCP abort tests; one shared no-overwrite publication helper. Copy fallback retains mode/timestamps and recovery files on failure. Actual FAT/exFAT hardware was unavailable. |
| Folder traversal and final state | Discovery concurrency, replacement/rollback, manifest, pause latch, skip/conflict and history tests; actual live/recovery entrypoints reproduce compacted-child hang and pass after PR 3287. |
| History, restart and ownership | Store history/large-manifest and dedicated recovery tests; PR 3285 rejects missing or ambiguous saved host identity. Full Electron quit/relaunch with restored user credentials was not exercised; engine-process recovery was. Editing endpoint details under an unchanged saved host ID remains a documented identity-model limitation. |
| Connection sharing and cleanup | Connection pool, lease and initialization tests; real delayed SFTP OPEN followed by cancellation leaves browsing alive and closes the late channel after PR 3288. VPN/MFA/security-product and original jump-host environments were unavailable. |
| Responsiveness | Actual browser controls, list virtualization, bounded directory discovery and 50k history cases; scheduler smoke figures below are diagnostic, not end-user throughput or Windows runtime proof. |

No additional data-loss defect was established by these checks. User reports of
VPN-specific hangs, proxy drag-upload path errors and Windows throughput/freezes
still require their original environments and discriminating logs. They are not
marked resolved solely because a related mechanism was repaired here.

## Validation summary

Each fix received two independent local reviews. Review-discovered gaps were
corrected and checked again. PR 3284 latest focused control/worker tests: 35 pass;
two actual direct-resume tests include the full undrained timeout and pass.
PR 3285 full suite: 11,379 pass, 18 skip. PR 3286 full suite before its metadata
follow-up: 11,386 pass, 18 skip; latest publication/abort tests: 34 pass.
PR 3287 serial full suite: 11,383 pass, 18 skip; production build passes.
PR 3288 real SSH cancellation experiment and nine channel tests pass; its full
suite has 11,380 passes and one unrelated terminal write-queue timing failure,
independently reproduced on the unchanged baseline. That entire test file passes
alone (81 tests). A separate integration worktree combines all five branches;
one test-only insertion conflict was resolved by retaining both regressions.
The folder test was subsequently relocated in its own PR; a fresh merge-tree
check confirms it combines with the other control tests without a conflict.

## Architectural assessment

The staged-file and contiguous-checkpoint design is worth retaining. A simpler
client that writes directly into the destination is not an equivalent safety
reference. The most important simplification is ownership: a long-lived stream
must not block its own control requests, and one authoritative lifecycle must
inform every window. PR 3284 removes a duplicate state-writing recovery path
and makes obsolete controls explicit.

Publication is a second useful module boundary. PR 3286 replaces repeated
check/rename/check/rollback branches with one no-overwrite operation shared by
publication and restoration. On hardlink-capable filesystems its commit is
atomic; the documented exclusive-copy fallback trades atomic visibility for
compatibility while preserving recoverable data and cancellation.

The current transfer list virtualizes beyond 20 visible tasks, directory listing
has a tree-wide concurrency gate, and history migration yields cooperatively.
A scheduler-only smoke workload of 1000 and 10000 immediately completing jobs
finished in 87 ms and 4362 ms, with maximum timer gaps of 15 ms and 111 ms during
other validation activity. The queue still scans for eligibility/priority/fairness;
this is a follow-up performance lead, not proof of the Windows freeze reports or
a standalone throughput benchmark. Folder fan-out bounds ordinary queue growth.

Do not weaken full saved-prefix verification merely to improve resume timings.
The loopback experiments include extra verification reads; those bytes are not
payload throughput. A future optimization needs proof that changed sources and
out-of-order durable ranges still cannot produce mixed file contents.

PR 3287 makes final transfer ownership independent of visible history retention:
observers capture terminal settlement before compaction and are disposed after
the waiting invocation exits. PR 3288 keeps per-channel cancellation from
claiming ownership of a shared SSH connection. These targeted boundaries reduce
duplicated policy without replacing the working durable-transfer engine.

Combined-engine live checks also passed: shared-connection cancellation retains
working browsing and closes the late channel; a 32 MiB download killed at a
16809984-byte checkpoint resumes in a new process to the expected SHA-256. An
initial 8 MiB fixture completed before an intermediate checkpoint was sampled;
the larger paced fixture supplies the intended process-death evidence.

## Final combined validation

The combined full suite passed: 11,439 passed, 0 failed, 18 skipped. Lint and
production build passed. This run includes all five fixes and the failed-child
admission follow-up. A final control-aggregation follow-up then corrected mixed
success/superseded resume outcomes and current IPC rejection handling; both
independent reviewers approved it. After bringing that follow-up and the
test-only relocation into the integration checkout, all 202 affected control,
store, folder, observation, recovery and worker tests passed. Final lint/build
are recorded in the PR descriptions. No production changes were made in the
integration checkout; the only merge edits preserve independent regression tests.

The initial combined run stopped after an older exact-result assertion rejected
the newly structured superseded response and left its fixture alive. The
assertion was updated, its fixture completed, and the successful full run above
supersedes that aborted run. Tests were not removed or weakened.

## Delivery follow-ups

The remote publication branch received an automated patch during final review.
It was fetched and checked rather than assuming earlier validation covered it.
Two actual filesystem regressions showed lost normal mtime preservation and a
remaining final-path stamping race. The repair prepares staged timestamps before
publication and restrictive chmod, skips post-commit stamping of that pathname,
and uses a verified file handle on non-promoted local paths. Fallback close
errors also retain recovery artifacts. Publication/bridge/SCP checks: 31 pass;
independent targeted review: 10 pass.

Fresh dedicated recovery now recognizes only the exact unchanged paused child
rows captured at its entry as old pauses eligible to resume. A newer row,
pausing state, root/child latch or cancellation still blocks admission. This
avoids a 4096-row batching deadlock without removing later pause protection.
Actual batched paused-history and later-pause regressions pass; 163 relevant
tests and an independent 60-test review pass.

The delivery rerun includes all follow-ups above: 11,452 tests passed, 0 failed,
18 skipped (182.9 seconds, four test processes). This is the final combined
full-suite result and supersedes the earlier intermediate counts.
