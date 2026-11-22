# Installed Windows package acceptance (QA only)

This harness belongs only to same-repository Draft PR #4299 on
`qa/official-linux-a23868e`. Its independent standard `windows-2022` workflow
does not modify the product, release packages, main, or the earlier Linux job.

`candidate.json` pins the public v1.1.90 NSIS asset and the exact official
9d4e90b Windows Actions artifact. The downloader verifies repository, main push,
build job, artifact metadata and archive SHA-256 before extracting the one named
NSIS installer. The Actions read token exists only in this downloader step.

The installed real v1.1.90 GUI configures a deterministic loopback-only OpenAI
provider, saves one synthetic loopback host, and creates two distinct chats with
two complete user/assistant turns each. Beta remains active. No localStorage,
IndexedDB or React state writes seed the fixture. The same custom profile and
`app://netcatty` origin are reused by the installed official candidate. Read-only
storage observations compare original session IDs, full messages and scope,
the exact active pointer, saved host and the IndexedDB migration marker. The
candidate sends another normal GUI message, quits normally and restarts to
verify the appended turn and original chats persist.

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
