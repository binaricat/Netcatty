# Official Linux package QA

Temporary same-repository **Draft** PR only. Do not merge or publish this branch.
The workflow uses standard GitHub-hosted Ubuntu 22.04, read-only contents/actions
permissions, pinned official actions and checkout without persisted credentials.
No release workflow is dispatched.

Candidate metadata is explicit JSON. `candidate.json` pins a23868e, official run
44901156879 / artifact 14706239224. `candidate-9d4e90b.json` pins the independently
verified 9d4e90b run 44903060405 / artifact 14707251480. No floating latest or older
fallback is used. Each report records its full candidate SHA; never mix results.
The downloader checks repository/run/job/artifact metadata, archive SHA-256, deb
SHA-256 from the official build log, and amd64 architecture before extraction.

The official deb is extracted as the non-root runner. Installer scripts are
never executed because those scripts change SUID/AppArmor. This is extracted
package execution, not system-install acceptance. The application archive is
never patched. No --no-sandbox, sysctl, AppArmor, SUID or system security changes
are used. A normal launch failure is a failure with actual reviewed stderr.
The stock renderer preference is sandbox:false; the report states this honestly
and does not certify full renderer sandboxing.

Only the downloader receives the GitHub token. Electron gets an explicit
environment allowlist with fresh scenario-specific HOME/XDG/temp/profile paths.
Xvfb's temporary XAUTHORITY is passed through for the isolated display. No model
credentials, business data or production account is used. SSH/SFTP and DevTools
listen only on loopback. SSH credentials and host keys are generated per run.

Independent scenarios prevent one functional assertion from skipping another:

- `persistence`: real packaged launch, synthetic saved host visible in the vault,
  graceful full process quit, restart with the same profile, same data visible.
- `ssh`: actual encrypted SSH2 loopback transport through the production UI.
  Explicitly focus xterm's real input element, use native renderer input events,
  assert server receive and real terminal echo, destroy the server connection,
  reconnect the original tab, assert a second shell and stable tab ID. Receive
  hex, focus and echo diagnostics distinguish harness input failures from an
  established product regression.
- `sftp`: establish a separate real SSH connection and SFTP subsystem, then invoke
  the production preload transfer API into the actual packaged native runtime.
  This covers real transport/control behavior, not a certification of UI button
  gestures. Capture transfer-center screenshots; pause mid-file; drain pending
  reads; sample actual server bytes and native progress five times over 2.5 s;
  assert both are unchanged; resume and assert both grow; finish and compare
  file length and SHA-256 to a deterministic 32 MiB payload. No component fixture,
  injected transfer implementation, or checkout-sourced bridge substitutes for
  the official package's transfer code.
- `host-filter` (9d4e90b only): seed synthetic vault hosts and call the actual
  packaged public/vault/hosts/list dispatcher and renderer bridge. Independently
  check no-filter compatibility, empty/non-string filters, multiword keyword
  matching, group path boundaries, case sensitivity and combined filters.

Evidence lives under scenario directories: `assertions.json`, reviewed
`electron-output.log`, and real application screenshots named for each scene.
`provenance.json` at the artifact root identifies the official package. Raw
profiles and payloads are never uploaded. Logs and assertion diagnostics are
checked for the ephemeral password, private keys, GitHub credentials and bearer
headers before logs/screenshots are published; matches withhold those files and
fail. Artifacts expire after three days. Read each assertion report: environment
and harness failures never count as feature passes.
