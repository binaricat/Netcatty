# Plugin AI and selected context: implementation checkpoint

Base: ThemePack #3978, `91b8927c56314e68c06e2c008e84559ddfb96d78`.
Branch: `feat/plugin-ai-context`.
Status: source-bound services, default trusted main/renderer adapters, app preload,
the AppView host chooser, canonical private IPC types, and an installable minimal
example are connected. Complete independent review and native acceptance remain
pending. This source is not ready to merge or release.

## Public boundaries

The parent approved `ai.model-invocation` and `context.selected-read`. The
transport task owns the public schema, SDK, and runtime peer. Its
`c4433d4961ecf4a81bea92b0a14f47b4ec12f679` head contains the public AI/context
routes and is merged into this branch. The parent assigned this task the additive
trusted-host IPC schema, preload, AppView mount, and AI-only hostService wiring.
The base later advanced to `f1410f8bb`; its source/stream changes are incorporated
by ordinary merge. Three overlaps retain this branch's permission explanations,
bounded-stream assertions, and six-file assistant staging. The source database
and sidecar changes come from their owning task, without local modifications.

The model API uses a host-selected configured model. Plugins receive a chat
handle, a display label, an expiry, turn handles, text chunks, and usage totals.
Plugins do not supply provider IDs, URLs, credentials, tools, or Agent policies.
The internal operations are `open`, `start`, `read`, `stop`, and `close`.
`read` pulls one chunk with one pending read per turn through the registered SDK
and runtime routes.

Context summary enumeration returns only references explicitly shared with the
current runtime and source owner. Content reads require an opaque handle and an
expected version. Summary enumeration never calls the content reader. Supported
selected scopes are workspace, tab, session, host, and Note. There is no inventory
or arbitrary entity-ID lookup.

## File ownership

| Owner | Files or responsibility |
| --- | --- |
| This task | `electron/plugins/ai/`, `electron/plugins/context/`, `infrastructure/ai/plugin/`, `examples/plugins/assistant/`, this document |
| This task | Opt-in `requireBridge` and `maxStreamBytes` request context in `infrastructure/ai/sdk/providers.ts` |
| This task | Additive trusted-host IPC types and generation, app preload methods/types, AppView host mount, AI-only hostService adapter construction/registration |
| This task | Host security-dialog visibility hook in the modal/tab plugin view lifecycle |
| This task, reassigned by parent | Four permission descriptions and the bounded `network.stream` contract test expectation |
| Transport task | Public canonical schema, generated SDK, runtime forwarding, generic stream registration |
| Market task | Source identity, private data-owner namespace, installer database, marketplace UI |
| Transport task | Generic TCP and TLS streams |
| Logging task | Optional local plugin logs |

The existing `feat/plugin-terminal-sharing` commit
`3cdc97782ef3262969eee9d540e03ebe6fdee210` is preserved. Its
`terminal-sharing-wip.md` describes incomplete selection publication and review.
This branch does not claim that workflow is complete.

## Implemented authority

`PluginAISourceBinding` authenticates the current browser runtime before reading
`getActivePlugin().source`, `getRetainedPluginSource`, `privateOwner`, and
`publicPluginId`. Source binding is rechecked after asynchronous work. The source
database and sync implementation are unchanged. Source origin does not imply
that a package is officially maintained.

`ModelInvocationBroker` requires host-provided `resolveDataOwner`,
`resolveBudgetOwner`, and `selectModel` adapters. The service derives the stable
budget owner from the authenticated source key and opaque private owner. It never
accepts a plugin-supplied budget key or falls back to a bare plugin ID. Strict
runtime binding objects still govern handle access; their replacement does not
reset request or token budgets. It keeps chats and turns in memory. It stores no chat
history and makes no database changes. Data owners are opaque host identities;
no private storage is keyed by `pluginId`.

Each handle is bound to a data owner, a runtime ID, and a plugin version.
Every read rechecks runtime authority, the current model, handle lifetime, and
selected context versions. Revocation aborts pending turns. Late provider results
are discarded. Another source with the same plugin ID cannot read, cancel, or
close the original source's handles.

`SelectedContextAuthority.share` is a trusted host operation. A plugin must never
call it directly. Its descriptor accepts only a scope, a title, a version, a text
reader, and a current-selection guard. Unknown Host fields are rejected. Content
has a 16 KiB cap, excludes NUL, and rejects PEM private keys. The production host
reader must project safe fields explicitly and exclude passwords, private keys,
TOTP values, identity credentials, startup commands, and environment variables.
Free-form Notes can contain secrets that field projection cannot detect. The
trusted sharing UI must preview the selected text before sharing it.

