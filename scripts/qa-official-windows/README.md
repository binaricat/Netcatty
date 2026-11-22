# Installed Windows package acceptance (QA only)

This harness belongs only to same-repository Draft PR #4299 on
`qa/official-linux-a23868e`. Its independent standard `windows-2022` workflow
does not modify the product, release packages, main, or the earlier Linux job.

`candidate.json` pins the public v1.1.90 NSIS asset and the exact official
9d4e90b Windows Actions artifact. The downloader verifies repository, main push,
build job, artifact metadata and archive SHA-256 before extracting the one named
NSIS installer. The Actions read token exists only in this downloader step.

An independent `portable` matrix job verifies the public v1.1.90 Windows ZIP
SHA-256 `df057f03d122fb541168868d2d203c3723b8b731a663dbdaa5bc38390a742b88`
and extracts the exact candidate Windows ZIP entry from the same verified
official artifact. It runs the identical actual-GUI migration assertions on an
explicit disposable profile, even if NSIS fails. ZIP extraction does not certify
installation, overinstallation, NSIS portable launchers or automatic updates.
The two modes use fresh independent VMs and separately named evidence artifacts.

The separate exact-fix jobs pin same-repository PR #4302 commit
`4516d3aed7cb54862dabd53abb56a7f90fba3212`, based on frozen main 9d4e90b.
If no exact standard package exists, a separate checkout on standard
windows-2022 runs the existing Node 22/MSVC/npm ci/pack:win-x64 conventions.
Only the normal non-release version metadata is set. Application source is not
patched while packaging. The build child receives a Windows environment
allowlist with no Actions credentials; signing/distribution credentials are not
supplied and publishing is disabled. The resulting NSIS is explicitly
CI QA-built, unsigned and unreleased. Its exact SHA-256, source SHA and QA run
are verified in a separate fresh desktop job before normal installation.

The fix acceptance uses the same real released v1.1.90 GUI baseline and native
NSIS/history harness. A positive candidate-created Beta pointer in IndexedDB is
a mandatory precondition before normal quit. That exact pointer must survive
complete restart before panel interaction, alongside both original chats,
saved host and new reply. Panel display intent remains memory-only: manual
history opening after restart is not claimed as automatic conversation reopen.
The old official 9d4e90b control and its original retained failure are separate.

The installed real v1.1.90 GUI configures a deterministic loopback-only OpenAI
provider, saves one synthetic loopback host, and creates two distinct chats with
two complete user/assistant turns each. Beta remains active. No localStorage,
IndexedDB or React state writes seed the fixture. The same custom profile and
`app://netcatty` origin are reused by the installed official candidate. Read-only
storage observations compare original session IDs, full messages and scope,
the exact active pointer, saved host and the IndexedDB migration marker. The
candidate sends another normal GUI message, quits normally and restarts to
verify the appended turn and original chats persist.

Both candidate snapshots must have IndexedDB `meta.activeSessionMap` directly;
legacy localStorage is not accepted as a substitute for migration evidence.
The stock panel's draft/chat display intent is memory-only. Record and capture
the initial candidate/restarted view before any navigation. If it opens the
Recent/draft view, verify the original IndexedDB active pointer first, then
select the existing chat through normal history UI. Do not call that selection
automatic restoration of the previously visible conversation.

Both installers use normal silent per-user NSIS arguments. The candidate version
`0.0.0-sha-9d4e90b` is below 1.1.90, so this is **not** released automatic updater
acceptance. A blocked replacement is recorded separately. A normal uninstall
and fresh candidate installation may then test migration using the preserved
explicit QA profile, without altering packages or bypassing version checks.

The application receives an allowlist of Windows runtime environment variables,
isolated synthetic home directories, and no GitHub token. There are no sandbox
disabling flags or system security changes. The stock application's own web
preferences are recorded rather than claiming stronger isolation than it uses.

Evidence is retained for three days. `provenance.json` has exact hashes;
`assertions.json` records individual outcomes, installer exits, actual running
executable/version/profile/origin, and loopback calls. Storage snapshots contain
only synthetic chats/host. PNGs (`01-baseline-alpha`, `02-baseline-beta-active`,
`03-candidate-beta-active`, `04-candidate-alpha`, `05-candidate-appended`,
`06-candidate-restarted`, or `failure-*`) capture the actual installed native
renderer via CDP, not the Windows OS desktop or a physical computer. Logs are
checked for credential patterns before PNGs and app output enter the upload
directory. Launch, installer, harness and product failures remain failures.
