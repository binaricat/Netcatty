# SFTP restart recovery must not guess another server

Audit baseline: `7b964ead21c1e176999557147914f4975a63f5c8`.

## Confirmed defect

`resolveHostForTransferEndpoint` used a display-name/hostname search when a
recorded host id no longer existed, and returned the first match when multiple
hosts shared a name. Dedicated resume used those credentials to open the target
and start uploading. A saved task for a deleted server could therefore send
its source file to an unrelated same-named server. Both endpoint directions and
folder recovery use this resolver.

Two regressions invoke `resumeTransferWithDedicatedSession`, with the real
resolver, scheduler, credential construction, and resume path but instrumented
bridge I/O. Before the fix, both selected an unrelated endpoint and called
`startStreamTransfer`: a deleted recorded id with one same-named replacement,
and a legacy task without an id with two same-named hosts. Both now stop before
opening or uploading.

## Fix contract

- A recorded host id is authoritative; absence must not fall back to a name.
- Legacy tasks without an id may resolve a name only if exactly one host matches.
- Preserve exact-id recovery, unique-name legacy recovery, and a still-live
  original session when vault credentials are absent.
- Never select an arbitrary member of an ambiguous name match.

This does not freeze future edits to the connection options of an existing host
id; a persisted immutable endpoint snapshot would be a separate schema and
migration change. It also does not claim to explain all historical restart
failures from issue #3213 or #2638.

## Verification

`node --test --import tsx application/state/sftp/dedicatedTransferResume.test.ts`:
39 passed, including both regressions and existing single-file/folder restart,
remote-to-remote, source-validation, and live-session fallback tests.

Broader SFTP audit remains in progress in the sibling `codex/sftp-transfer-audit`
worktree; its first control-ordering fix is PR #3284.