`createPluginModelAdapter` calls the existing `createModelFromConfig` and
`streamText`, through the existing host provider transport. Credential injection
stays in Netcatty. Direct-fetch fallback is disabled for this adapter. Incoming
SSE payloads have an aggregate 128 KiB cap before SDK buffering. The main
transport also enforces a plugin-specific 128 KiB response cap and a 60-second
total deadline. Host-owned request tags allow sender/runtime cancellation
without cancelling the internal Agent's ordinary streams. SDK retries are
disabled. Only text and allowlisted token totals reach the broker. Provider
errors, raw chunks, reasoning, headers, and tool payloads do not cross it.

No AgentRuntime, internal prompt, full MCP catalog, tool executor, Node runtime,
raw host IPC, or global renderer store is exposed to plugins. A model tool request
ends the turn without executing an action. Notes edits and terminal input are
outside this checkpoint. No command is written to a terminal or followed by Enter.

The default broker limits are defined in `MODEL_INVOCATION_LIMITS` and
`SELECTED_CONTEXT_LIMITS`. They include concurrent handles, turn and chat lifetime,
input and output bytes, output token caps, event count, requests per minute, and
reserved tokens per minute. Input token reservation uses UTF-8 bytes plus 1,024
bytes for framing and the output token cap. This is a conservative estimate, not
a tokenizer or a monetary billing cap. Provider usage is reported separately.
Reservations are not refunded after cancellation. Rate limits survive runtime
restart within the broker's lifetime. Host shutdown clears this in-memory state.

## Connected host path

`createPluginHostService` constructs `PluginAITrustedHostAdapter` by default from
the existing interaction window, app-lock subscription, and native dialog. It
registers the trusted ready/response IPC handlers. App preload exposes the request
subscription and validated responses only to the trusted application renderer;
the sandbox view preload does not expose these methods.

`AppView` mounts `PluginAIContextHost`. Its hook chooses the currently configured
host model and opens an app-owned Note chooser. `trustedHostRuntime` keeps the
provider adapter and selected readers in renderer-local maps; only canonical,
validated request/results cross the main/renderer IPC boundary. The default
adapter authenticates the current main-window sender, uses one-use nonces,
rechecks the current owner after awaits, and invalidates on lock, navigation,
hide, destruction, or renderer replacement. Plugin permission revocation,
disable, and runtime release abort that runtime's turns and transport requests.

Summary enumeration, content reads, and model invocation require separate
permissions. Before selected text becomes model input, a native host dialog
shows that exact text and version with Cancel as the default. Model invocation
permission grants neither context nor action access. Menu IDs are never data
authority. While the app-owned chooser is present, the active native modal/tab
plugin view yields so it cannot cover the chooser. Existing embedded views use
their host-overlay occlusion observer. Native stacking still requires desktop QA.

The selected-context authority is read-only text. Its constructor and lifecycle
API are documented in [Selected context authority](selected-context-authority.md).
Host metadata handles cannot be promoted into edit/connect authority; those
actions require separate typed host targets, grants, and confirmations.

## QA evidence

The domain suites and transport suite use synthetic data only. The transport
suite starts a deterministic OpenAI-compatible HTTP server on loopback and
checks this path:

`ModelInvocationBroker` -> `createPluginModelAdapter` -> `createModelFromConfig`
-> `createBridgeFetchForSDK` -> existing `_streamRequestForTests` main transport
-> local fixture -> text and usage.

This is not real model inference or paid API testing. It uses no paid keys, real
Notes, hosts, or chat history. The credential value is a fixed synthetic marker;
the existing model factory replaces it with its IPC placeholder. The test does
not exercise native credential storage or production credential injection.

The tests cover source, runtime, and version denial; separate summaries and
content reads; context invalidation; provider cancellation and late results;
deadlines; request, token, event, input, output, and stream-byte limits; and
allowlisted response serialization. Raw provider diagnostics remain inside the
host.

Commands:

```sh
node --test electron/plugins/modelInvocation.test.cjs
node --test --import tsx infrastructure/ai/plugin/modelInvocationAdapter.test.ts
npx eslint infrastructure/ai/plugin/*.ts infrastructure/ai/sdk/providers.ts examples/plugins/assistant/panel.js
```

