# SFTP responsiveness: issues #3213 and #3155

Investigated on 2026-08-31 against `39d7c38a6acea2f59524566d117345e1ced21fbd`.

## Evidence and scope

[#3213](https://github.com/binaricat/Netcatty/issues/3213) reports slow/unstable
large-file transfers, ineffective pause/resume and failed recovery after killing
the app. [#3155](https://github.com/binaricat/Netcatty/issues/3155) reports a freeze
with many files. Neither report supplies a direction, server configuration or
transfer log. The following are reproduced code defects, not proof that every
reported symptom has one cause. Keep both issues open for reporter confirmation.

1. `globalTransferScheduler.run` scanned the entire waiting queue on every
   insertion. Enqueuing 10,000 jobs behind two active jobs took 1,237 ms and
   49,985,005 limit checks locally. Coalescing queue pumps reduces the same case
   to 10,001 checks (3-6 ms in local runs). Priority, owner fairness and per-host
   limits remain unchanged; immediately completed batches also yield to input.
2. The transfer-center popover mounted every top-level row, even far below the
   viewport. The actual Electron component took about 1,885 ms to display 1,000
   rows. A measured, bounded viewport mounts around nine rows instead. All jobs
   remain in the store; scrolling and bucket selection still expose them.
   Folder expansion is held outside the recycled row.
3. Remote source/prefix verification used ssh2's serial `createReadStream`,
   even though body downloads already used pipelined reads. Pause captures a
   complete identity; resume verifies it before continuing. A 128 MiB loopback
   SFTP test with delayed READ replies spent 41,493 ms in resume on the old code.
   Reuse the existing 64-request, 32 KiB, ordered SHA-256 verification helper.
   This still checks every required byte with bounded memory, cancellation and
   inactivity deadlines. It does not substitute metadata, sampling or file size
   for content verification.

## Correctness boundaries retained

- Only contiguous acknowledged ranges are checkpoints; aggregate displayed
  progress and sparse file length are not safe offsets.
- First-run force-kill recovery still restarts at zero when no complete source
  identity was captured. Recovery persistence is unchanged: progress since the
  last lifecycle save can still be lost. This PR improves the verified resume
  path's latency, not every whole-app force-kill recovery scenario.
- SCP and legacy fastPut paths do not gain unsupported pause/resume.
- Source changes, staged-prefix mismatch, missing staging, cancellation,
  replacement, permissions and conflict handling retain their existing checks.
- No claim is made about arbitrary server power-loss durability, every Windows
  server, or a universal throughput multiplier.

## Mature-client comparison

- **FileZilla:** official SVN revision 11556 consumes directory results in
  batches and posts a continuation to the UI loop; its queue fills available
  transfer slots under total/directional/site limits. Adopt cooperative work
  and bounded admission, not an unrestricted `Promise.all` or a larger packet.
  Sources: [directory consumption, lines 69-129](https://svn.filezilla-project.org/svn/!svn/bc/11556/FileZilla3/trunk/src/interface/local_recursive_operation.cpp),
  [queue admission, lines 544-632 and 2452-2493](https://svn.filezilla-project.org/svn/!svn/bc/11556/FileZilla3/trunk/src/interface/QueueView.cpp).
- **OpenSSH:** 32 KiB requests and a 64-request default window; interruption
  stops new requests, drains replies and tracks the contiguous acknowledged
  prefix separately from the highest acknowledged position. Its manual warns
  that mismatched partial content can corrupt a resumed file. Netcatty keeps
  its stronger content checks. Sources: [defaults and transfer loops](https://github.com/openssh/openssh-portable/blob/0ef0f5a839831c213f24e3f2ae434765c607fb50/sftp-client.c#L59-L63),
  [resume warning](https://man.openbsd.org/sftp.1).
- **WinSCP:** two simultaneous background operations is also its default;
  eligible transfers use temporary files before publication. These choices do
  not establish that two files is Netcatty's bottleneck, or that every killed
  process can safely resume. Sources: [background queue](https://winscp.net/eng/docs/transfer_queue),
  [resume requirements and temporary-file tradeoffs](https://winscp.net/eng/docs/resume).
- **rclone:** documents the same 32 KiB/64-request defaults, server compatibility
  concerns and possible deadlock when checks/transfers compete for a capped
  connection pool. Future adaptive windows or a server compatibility matrix
  should be separate measured work. Source: [SFTP documentation](https://rclone.org/sftp/).

## Reproduction and verification

The regression tests exercise scheduler admission/order/yielding, complete remote prefix
verification, and actual transfer-center DOM bounds/scrolling. Each new defect
was observed failing before its fix.

The opt-in real SSH/SFTP fixture listens only on loopback, uses generated test
credentials and isolates all temp/home state. It creates a saved prefix, checks
resume and (for sufficiently long transfers) live pause/resume, then checks the
complete output SHA-256. It is not a simulation of a whole-app force-kill.

```sh
NETCATTY_SFTP_LIVE=1 SFTP_LIVE_MIB=128 SFTP_LIVE_FILES=12 \
  node scripts/sftp-transfer-resume.live.test.cjs
NETCATTY_SFTP_LIVE=1 SFTP_LIVE_MIB=128 \
  SFTP_LIVE_BASELINE_REF=39d7c38a6 \
  node scripts/sftp-transfer-resume.live.test.cjs
```

Twelve 128 MiB files completed with matching hashes, two submitted at a time.
Each exercised pause/resume: pause acknowledgements took 6-15 ms; resume took
about 1.45-3.18 seconds in this run. These are fixture-specific observations,
not performance promises. Electron verification also exercised the production
popover, pause-all/resume-all, scrolling to the last file, bucket switching and
20,000-job admission while the popover was open.

## Review follow-up

- Preserve serial prefix verification when a server rejects range OPEN/READ
  with an ordinary protocol error. Cancellation and request timeouts do not
  fall back; timed-out channels are abandoned before another attempt.
- Count every positive short READ as inactivity-watchdog activity, without
  changing ordered full-range hashing. Finished windows cannot publish late
  progress, rearm their watchdog or issue another partial READ.
- Allocate the live fixture inside the managed temp directory, then isolate
  its own staging/home state. Cleanup removes only that unique fixture child,
  including when fixture setup fails.
- Keep transfer-row separators based on the actual list position, not the
  temporary viewport wrappers. The final list row alone omits its separator.
- Remove the proposed periodic full-history save: with 20,000 queued files,
  serialization alone occupied about 80 ms every five seconds. A compact journal
  would additionally need cross-window ownership and retry-attempt coordination.
  Those recovery semantics are not changed in this focused responsiveness PR.
  There is no new persistence timer, storage key or schema migration.
