# SFTP transfer audit (September 2026)

Baseline: `7b964ead21c1e176999557147914f4975a63f5c8`.
Status: in progress. This is an evidence ledger, not a declaration that all SFTP
paths or reporter environments have been cleared.

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
  plugin CLI tests then pass. Full rerun pending.
- Production build passes. Current diff review and app interaction remain gates.

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
| [2638](https://github.com/binaricat/Netcatty/issues/2638) | Recovery after network failure | Verify restore end to end; UI availability alone is insufficient. |

Issue state (open/closed) and automated comments do not substitute for runtime
proof. Initial title search hit its 100-result cap. Expanded SFTP search returned
308 issue matches, including reports without SFTP in the title. Remaining relevant reports need their bodies/comments read.

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

## Remaining audit coverage

- Finish review of download/upload/remote-to-remote/SCP completion and integrity.
- Exercise abrupt disconnect and fresh-process recovery in both directions.
- Review folder manifests, skip/merge/replace, cancellation, path boundaries.
- Measure many-file discovery/history and inspect renderer responsiveness.
- Check pooled sessions, authentication, VPN/jump-host boundaries and cleanup.
- Exercise the actual transfer-center UI and detached/closed originating panels.
- Complete architectural comparison, fix additional reproduced material defects,
  obtain clean current-head review, and publish PRs with accurate evidence.
