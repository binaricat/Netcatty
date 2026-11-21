# Official Linux candidate QA (incremental probe)

Temporary, same-repository **Draft** PR only. Do not merge or publish this branch.
The workflow uses the standard GitHub-hosted Ubuntu 22.04 runner and read-only
contents/actions permissions. No release workflow is dispatched.

Pinned candidate: `a23868ee88603d0182c5370fca851cb9d05d7f8f`, official main build
`44901156879`, Linux x64 artifact `14706239224`. The downloader verifies GitHub
repository/run/job/artifact metadata, the immutable archive digest, and the deb
digest recorded by that official Linux build. No older fallback is selected.
All candidate identifiers and digests live in `candidate.json`; change them
together only after read-only verification of the new official metadata. Each
assertion report records its own candidate SHA. Do not mix candidate results.

The official deb is extracted as the non-root runner. Its installer scripts are
never executed: those scripts alter SUID/AppArmor. This is **extracted-package
execution**, not a system-install test. The application archive is never patched.
No `--no-sandbox`, sysctl, AppArmor, SUID, or system security changes are used.
Failure to launch with normal sandbox support fails the job with actual stderr.
The app's own renderer preference is `sandbox:false`; the harness reports this
stock setting and does not claim to prove full renderer sandboxing.

Only the downloader step receives the GitHub token. Electron gets an explicit
environment allowlist, isolated HOME/XDG/temp/profile directories, no model
credentials and no business data. The SSH2 server and DevTools bind loopback.
The SSH password and host key are generated per run. No production account is used.

Implemented assertions:

- Launch the real packaged Electron executable and verify `app.isPackaged`,
  `resources/app.asar`, the isolated profile, non-root UID and launch switches.
- Seed a synthetic saved host in real Chromium storage; verify it in the real
  vault before and after graceful quit and full process restart with that profile.
- Connect through the real UI to an actual loopback SSH2 server, send a command,
  destroy the server-side transport, use the disconnected tab's reconnect action,
  verify a second shell connection, another command and an unchanged tab ID.

**Not yet covered:** SFTP pause with stable progress, resume, completion and file
SHA-256. No component fixture substitutes for these missing assertions. A green
probe is not full three-scenario acceptance. Password persistence, system install,
and external hosts are also outside this incremental probe.

Evidence is an assertion JSON, official provenance, real application screenshots
and combined stdout/stderr. Before persisting logs or screenshots, the harness
checks output for its ephemeral password, private keys, GitHub credentials and
bearer headers; a match withholds those files and fails. Raw profiles are not
uploaded. Artifacts expire after three days. Environment failures must be reported
as failures, never as functional passes.
