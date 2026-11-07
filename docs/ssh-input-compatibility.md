# SSH input compatibility

The host advanced settings include **输入兼容模式：逐字发送** (input compatibility: send character by character). The help text is **中文输入或短粘贴出现丢字时尝试开启。** Saved changes take effect after reconnecting.

New SSH hosts use standard mode. Compatibility mode retains the interactive text workaround introduced by [PR #3168](https://github.com/binaricat/Netcatty/pull/3168):

- Literal IME commits with multiple Unicode code points use separate writes.
- Plain, unbracketed pastes of at most 32 Unicode code points use separate writes.
- Longer raw pastes, bracketed pastes, Kitty associated text, and the existing confirmed line-paste path retain their current transport behavior.
- Terminal controls stay together. Unicode code points retain their byte order, including combining marks and emoji sequences.

The setting belongs to the terminal endpoint host. A host used only as an SSH network jump does not supply the target's input setting. Other transports retain their existing input behavior. Automated commands, connect scripts, and SFTP do not use this setting.

## Stored records

`Host.sshInputCompatibility` stores the choice as a boolean. `sanitizeHost` migrates an SSH record with a missing field to `true`, including records whose omitted protocol means SSH. It preserves explicit `false` and `true` values on every subsequent load, import, and save. The existing vault normalization and persistence paths save the migrated value. No global migration marker or new storage key is required.

New host creation paths save `false`. Duplicates copy the source value. JSON vault backups and cloud sync retain the field. CSV exports include `SshInputCompatibility`; imports accept `true` and `false`. External imports without that column create standard-mode hosts.

The connection captures the host's setting under its session-owned terminal settings ref. This snapshot survives xterm disposal and the actual hibernate wake/reattach path. Reconnect refreshes the setting through `resetConnectionInputState(host)`, including reconnects that reuse the existing runtime.

Attaching an observe popup transfers this captured choice through the existing terminal snapshot IPC. The popup restores it before attaching input to the live backend. Closing the popup returns it with the display snapshot. A hibernated home reads and restores the same session-owned state without consulting the current Vault preference. These handoffs do not reconnect or apply a newly saved choice.

## Historical evidence

[Issue #3077](https://github.com/binaricat/Netcatty/issues/3077#issuecomment-5433744875) reports that individual hanzi worked in a Qianxin search prompt where multi-character input failed. The report also says Windows with Xshell worked. Those observations do not establish the remote parser's SSH-write semantics or Xshell's default implementation.

The [Xshell 7 manual](https://cdn.netsarang.net/docs/Xshell7_manual.pdf), section 5.2.21, printed page 27, describes session paste character delay, line delay, and prompt waiting. [SecureCRT's echo flow control tip](https://www.vandyke.com/support/tips/echoflowctrl.html) describes a session line delay and an optional script that waits for each line's echo. These references support configurable send compatibility. They do not establish default per-character IME sends or equivalence to a Qianxin-specific fix. This feature adds no delays or echo waiting.

## Verification boundaries

`sshInputCompatibility.integration.test.ts` runs real xterm and `createXTermRuntime` callbacks under JSDOM. It covers raw paste, literal `insertText`, key code 229, composition events, composition fallback, long IME text, terminal controls, bracketed paste, Kitty text, reconnect with a reused runtime, and the actual `wakeTerminalFromHibernate` entry after a saved setting changes. Local, Telnet, serial, Mosh, and Eternal Terminal cases verify that the SSH field leaves their legacy text and control-containing payload behavior unchanged. Canvas measurement is stubbed. These tests do not exercise native input methods or application windows.

`sshInputCompatibility.popup.test.ts` runs the actual popup host resolver, home snapshot callbacks, attach boot effect, popup close callback, and real xterm paste handlers. Both saved-setting directions are covered with a live or hibernated home, including input after returning and waking. `terminalBridge.rebindOutput.test.cjs` exercises the preload and authorized main-process snapshot round trip, preserving explicit `false` and rejecting invalid metadata. These automated popup checks do not constitute native multi-window or OS IME validation.

`useVaultState.inputCompatibility.test.ts` exercises the actual vault hook's asynchronous save, reload, duplicate, JSON backup, local backup payload, and cloud payload apply paths. It uses test localStorage and no native safeStorage key. CSV and endpoint selection have separate round-trip and jump-host tests.

## Isolated OpenSSH timing fixture

The implementation-side fixture connected to an owned OpenSSH server on `127.0.0.1:22379` using public-key authentication. It executed `cat` without a PTY because the unprivileged daemon could not allocate one. Production IME/raw-paste selectors and the code-point chunker supplied an `ssh2` client's `channel.write` calls. This fixture did not include native GUI events, renderer IPC, clipboard handling, or an OS input method.

Each sample used 15 consecutive repetitions per mode on the same ready SSH channel. Standard mode ran before compatibility mode for each sample; the modes were not randomized or interleaved. Authentication, command startup, selector evaluation, and chunk-array construction finished before timing. Each repetition started immediately before its first `channel.write` call and ended after the awaited receive-length condition resolved: the client's echo buffer contained at least the expected UTF-8 byte length. The complete received buffer was then compared byte-for-byte with the input, outside the timer. No artificial send delay was added.

The table reports milliseconds. Median is the eighth sorted observation. P95 uses nearest rank, which is the largest of 15 observations here. Every repetition in all six tested sample pairs preserved the exact input bytes.

| Sample | UTF-8 bytes | Client writes, standard / compatibility | Echo median, standard / compatibility | Echo P95, standard / compatibility |
|---|---:|---:|---:|---:|
| `中文输入` (IME selector) | 12 | 1 / 4 | 47.439 / 44.572 | 57.971 / 48.418 |
| `中文👩🏽‍💻é-hostname-123` (raw paste) | 37 | 1 / 21 | 46.628 / 47.957 | 51.753 / 55.012 |
| `中` repeated 32 times (raw paste) | 96 | 1 / 32 | 44.122 / 47.536 | 49.040 / 54.734 |
| `中文abc👩🏽‍💻é` repeated 4,096 times (raw paste) | 110,592 | 1 / 1 | 5.433 / 6.240 | 26.105 / 54.073 |
| Arrow sequence `ESC [ A` | 3 | 1 / 1 | 44.320 / 47.657 | 55.726 / 52.414 |
| Bracketed paste containing `中文` | 18 | 1 / 1 | 44.151 / 44.995 | 48.959 / 55.769 |

These are local end-to-end SSH echo completion times for this fixture. They are not native app paste latency, remote processing time, a throughput benchmark, or evidence that the previous behavior caused lag. Client write-call counts do not establish SSH packet boundaries, server read boundaries, or SSH channel-data block counts.

## Native desktop results

The final native report tested production code commit `bd5f27ff42d29b18c0e9cb3513415da3243dd636` against two owned loopback SSH endpoints in an isolated profile. The following checks passed:

- New hosts defaulted to standard mode. Duplicate, save, and application restart preserved each host's choice.
- Saving during a connection did not change its input mode. A real reconnect adopted the saved mode in both directions.
- Full hibernation used a 5-second hidden-tab delay and zero retained renderers, with xterm absence confirmed. Wake/reattach retained the old connection choice in both directions; a subsequent reconnect adopted the saved choice.
- A missing-field legacy record was seeded into the isolated host store. Real application startup migrated it to `true`. After the user disabled compatibility, saved, and restarted, the value remained `false`.
- The Chinese setting label, help text, and reconnect notice matched the required text and were captured in screenshots. Arrow and Ctrl+C bytes remained intact.

| Native sample | Received-content result | Observed SSH channel-data blocks, standard / compatibility |
|---|---|---|
| `中文测试🙂é输入兼容模式` — 37 UTF-8 bytes, 13 code points | Hashes matched between modes | 1 / 13 |
| Long sample — 131,072 bytes | Hashes matched between modes | Four 32,768-byte frames / four 32,768-byte frames |
| Negotiated bracketed paste — 49 bytes | Preserved | 1 / 1 |

The native short sample differs from the implementation fixture's 37-byte sample above. Its 1 / 13 SSH channel-data block observation is not the implementation fixture's 1 / 21 client write-call count. The native 131,072-byte long sample is also distinct from the 110,592-byte timing sample.

The native timing observation was one PTY first-to-last receive span per mode: standard **3.408724 ms**, compatibility **1.600044 ms**. It starts at the first received PTY payload and ends at the last received payload. It excludes the input-to-first-receive interval and is not total GUI paste latency. One observation per mode does not provide a median, P95, or causal performance comparison. These spans cannot be substituted for the 15-repetition client echo timings above. Neither run establishes throughput superiority or that the previous workaround caused lag.

Actual OS IME input and Qianxin hardware were not tested. Native networked cloud sync, import, and jump-chain behavior were also not tested; those data flows have automated coverage rather than claimed native validation. Synthetic DOM composition events, native GUI/paste coverage, client write calls, SSH data blocks, and receive timing remain separate evidence categories.

Independent review confirmed the three reported P2 findings resolved, with no new blocking findings. The native application, SSH and clipboard fixture processes, isolated profile, and test keys were cleaned up; the source tree was clean after that run.

## CI result

The `test` workflow completed successfully for documentation commit `38c5f4744cb5fc3ecdd4e624b323587a471e4333`: [run 40319492139](https://github.com/binaricat/Netcatty/actions/runs/40319492139). That workflow includes `npm run lint`, `npm test`, generated-spec checks, and `npm run build`. The production code is unchanged from the native-tested `bd5f27ff` commit. Subsequent acceptance-text edits change documentation only. The original feature was merged in [PR #3977](https://github.com/binaricat/Netcatty/pull/3977); those results predate the popup snapshot follow-up.
