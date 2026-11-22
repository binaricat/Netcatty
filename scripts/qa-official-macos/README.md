# Official macOS candidate smoke (QA-only Draft #4299)

Independent standard macos-26 Apple Silicon and macos-15-intel jobs pin official
main 9d4e90b / successful push run 44903060405 / artifact 14706977005. Only the
metadata/downloader step receives the built-in Actions read token. It verifies
repository IDs, head, branch/event/workflow, successful macOS job, exact artifact
ID/name/size/expiry and archive SHA-256, then extracts only the matching DMG.

Stock hdiutil verifies DMG integrity and mounts it read-only. ditto copies the
original Netcatty.app into a temporary runner-owned Applications directory,
preserving bundle metadata. The copied app must have the native Mach-O slice,
strict valid Developer ID signature, hardened runtime, a valid stapled APP
notarization ticket, and accepted Notarized Developer ID Gatekeeper assessment.
Outer DMG signature/stapler results are recorded separately and are never
presented as APP notarization. No OS/security/xattr/quarantine/privacy settings
are modified; an assessment preventing launch stops the GUI step.

The unmodified installed app executable launches its real native GUI with a
fresh synthetic profile and an allowlisted process environment retaining the
ephemeral VM's standard HOME/TMPDIR for ordinary macOS services. Actual app
version/path/origin/profile/architecture and stock web preferences are recorded.
Renderer automation and screenshots use loopback CDP/native capture, without
accessibility or screen-recording permission grants. No browser/UI fixture or
checkout-sourced application code replaces the official package.

A generated-credential ssh2 server listens only on 127.0.0.1. Normal Netcatty
Quick Connect GUI accepts that test host key in the isolated profile and opens a
real encrypted PTY/shell. Native xterm input sends a unique harmless printf
token. Both the server receipt/acknowledgement event and the production live
terminal reader must observe the explicit server acknowledgement. Screenshots
capture the actual startup, connection and terminal output. No LAN, external
SSH account, model, business data or public listener is used.

Evidence retained for three days: provenance.json, verification.json (including
exact OS command outputs and package identities), assertions.json,
application-output.log, and arch-prefixed native PNGs: 00-native-launch,
01-first-launch, 02-real-ssh-connected, 03-real-ssh-roundtrip, or failure-native-
application when possible. Assertions and reviewed images are saved before
cleanup; credentials/private keys/tokens in output withhold logs/images and fail.
Raw profiles and generated private keys are never uploaded.

This covers copy installation and first native executable GUI launch after APP
Gatekeeper assessment, not Finder quarantine ingestion, physical user devices,
LAN/privacy approval, automatic updating or a final merged revision. The stock
renderer sandbox:false preference is recorded honestly, never changed. Final
official revision replay requires a separately supplied merge SHA and artifact
IDs; the pinned candidate is not silently replaced.