The installed assistant command test passes on this branch's ordinary merge with
transport head `c4433d496`. It installs and
activates the six-file sample through the actual package manager and runtime peer,
then checks canonical SDK/RPC, independent model/content denial, text-review
cancellation, text/usage streaming, spoofed fields, revocation, and stale versions.
The in-process browser harness is a Node test transport, not native sandbox proof.

`components/PluginAIContextHost.test.tsx` connects the default main adapter, actual
app preload factory, mounted host chooser, installed sample command/runtime peer,
existing provider factory, and existing main HTTP transport to the loopback
fixture. It checks content denial, review cancellation, streaming usage, Stop,
lock revocation, and absence of keys/configuration/policy on the trusted wire.
The view-visibility tests cover chooser appearance, dismissal, hidden surfaces,
and teardown without restoring an old view. DOM tests do not establish native
WebContentsView stacking or Chromium sandbox behavior.

The trusted main/renderer suites cover nonce replay, sender substitution, owner
replacement, navigation, hide, runtime release, lock, cancellation, focus recovery,
safe field projection, and late selected-content results. The main transport test
also verifies targeted plugin cancellation leaves an ordinary synthetic Agent
stream running and aborts an oversized plugin stream.

Failed aggregate runs remain evidence, not passing acceptance records:

| Log in `/tmp` | Result |
| --- | --- |
| `netcatty-ai-qa-tests-full.log` | 14,912 tests: 14,783 passed, 85 failed, 1 cancelled, 43 skipped; a stuck FIDO child was terminated |
| `netcatty-ai-final-tests.log` | After standard dependency patches: 15,246 tests, 15,192 passed, 11 failed, 43 skipped |
| `netcatty-ai-final-runtime.log` | 610 tests: 607 passed, 1 failed, 2 skipped |
| `netcatty-ai-connected-final-tests.log` | Connected code `42a982660`: 15,248 tests, 15,204 passed, 1 failed, 0 cancelled, 43 skipped |
| `netcatty-ai-connected-final-runtime.log` | Connected code: 610 tests, 607 passed, 1 failed, 0 cancelled, 2 skipped |
| `netcatty-ai-fixed-runtime.log` | After `0ba3ea606`: 610 tests, 608 passed, 0 failed, 0 cancelled, 2 skipped |
| `netcatty-ai-fixed-contract-suite.log` | After `0ba3ea606`: all 88 contract/SDK/CLI tests passed |
| `netcatty-ai-fixed-final-tests.log` | Before the later review corrections, `173ef5abb`: 15,248 tests, 15,205 passed, 0 failed, 0 cancelled, 43 skipped |
| `netcatty-ai-review-final-runtime.log` | After both review corrections: 614 tests, 612 passed, 0 failed, 0 cancelled, 2 skipped |
| `netcatty-ai-review-final-tests.log` | Review-corrected head `d81896b0d`: 15,252 tests, 15,209 passed, 0 failed, 0 cancelled, 43 skipped, before the later base merge |
| `netcatty-ai-review-merged-tests.log` | Integrated head `07eb68c5e`: 15,255 tests, 15,212 passed, 0 failed, 0 cancelled, 43 skipped, before the selected-Note expiry correction |
| `netcatty-ai-note-expiry-runtime.log` | Selected-Note expiry correction: 625 tests, 624 passed, 0 failed, 0 cancelled, 1 skipped |

The ten Cursor failures in the second full run came from its missing SQLite
native dependency. Rebuilding the existing dependency with the standard
`node-gyp --devdir` option repaired them; the focused rerun passed 42 with 3
skipped. The sole connected full-run failure was a test expectation missing
`network.stream` after `network`. The runtime failure was permission-copy coverage
missing descriptions for `ai.invoke`, `context.selected.list`,
`context.selected.read`, and `network.stream`. The parent reassigned these two
hunks here. Commit `0ba3ea606988e95df256d449395adb7190b46fa0` adds accurate English
and Chinese descriptions and updates the resource-scope test. The test checks
both bounded optional stream declarations and rejection of the unbounded stream
shorthand. Transport can consume this isolated two-file commit.

The permission-copy test, complete 88-test plugin contract/SDK/CLI suite, and
610-test runtime aggregate now pass (with 2 existing runtime skips). The earlier
whole-repository red totals remain historical records; no passing whole-repository
rerun is claimed from these focused repairs. Exact-head CI is recorded on the PR.

The final connected UI/visibility run passes all 3 tests. The 47 focused
service/preload/runtime checks and 7 connected provider/renderer checks also pass.
`npm run check:plugin-contract` passes. The six-file package validates and retains
the SHA-256 recorded in the native recipe.

