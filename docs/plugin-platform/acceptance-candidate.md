# Unified plugin acceptance candidate

This file records the frozen 677 native baseline. For the subsequent permission
policy and AI candidate, use [the new integration record](policy-ai-integration.md)
and its package manifest. Historical consent flows below are not the revised UX.

The dedicated branch is `integration/plugin-native-acceptance`. Its Draft PR
records the exact current head and CI runs. Native AI, database, Host/Vault, and
settings/logging checks use this candidate rather than separate feature trees.
Only the dedicated acceptance branch is published by this integration task;
the reported feature checkpoints are preserved through ordinary merges.

The previous candidate `174c525cd45bdc1152e9feb21839a288706d3bd1` passed
[test CI](https://github.com/binaricat/Netcatty/actions/runs/40381685282),
[four-platform packages](https://github.com/binaricat/Netcatty/actions/runs/40381685946),
and [ET CI](https://github.com/binaricat/Netcatty/actions/runs/40381684810).
No actionable CI regression was found. Its full test suite records 15,375 tests:
15,325 passed, 50 skipped, zero failed or cancelled.

The next candidate includes the published settings focus, AI budget/session/
selected-Note recovery, and terminal Solo/Focus ownership corrections. The parent
reports both correction reviews scoped clean at their exact source heads. Those
reviews do not establish aggregate package verification or native acceptance.
No uncommitted owner work is imported, and native activation is not performed
by this coding task.

## Included source checkpoints

| Slice | Frozen checkpoint | Integration evidence |
| --- | --- | --- |
| Main | `f0897c3c1711f60350f8d613696d387bcac464ed` | Includes #3991, #3983, #3992, and #3995 |
| Byte streams, source identity, connected AI, examples | #3993 `37df67256e7eedc1050f186bcf401dc376cb5e71` | Ordinary merge; both transport P2 fixes retained |
| Host/Vault actions | #3990 `730fa643ba0589b8919368657dabc83428f577be` | Ordinary merge; metadata/action authority stays separate |
| Settings and logging UI | #3994 `823db94cf34503417e3b7c19c6daab379f60530f` | Ordinary merge; retains dc6 alias repair and adds the natively verified gear-to-settings focus path |
| AI corrections | #3986 `ba09461676f52b6b1853385ba61845b48cf5f5ac` | Ordinary merges preserve budget/model recovery and final `9e7c9df58` explicit Note re-selection; same reviewer reports the bounded correction clean |
| Selected-terminal continuation | #3996 `8e7c28fe1bdbcdd76816d33ec926ba8e60eefe64` | Ordinary merge; independent correction review reports Solo/Focus ownership resolved; native acceptance pending |

#3995 was squash-merged into main as `f0897c3c`. Its PR tip was rechecked at
`921f51756eca564cef3d30152807a4649c2a0d3b`; both contain the same TERM-SSHD test
blob `cdfc067e6ca3b4f6b7b3d6e78834072ed84837b4`. The candidate keeps main's
deterministic first/alias OPEN-order cases instead of the older plugin-branch
test-only repair. No production transfer cancellation change is introduced.

## Resolve the shared integration files

- Root package and lockfile retain both the plugin workspace versions and
  main's pinned `@noble/ciphers` dependency.
- The assistant retains its six-file staging build. The Host/Vault branch's
  older assistant preparation does not replace it.
- `hostService.cjs` retains byte-stream, AI/context, Host/Vault, and logging
  construction and registration. Shutdown cleans up the existing services and
  closes logs in `finally`. Constructor-failure cleanup retains each service.
- The AI host remains mounted in `application/app/AppView.tsx`. The Host action
  host remains inside the Vault/session providers in `App.tsx`. Trusted preload
  methods, source-bound authority, and canonical schema definitions are retained.
- Canonical contract generation produces no drift after merging the shared
  schema. This worktree's `@netcatty/plugin-contract` and `@netcatty/plugin-sdk`
  resolve to its own `packages/` directories, not an older worktree.
- The terminal merge unions canonical terminal and Vault prompt fields, trusted
  preload methods, feature registration, and lifecycle cleanup. Terminal target
  capture reuses the existing admission method and authorization guard. The
  generic interaction UI continues to ignore Vault-only requests; Vault retains
  its own handler. Inert terminal draft review returns a boolean receipt, never
  edited text or terminal input.
- The installed Host test fixture now supports multiple lock listeners, matching
  the production app-lock bridge's `Set` subscription contract. The old fixture
  stored one callback and timed out after both Host and AI services subscribed.
  Production lock behavior is unchanged.

## Local evidence

Checks use Node 24.19.0 and a private task temp root through the existing temp
bridge. HOME, endpoint policy, and sandbox settings are unchanged.

| Check | Local result |
| --- | --- |
| Registered plugin runtime | 676 tests: 674 passed, one missing-Electron failure, one native skip |
| Final AI broker/context and real-handle sample panel | 27 passed, including explicit Note re-selection |
| Contract/SDK/CLI | 91 passed, zero failures |
| Host installed entrypoint/action isolation after terminal merge | 40 passed; earlier baseline Host/action/lock group passed 82 after correcting the subscription fixture |
| Terminal selection, pane ownership/lifecycle, draft UI, palette failure | 19 passed |
| Plugin settings/market/logging UI after gear correction | 36 passed, zero failures |
| Registered database/terminal examples | Five passed, one opt-in Docker skip |
| Vite lazy-settings HTTP/native-ESM probe | Passed after settings focus correction; dc6 alias repair retained |
| Main TERM-SSHD file | All 32 cases passed, including both controlled arrival orders |
| Contract/capability generation and drift, Codex schema | Passed |
| Full lint | Zero errors, seven existing warnings |
| Production build | Passed on the assembled source tree |
| Five sample packages | Validated; two builds of each match byte for byte |

The initial connected group is retained as a failed run: 39 passed, nine failed,
and two cancelled. The mounted AI chooser test failed because this local
`--ignore-scripts` dependency installation lacks the Electron binary. The Host
lock case timed out because of the single-listener test fixture; later subtests
were cancelled. The corrected Host group passes as recorded above.

The combined Vite/main regression run records 33 passed and seven failed. Its
Vite probe and all TERM-SSHD cases passed. The SSH algorithm import and six
ChaCha/Electron cases could not load the same missing Electron binary. The
normal pinned Electron installer was attempted with a writable task-local cache
and failed with `TypeError: fetch failed`. No alternate download route, native
rebuild bypass, Electron shim, or sandbox change was used. These local failures
remain separate from the exact-head CI results recorded in the Draft PR.

The final registered runtime failure is the installed terminal reference's
worker-reconnect case: the real worker imports the unavailable Electron binary.
The same case failed for this prerequisite before the final AI merge. The other
674 registered cases pass. The final focused AI suite passes all 27 cases; the
earlier connected adapter run retains two passes and one missing-Electron
failure. These failures are not relabeled as passing or suppressed.

## Reproducible packages and exact permissions

All package versions below are `0.1.0`. These hashes are for this candidate's
SDK and source tree. Older #3993 database archives have different hashes and
must not be substituted. The assistant and Host samples contain their READMEs;
the database packages contain only manifest, browser bundle, and three panel
assets. These handoff archives were not installed or activated in the native
GUI. The automated installed-entrypoint tests use temporary synthetic fixtures;
the Rfam candidate was not installed or granted permissions in any runtime.

| Package ID | Files | SHA-256 |
| --- | --- | --- |
| `com.netcatty.assistant` | 6 | `c7d784d5c3bd2feb463afd58eae3a9594615395b168174cb8a3d0677584ae395` |
| `com.netcatty.database-minimal` | 5 | `f01c6a24382897d4b0bf4130941274abacb9a9a963f9b56ecaceb2c020f36874` |
| `com.netcatty.database-rfam-readonly` | 5 | `aaca586669db454e91d61487e576ed524d1b7190eed182bc2cd0035e59caa0d3` |
| `com.netcatty.host-actions` | 3 | `cf04f82dfe25ab5cda6f5f3dad0a8fb06c37bedf9924f556bee2b8402e542ef2` |
| `com.netcatty.terminal-selection-draft` | 2 | `4c9c2388b7f891156192a0b5ab7b23291beba3555e7ec8cf24fbe2dfe1242d5e` |

The assistant matches the final owner's reported archive hash. Both database
archives and the terminal sample changed after rebuilding against the combined
SDK. The terminal source and CLI are unchanged from `8e7c28fe`; the integrated
SDK has additional exports. The measured terminal content hash is
`99797d8679f34b96580076f922cbec067e511adc0f4ccf396ed129206acb6c4c`.
These archives replace earlier acceptance artifacts. Repeat-build equality and
CLI validation do not grant native permissions or establish independent
aggregate/package security verification. Host activation remains blocked by
the separate automatic-review denial.

| Package | Required feature | Required permissions | Optional permissions/resources |
| --- | --- | --- | --- |
| Assistant | `ai.model-invocation`, `context.selected-read` | `commands`, `views` | `ai.invoke`, `context.selected.list`, `context.selected.read` |
| Owned database | `network.byte-streams` | `commands`, `views` | `network.stream`: exactly `tcp://10.77.0.20:3306` |
| Public Rfam | `network.byte-streams` | `commands`, `views` | `network.stream`: exactly `tcp://mysql-rfam-public.ebi.ac.uk:4497` |
| Host actions | `vault.host-actions`, `commands.interactive` | `commands`, `menus` | `vault.metadata`, `vault.write`, `ui.interact` |
| Terminal draft | `terminal.selection-sharing`, `terminal.input-drafts`, `commands.interactive` | `commands`, `menus` | `terminal.selection.read`, `terminal.input.propose`, each for one explicit operation |

The owned database address is packaging-only. A different approved fixture
endpoint requires a new package and hash. No route from the GUI to the coding
container's private MariaDB is assumed. The GUI's missing Docker runtime remains
a fixture prerequisite, not a reason to change loopback/own-interface checks.

Reproduction commands after building the plugin packages:

```sh
node examples/plugins/assistant/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/assistant/.package --out /tmp/assistant.ncpkg
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-owned.ncpkg
node examples/plugins/database-rfam-readonly/prepare.mjs tcp://mysql-rfam-public.ebi.ac.uk:4497 /tmp/database-rfam-readonly.ncpkg
node packages/plugin-cli/dist/cli.js pack examples/plugins/host-actions --out /tmp/host-actions.ncpkg
node examples/plugins/terminal-selection-draft/prepare.mjs /tmp/terminal-selection-draft.ncpkg
```

## Native, review, and deployment gates

| Gate | Status and next evidence |
| --- | --- |
| Exact-head test/build CI | Recorded in the dedicated Draft PR; earlier feature-head CI is historical evidence |
| Native settings UI | Parent reports dc6 layout/controls and 823 gear-to-settings focus passed; those source-head results do not certify every flow on the integrated head |
| Native AI sample | Final source correction review is scoped clean at `ba094616`; integrated native acceptance remains pending and activation is not performed here. Expiry requires fresh host selection, explicit dropdown choice, content grant and text review; no silent re-share or inference retry |
| Native owned database | Pending a supported disposable fixture path; owned live regression remains opt-in and was not run here |
| Public Rfam | Prepared only; no service DNS lookup, connection, query, installation, or permission activation. Parent coordinates exact hash/endpoint authorization. Only protocol 4.1/native-password is supported; auth/TLS compatibility is unverified and no fallback is added |
| Native Host/Vault | Parent reports installation/details passed. Activation consent was denied by automatic review. Functional Host flows remain unrun pending specific user approval. Do not retry that activation or change permissions to bypass it |
| Selected-terminal continuation | Correction review scoped clean at `8e7c28fe`; integrated checks recorded above; native acceptance pending. Input review remains inert and returns only a boolean receipt |
| AI independent security review | The same worker reconsidered the earlier restriction once with newer maintainer evidence and completed review without recurrence. Parent reports the final bounded correction review clean at `ba094616`, including generation guards and old-handle invalidity. This task does not repeat that review or claim independent aggregate/package verification |
| Main merge/release/deployment | Not authorized by this task; candidate remains Draft |

## Native handoff

Use the exact head from the Draft PR and the current five-package manifest/hash
record. Source-head review and native settings evidence remain separately
attributed. Do not substitute earlier assistant or database archives. No native
Host activation retry, automatic re-sharing, or inference retry is part of this
integration work.

Native evidence records the exact candidate commit, package hashes, source and
permission prompts, denial/retry/cancel/revoke behavior, screenshots, and video.
The coding executor's Node/DOM harnesses and Vite probe are not native sandbox
certification. Database protocol and fixed query code remain in the examples.
