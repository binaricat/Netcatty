# FIDO2 SSH validation without hardware

Run the real OpenSSH integration simulation on Linux:

```sh
npm run test:fido-sim
```

Prerequisites: Node.js 22+, a C compiler, OpenSSL development headers, and
OpenSSH `ssh-keygen`, `/usr/bin/ssh-agent`, `ssh-add`, `ssh-sk-helper`, and
`/usr/sbin/sshd`. The test runs an unprivileged server bound to a random
localhost port and uses Netcatty's managed temporary directory. It does not
modify system SSH configuration or the user's login agent.

The opt-in test compiles `scripts/fixtures/fido/provider.c` as an OpenSSH SK
provider and exercises the production key generation, askpass and agent helpers.
It covers both ED25519-SK and ECDSA-SK, PIN-required enrollment and signatures,
tokenized IdentityFile references, inline handles, SSH command execution, SFTP,
TCP forwarding, CA certificates under IdentitiesOnly, and simultaneous callers
from separate windows. The independent OpenSSH server verifies the signatures.

The provider is strictly a test fixture: its opaque handles contain disposable
software private keys, and its PIN is always `123456`. It must never be selected
for a real account. Its resident flag support only simulates enrollment; it does
not enumerate stored resident credentials.

The ordinary test suite also exercises PIN/touch helper subprocesses, modal
cancellation, helper-exit cleanup, platform selection, resource release and SK
signature framing. `npm test` skips the opt-in integration simulation.

This verifies the OpenSSH integration on Linux with a software authenticator.
Real USB/CTAP devices and Windows/macOS installations still need device testing.

The Linux simulation also removes the optional `.pub` file before strict agent
selection, runs two real native OpenSSH clients concurrently against separate
caller-bound agent sockets, and checks native SK certificate authentication.
It verifies that releasing a second certificate preserves the bare key and
the first certificate while removing only the released certificate. Native
Mosh/ET authentication uses these sockets so its signatures follow the same
window attribution and recovery wrapper as ssh2.

Identity preparation and removal are serialized per underlying agent socket.
Bare-key removal uses `ssh-add -d -k` and certificate removal has its own hold;
staging directories remain until all associated removals have completed.
The tests also cover partial credential-write failures, socket paths containing
spaces, and unknown agent-extension requests followed by normal requests on
the same connection.

## Native Windows integration check

The `windows-fido` job in `.github/workflows/test.yml` runs native Windows Node
with real MSYS2 OpenSSH and an MSYS-built version of the disposable provider.
It uses a managed temporary path containing spaces and exercises Windows
named-pipe askpass IPC, enrollment and actual signatures
for both SK algorithms, PIN plus a separately gated touch, incorrect PIN,
missing-device cancellation with a saved password, and explicit password
fallback. A local SSH protocol server verifies the signatures and executes a
test command. The independent Docker/OpenSSH server check above runs on Linux.

This checks a specific **user-mode MSYS2 OpenSSH** configuration. It does not
establish support for every Windows OpenSSH distribution, the Windows system
agent service, Git for Windows, native WebAuthn dialogs, or physical USB devices.
Windows currently has no `ssh-sk-helper` error observer: recovery must retain
the generic verification-failed reason rather than guessing which device error
occurred. The Unix helper's 30-second cancellation deadline also does not apply
to this Windows path.

For a physical-device check of this configuration, launch Netcatty with
`NETCATTY_SSH_AGENT_PATH` and `NETCATTY_SSH_KEYGEN_PATH` pointing to the matching
MSYS2 executables and put that installation's `usr/bin` on `PATH`. Use its real
built-in FIDO provider; **never** set `SSH_SK_PROVIDER` to the CI fixture. Check
the complete application flow against a separate SSH server: select the saved
SK identity on a host, connect, fulfill the actual PIN/touch requests, execute a
command, and repeat with the device absent, removed, and with PIN cancellation.
Record the Windows/OpenSSH/device versions and which dialogs are owned by the
application or OS. A successful software-provider CI run does not replace this
hardware check.

## Docker server and gated user presence

```sh
npm run test:fido-docker
```

Requires Linux, Docker, a C compiler, OpenSSL headers and the OpenSSH client
tools above. Host `sshd` is not required. The command builds a disposable Debian
OpenSSH server, publishes a random port on `127.0.0.1`, and removes its container
and temporary files on completion. The server accepts only public-key login as
the test user `netcatty`. Host keys are generated when the container starts.
Only disposable public authorized keys are mounted into the server; the client
and software provider run on the host through Netcatty's production helpers.