The connected AppView production build passes. Full lint after the permission
repair reports no errors and
seven existing warnings. The repository typecheck remains red with 773 diagnostics;
the new adapter, component, hook, and visibility modules have no diagnostics. Native packaging's
standard Electron rebuild stops at its hardcoded `/home/agent/.electron-gyp`
cache outside this executor's writable roots. No dependency patch or home-directory
override was used to bypass it.

The package build validates six files. The final artifact and native procedure
are recorded in [the native QA recipe](assistant-native-qa.md). The source staging
excludes build tooling and has no Node entry, network, filesystem, secret, storage,
or terminal permission.

Independent review confirmed the malformed-reference revocation defect on
`afe831bfc`. The two regression tests failed before the repair and pass afterward.
The repair is retained in #3985 head `4882e0501`. Further review was initially
blocked. After receiving newer exact maintainer security-task evidence, the same
worker completed its bounded read-only review of `173ef5abb` without a repeated
restriction or alternate route/model. It confirmed the earlier repair and found
two additional P2 defects: runtime-bound budget keys and the sample's expired
chat recovery.

Commit `ee5a4a406` separates stable source budgets from strict runtime handle
identity. Its fake-clock regression uses the actual source-binding class,
replaces runtime binding objects, tests request and reserved-token budgets,
isolates another source with the same public plugin ID, and checks the minute
boundary. Both budget subtests fail on the reviewed source and pass after repair.
Missing or invalid host budget identities fail closed.

Commit `e1cb95ee8` reopens an expired sample chat before an explicit Send and adds
**Refresh model** for changed-model or failed sessions. Refresh preserves the
draft and does not send inference. A failed send/read is never automatically
retried. Stop or page teardown invalidates pending opens and closes late sessions.
Four controlled-time DOM regressions fail before the repair and pass afterward,
including an uncertain inference outcome and Stop during reopening. They use no
network or paid provider. Failed-before logs are
`/tmp/netcatty-ai-budget-review-before.log` and
`/tmp/netcatty-ai-panel-review-before.log`; passing logs use the corresponding
`-after.log` names. Correction review independently confirmed the stable budget
fix, but found the remaining selected-Note expiry path at `07eb68c5e`.

The corrected broker suite passes all 17 tests, the sample's controlled-time
panel suite passes all 4, and the connected provider/UI suite passes all 4. Full
lint still reports zero errors and seven existing warnings; codegen drift and
the production build pass. Two independent package builds reproduce SHA-256
`c0f733697b8f43a8591f39c02aeea5d8b7b4bd544b642ed87e758e62d98696a5`
for that earlier sample checkpoint.

Commit `9e7c9df58` adds explicit **Choose reference** recovery. The panel retains
summary expiry locally, blocks an expired selection before Send, and never sends
that local metadata as an authorization field. Refresh model never re-shares a
Note. Re-selection opens the existing host chooser and resets the dropdown to
No reference; the user selects the fresh handle and clicks Send explicitly.

The service's identical-selection cache now reuses only complete live summaries.
After an explicit host re-selection, expired/revoked handles remain invalid and
fresh eligible handles are issued. No authority lifetime or revocation rule is
changed. Summary selection does not read text. Every new content handle still
requires the existing per-context grant and exact-text review.

The new fake-clock panel regression uses the actual host service and selected
context authority with a real synthetic Note handle. It covers expiry, model
refresh without re-sharing, explicit re-selection, denial of the fresh content
grant, cancellation of text review, and one successful explicit send with the
draft preserved. It repeats the expiry/re-selection with both chat and Note
lifetimes expired, then succeeds without a manual model refresh. A separate
service regression reproduces the formerly empty
same-Note cache after expiry. Both fail on `07eb68c5e`; failed-before evidence is
`/tmp/netcatty-ai-note-expiry-panel-before.log` and
`/tmp/netcatty-ai-note-expiry-service-before.log`. The combined panel/service
suite now passes all 10 tests; the connected installed UI/provider suite passes
all 4. The replacement six-file artifact has SHA-256
`c7d784d5c3bd2feb463afd58eae3a9594615395b168174cb8a3d0677584ae395`.
Independent verification of the latest correction and native acceptance remain
pending. CI is not a substitute for either.

Native Electron launch on this executor aborts because `chrome-sandbox` is not
root-owned mode 4755. No sandbox bypass or native retry was attempted. Native
screenshots, video, and installed UI acceptance belong to the parent's working
cloud GUI machine on the integrated exact head. No native acceptance is claimed here.
