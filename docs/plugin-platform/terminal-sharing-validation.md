# Selected terminal validation record

The continuation uses ordinary merges from integration #3993 at
`37df67256e7eedc1050f186bcf401dc376cb5e71`, current main at
`f0897c3c1`, and WIP `3cdc97782ef3262969eee9d540e03ebe6fdee210`.
All three remain ancestors. Main includes input-mode snapshot correction #3991.
The original checkout remains clean at `58c6a216a`. No frozen feature branch,
main branch, or release was rewritten or published.

## Automated checks

| Check | Result |
| --- | --- |
| `npm run test:plugin-runtime` | 644 tests: 643 passed, one native skip, zero failures |
| `npm run test:plugin-contract` | 91 passed |
| `npm run test:plugin-examples` | Five passed, one existing opt-in database skip |
| Focused renderer, worker-manager, and #3991 popup input-mode tests | 119 passed |
| Final selection reader, host-dialog, and manifest tests | Five passed |
| Late runtime-mount regression, selection/dialog, and popup input-mode checks | 11 passed |
| Pane ownership correction, real runtime mount, consent dialog, palette feedback, and compatibility checks | 40 passed |
| Generated plugin contract, capability tools, Codex schema checks | Passed; tool catalogs unchanged |
| `npm run lint` | Zero errors, seven existing warnings |
| `npm run build` | Passed; existing chunk-size warning |
| Two independent sample builds | Same archive and content hashes |

The installed browser entrypoint tests use the real package store, manager, SDK,
RPC registry, permission middleware, and host interaction service. A linked worker
protocol harness supplies owned synthetic sessions through the real worker manager
and worker runtime. It creates no real SSH or provider connection. JSDOM exercises
the registered terminal selection reader and actual host dialog with signed tokens.
This is not an Electron sandbox or native GUI acceptance claim.

Assertions cover denial and consent cancellation, immutable snapshots, independent
terminal references, explicit false copy normalization, empty and oversized
selections, hidden and detached surfaces, reconnect, attached owner changes,
renderer replacement, expiry, source/runtime/version revocation, missing encoded
owners, late replies, and zero PTY writes for multiline/control-containing drafts.
The existing compose draft, broadcast behavior, and input-mode compatibility keep
their original paths.

Standalone `tsc --noEmit` remains outside the clean repository checks. A comparison
with the merged baseline reports the same 447 normalized diagnostics, with no new
or removed diagnostic. Package builds and the prescribed production build pass.

A real runtime-mount regression failed against the first published head
`3cfc7db3716b42f346e2819c822f546e949e1a88`: the selection hook saw a null ref before
asynchronous xterm creation, without a later focus/status render. Publication now
also runs after runtime assignment, teardown, and hibernate wake completion.
The regression and the associated popup input-mode checks pass. This uses the
existing mount and wake paths and adds no polling or terminal reader fallback.

That earlier head passed [test CI](https://github.com/binaricat/Netcatty/actions/runs/40380234637)
with 15,316 tests, 15,266 passed, 50 skipped, and zero failures. All four
[platform package jobs](https://github.com/binaricat/Netcatty/actions/runs/40380234655)
also passed. The Draft PR records fresh exact-head results for the lifecycle fix.

The subsequent pane-ownership regression failed on `3e5d450a1`: the actual solo
snapshot `solo|solo|na` yields the legacy `isFocused: false`. Workspace Focus mode
has the same `na` token. The new selection reader had incorrectly treated that
legacy bit as effective input ownership. It now consumes the existing optional
`isFocusedPane` semantics: undefined outside split contention, true for the
selected split pane, false for other split panes. Visibility remains mandatory.
The parser and the legacy focus bit are unchanged.

The production pane-to-Terminal props are factored into
`resolveTerminalPaneInputProps` without changing their values. Reader and real
runtime-mount tests consume that same mapping for solo, Focus mode, selected and
other split panes, inactive tabs/workspaces, and a hidden terminal layer. The host
consent-dialog test also starts from the real solo props rather than a supplied
`focused: true`. All existing source, connection, preview, and lifecycle guards
remain in place. A rejected palette plugin command now uses the existing bounded
localized toast; it exposes no raw diagnostic and performs no retry.

## Packaging and native acceptance

Local `npm run pack:dir` completed its production build, then stopped while
rebuilding `@serialport/bindings-cpp` for Electron 42.11.12. The proxy returned
HTTP 403 for the configured Electron header download under
`https://www.electronjs.org/headers`. It produced no accepted desktop package.
The download was not retried through a mirror. Exact-head platform CI remains the
packaging verification surface; its result is recorded on the Draft PR.

The original owner-head sample archive is
`f3b8ac268edbf616effe76110f372d2249e414675d877020a074c89f03c65950`.
The unified candidate rebuild has a different SDK and archive hash; its current
hash, source checkpoints and review/native gates are in the
[acceptance record](acceptance-candidate.md). Do not substitute the owner archive
for that candidate's package.
The parent-coordinated [native recipe](terminal-sharing-native-qa.md) remains
pending on the reserved GUI machine. No GUI launch, sandbox bypass, helper
permission change, paid provider call, or real-user resource was used.