For each of ED25519-SK and ECDSA-SK, both touch-only and PIN-plus-touch modes
are exercised. The fixture's optional `NETCATTY_FIDO_SIM_CONTROL` file gates the
actual signature: the test first asserts that login has not completed, then
simulates physical touch independently of the renderer. No renderer response
is sent for OpenSSH's touch notifications. The test verifies automatic prompt
dismissal, command execution and SFTP, as well as rejection of missing touch,
device removal, wrong/cancelled PIN, and signed responses missing the UP or UV
flag. The latter assertions also check the independent server's rejection log.
A fresh login after each group of failures checks that the agent remains usable.
The fixture accelerates the simulated touch timeout to three seconds; it does
not reproduce device retry counters, PIN lockout or CTAP/USB transport.

## Expected security-key flow

This feature implements **FIDO2 OpenSSH security keys**, not the YubiKey PIV or
OpenPGP applications. The public key must first be installed on the SSH server.
During login, OpenSSH asks the device to sign; normal keys require touch, while
`verify-required` additionally requests user verification (typically the device
PIN). The private key remains on the real hardware; Netcatty stores its handle.
Resident credentials support recovery of handles on another machine, and do not
remove the presence/verification requirement.

OpenSSH's `notify_start()` invokes askpass with `SSH_ASKPASS_PROMPT=none` and
terminates the notification helper when the hardware operation finishes. That
mode is forwarded to the UI as `notificationOnly`: there is no Continue button,
and the dialog closes automatically when the helper exits. Closing this hint
only dismisses the notification; it does not authorize or cancel the hardware
operation. PIN prompts still have explicit Continue and Cancel actions. OpenSSH
can combine PIN and touch instructions into one prompt, so the UI also explains
that the user should touch the device after entering the PIN. The exact prompt
order depends on the OpenSSH/device implementation; the UI follows its requests.
For the agent's combined PIN/presence prompt, the UI keeps a touch-only waiting
hint after PIN submission, tied to the real signing operation's completion.

The feature is vendor-neutral: compatible security keys from other vendors can
be used. Check the device's algorithm support: ECDSA-SK and ED25519-SK are not
universally interchangeable. PIN/resident/biometric support also varies. A
touch indicates physical presence; it does not imply fingerprint recognition.

### Recovery and alternative authentication

On supported Unix OpenSSH installations, Netcatty wraps `ssh-sk-helper` to
observe its framed error reply before `ssh-agent` collapses it into generic
agent failure. The wrapper forwards the request/reply bytes unchanged and never
logs request contents, PINs or signatures. It pairs with the selected OpenSSH
helper, honors an existing `SSH_SK_HELPER`, and lives in the managed temp dir.
Unrecognized helper reply versions retain generic recovery while their bytes
are forwarded unchanged.
If no compatible wrapper is available (including native Windows agents), use
the generic verification-failed message instead of inventing a missing-device
diagnosis. Real Windows/macOS device behavior still requires hardware testing.

| Situation | Behavior |
| --- | --- |
| Matching device unavailable | Show the selected key's label and ask to connect its device; Retry continues the pending login. |
| Waiting for device confirmation | Show a touch/verification hint; the device completes it automatically. Closing the hint only hides it. |
| Device operation exceeds 30 seconds | Stop that helper operation, discard late signatures and offer Retry. PIN entry time is excluded. |
| Device removed while waiting | The helper's device-unavailable result returns to the connection/retry prompt. |
| PIN rejected | Explain that the device PIN was not accepted; require an explicit retry, without guessing remaining attempts. |
| Other helper failure | Offer generic recovery; do not claim the device is missing. |
| Saved password available | Offer an explicit "Use configured password" action after a failed device operation. Cancel does not select the password. |
| Device removed after SSH login | The established SSH session continues; the device signs authentication, not each terminal command. |

The configured SSH authentication deadline still bounds the pending connection.
Device recovery also closes when its owning session/window is torn down. A
lost prompt window or explicit cancellation fails closed; late results cannot
authorize the cancelled attempt.

The Docker suite accelerates the helper deadline to 1.5 seconds and verifies
both key algorithms, device insertion/retry, removal, timeout, incorrect PIN,
unknown/unsupported failures, explicit password fallback and cancellation with
a valid saved password. UI recordings shorten the deadline to 4.5 seconds and
use the complete host -> key selection -> production SSH bridge -> Docker shell
path; only the Electron transport and physical authenticator are simulated.

References:

- [Yubico: Securing SSH with FIDO2](https://developers.yubico.com/SSH/Securing_SSH_with_FIDO2.html)
- [OpenSSH notify_start/notify_complete](https://github.com/openssh/openssh-portable/blob/V_10_0_P2/readpass.c)
- [OpenSSH agent security-key signing](https://github.com/openssh/openssh-portable/blob/V_10_0_P2/ssh-agent.c)
