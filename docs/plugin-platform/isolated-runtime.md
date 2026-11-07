# Isolated plugin host runtime

Status: internal preview (`0.1.0-internal`)

This document describes the isolated runtime introduced in phase 2 and secured
by phase 3 of the plugin platform tracked by
[#2269](https://github.com/binaricat/Netcatty/issues/2269). The runtime remains
hidden behind `NETCATTY_PLUGIN_DEV=1`; phase 4 adds a development-only native
settings/contribution surface, but there is no production plugin entry or
renderer permission UI yet. The first-party development bootstrap uses a native
Electron confirmation dialog. A host without an injected decision provider
still fails every interactive capability request closed.

## Installation transaction

The main process owns `userData/plugins/` and its SQLite database. A package is
never extracted directly into the active package tree. Installation performs
these steps:

1. open a non-symbolic `.ncpkg` source without following symlinks where the
   platform supports it;
2. copy it into a randomly named, mode-`0700` staging directory while hashing
   the exact bytes and detecting concurrent source changes;
3. validate and extract that private snapshot through the phase-1 package
   validator, including ZIP metadata, local/central header agreement, path
   aliases, size limits, CRC, manifest semantics, referenced resources, and
   companion digests;
4. retain the validated `.ncpkg` snapshot, write both its archive digest and a
   representation-independent logical-content digest, and sync the staged files;
5. when replacing an enabled version, persist a temporary disabled state and
   stop the old runtime before publishing any replacement;
6. rename the complete version directory into
   `packages/<pluginId>/<version>/` and switch the active version in one SQLite
   transaction.

The file rename occurs before the database transaction. A normal database
failure removes the just-published directory and restores the previous runtime.
If the process exits between the durable rename and the transaction, startup
recovery validates the committed directory and imports it as a disabled
version, even when an older version of that plugin was enabled. Files left
under `staging/` were never published and are removed. A database row whose
active package is missing or invalid is disabled and reported as an error
instead of being executed. Committed invalid versions are retained for
diagnosis or repair from their validated snapshot; only invalid uncommitted
orphans are deleted.

Uninstall uses the inverse two-phase move. The plugin directory first moves
under a marked `staging/remove-*` transaction and the database row is deleted
after both rename parent directories have been synchronized. On restart, a
remaining database row restores the directory, while
an already-deleted row completes removal. A crash cannot leave a live database
record pointing at a package that recovery discarded. A `remove-*` directory
created before any package was moved is harmless debris and is deleted even if
its metadata write was interrupted. Once a package has moved into that
directory, valid identity metadata is mandatory; missing or corrupt metadata
fails closed instead of deleting an unidentified package.

Installing the same version and archive is idempotent after the installed tree
is revalidated. Reusing the same plugin ID and version with a different archive
digest is rejected; version substitution must use a new version.

Before every runtime placement decision, `PackageStore.preparePackageRoot()`
rescans the installed tree and compares its logical-content digest with the
retained snapshot verified at startup. The digest binds each normalized path,
byte length, declared-companion classification, and file SHA-256, independent of ZIP
compression or entry ordering. Source-only ignored roots such as `node_modules`
are forbidden in the installed tree. Drift therefore disables the active
version before either a browser or utility runtime can observe modified code.
This asynchronous preparation method, rather than the synchronous path resolver,
is the mandatory execution boundary for all future runtime placements.

Install, enable/disable, restart and uninstall mutations share one manager
queue. A second renderer request cannot race an active-version switch or start
two runtimes for one plugin. Replacing an enabled version first persists a
temporary disabled state and fully stops the old runtime, then switches the
active-version pointer and restores the requested enabled state in the same
database transaction. Lazy activation cannot recreate the old runtime between
those steps. A failure before the pointer switch restores the prior enabled
runtime. If the new version fails activation after the switch, a compare-and-set
transaction restores and restarts the prior version while retaining the failed
package and its version-scoped error state for diagnosis. If the prior runtime
can no longer start, that restored version remains disabled instead of entering
an activation loop.

## Database ownership

`plugins.sqlite` uses WAL, foreign keys, `synchronous=FULL`, explicit schema
versions, and immediate transactions. It records installed versions, the active
version, enabled state, runtime state, version-scoped crash history, and
namespaced JSON key/value storage. The complete initial schema also keeps
permission grants, OS-encrypted secret ciphertext, and bounded security audit
records in user-owned tables with no package-version cascade. Newer unknown
database schemas fail closed. The plugin host has not shipped to users, so it defines one complete
initial schema at version 1 and has no migration chain. Pre-release phases may
still revise that initial schema (or reset development-only databases); schema
migrations begin only after a released build can have durable user data.
Because the host uses the synchronous `node:sqlite` API, transaction callbacks
must also be synchronous; returning a Promise aborts and rolls back instead of
committing an operation whose later failure could no longer be contained.
Crash counters and runtime state never cross a version boundary. A genuinely
new version starts with clean state, reinstalling the same version does not
bypass quarantine, and selecting a retained version restores that version's
prior error/quarantine state.
Explicit recovery clears only the active version's counter and preserves other
retained versions' failure history.

Development databases created by an earlier pre-release schema must be reset;
the project intentionally does not treat unpublished layouts as released
migration sources.

## Runtime selection

An installed manifest can declare browser, Node, or both entrypoints. During
the internal preview the host uses this deterministic placement rule:

- a manifest that declares native companions or a privileged terminal input or
  output interceptor is placed in the Node utility runtime, including when it
  also declares a browser entrypoint; these manifests must provide the Node
  entrypoint and `runtime.advanced`, while companions additionally require
  bounded `companion.execute` resources;
- otherwise, a browser entrypoint is preferred whenever it exists;
- a Node entrypoint is used when no browser entrypoint exists.

The rule keeps ordinary dual-target plugins on the least-privileged runtime
while making the privileged utility exceptions explicit and fail closed. A later trust
phase adds verified publisher identity to the advanced Node path; it must not
silently upgrade an ordinary plugin.

### Ordinary browser runtime

Each ordinary plugin receives a hidden `BrowserWindow`, a unique in-memory
session, and a unique unguessable protocol authority. It runs with Chromium's
OS sandbox, `nodeIntegration=false`, `contextIsolation=true`, no DevTools,
dialogs, webviews, popups, navigation, permissions, downloads, or network
requests. The session is forced offline, uses an unreachable proxy without a
loopback bypass, and restricts WebRTC to proxied traffic. It accepts only the
matching `netcatty-plugin://` authority, which remains available while ordinary
network schemes are offline.

The protocol handler reads resources as bytes after decoded path validation,
realpath containment and regular-file checks. It serves a restrictive CSP,
runtime bootstrap modules, the public SDK/contract modules, and only that
runtime's package root. Runtime tokens are removed when the plugin stops, so a
stale document cannot reopen package resources.

The preload has one job: transfer one host-created MessagePort into the plugin
document. A three-stage handshake waits for preload readiness, port receipt and
installation of the plugin-side RPC listener, avoiding load-order message loss.
It does not expose Electron, Node, Netcatty's application preload, or an
arbitrary IPC channel.

Before importing package code, the bootstrap removes direct fetch, XHR,
WebSocket, WebTransport, WebRTC, beacon and worker globals. These APIs are not a
substitute for network permission: ordinary plugins use the phase-3 host broker,
which authorizes each HTTP(S) origin, reauthorizes every redirect origin, omits
ambient cookies, and bounds request and response bytes.

### Advanced utility runtime

Node-only plugins run in a dedicated Electron `utilityProcess`, never in the
main process. The host passes a small environment, disables unsigned-library
loading, uses no shell, captures bounded stdout/stderr diagnostics, and checks
the entrypoint's realpath containment immediately before launch. A module loader
maps only the two public bare imports (`@netcatty/plugin-sdk` and
`@netcatty/plugin-contract`) to packaged host resources.

Stopping an advanced runtime is not complete when `utilityProcess.kill()`
returns. Netcatty closes its RPC authority immediately, requests termination,
and waits for the child `exit` event before a replacement activation may start.
Fatal and protocol errors follow the same ordering: the old process is reaped
before the supervisor publishes the crash. This prevents two privileged
versions of one plugin from overlapping during restart, update, or quarantine.
If the process ignores graceful termination, Netcatty escalates to an OS-level
forced termination after a bounded grace period and still waits for `exit`.
Failure to reap after escalation disables and quarantines the plugin for the
remainder of the application process; a replacement activation is blocked
until Netcatty restarts.

The utility process is an isolation and failure-containment boundary, not the
final permission boundary. Node plugins are still advanced code and must both
declare and receive `runtime.advanced`. Phase 3 enforces that consent, scoped
capability grants, companion digest policy and quotas. Phase 9 still adds
publisher signatures and distribution trust. This is one reason the entire
runtime remains behind the local development gate.

CPU and memory monitoring attaches when the BrowserWindow renderer or utility
process is created and samples immediately, so initialization and activation
run inside the same quota boundary as the steady-state runtime.

`runtime.advanced` is consent to ambient Node, filesystem and network APIs in
the contained utility process. It is not a promise that the fine-grained browser
brokers can sandbox Node built-ins. Ordinary plugins remain broker-only; public
advanced activation additionally depends on phase-9 verified publisher trust.

## RPC and streams

Both runtimes use the phase-1 JSON-RPC contract over one MessagePort. Every
incoming envelope passes the depth/node budget, a schema-owned byte budget, and
the committed JSON Schema before correlation or dispatch. Control messages are
limited to 1 MiB; larger payloads use a stream. Stream frames have their own
24 MiB JSON budget so a maximum 16 MiB base64 chunk remains representable.
Reserved initialize, cancellation, progress and stream messages cannot fall
through as generic methods.

An internal synchronous raw-message guard runs before schema traversal for all
RPC, progress, cancellation and stream messages. It is intentionally policy
free in this phase and gives phase 3 one bounded place to enforce per-runtime
transport quotas without weakening capability middleware. The guard either
returns synchronously or throws to reject the peer; Promise-returning guards are
treated as a host configuration error so untrusted messages cannot build an
unbounded queue of pending quota checks.

The router provides:

- safe integer/string request correlation;
- a bounded pending and in-flight request count;
- request deadlines and `$/cancelRequest` propagation;
- identity-scoped `$/progress` events for later command and Provider registries;
- host-assigned plugin identity on every handler call;
- immediate method-not-supported responses;
- method-specific validation of `plugin.initialize` results;
- one bounded tombstone for a timed-out/cancelled request, allowing exactly one
  late response without confusing it with a reused request ID;
- rejection of genuinely unknown or duplicate response IDs and malformed peers.

Stream frames use stable sequence numbers and byte credit. A sender stops when
credit reaches zero. Received credit is returned only after the consumer
releases the materialized chunk. Pending outbound bytes cannot exceed the
negotiated window, duplicate or out-of-order credit updates fail the peer, and
gaps in a direction's sequence fail just like duplicates. Unhandled streams are
cancelled immediately. Router shutdown invalidates retained release callbacks,
and any transport send failure closes the affected stream. Outgoing failure
rejects all pending writes; failure while returning receive credit removes the
incoming stream before notifying its owner, so peers cannot continue with
different window accounting.

The host-side composition and downstream dependency rules are documented in
[`runtime-extension-boundaries.md`](./runtime-extension-boundaries.md). In
particular, permissions and later Provider registries attach through one RPC
middleware/handler registry, while host calls use the supervisor rather than
reaching into runtime routers.

## Lifecycle and failure containment

The host performs compatibility and feature negotiation before activation,
then uses `plugin.initialize` and `plugin.activate`. Activation has a five-second
deadline. Normal stop requests `plugin.deactivate` with a two-second deadline
and then closes the port and process/window even if plugin cleanup hangs.
Placement and runtime startup share one cancellation signal. Each browser or
utility resource-creation boundary rechecks it, so a stopped activation cannot
resume later and create a hidden window or process.

Unexpected renderer loss, utility-process exit, closed control ports and
protocol violations reject all pending work for only that plugin. Three failures
inside five minutes quarantine the plugin. Quarantine survives restart and is
cleared only by an explicit restart or re-enable action. One plugin's state,
process and pending requests are never shared with another plugin.

Plugin-host construction and recovery remain behind the development gate. A
damaged plugin database or missing host resource closes and disables that
subsystem while leaving the rest of Netcatty running. The management status
waits for initialization and reports the host unavailable after rejection; it
does not expose a permanently rejected manager as usable.

Runtime logs are per-plugin, bounded and rotated. Structured fields whose names
look like credentials, passwords, tokens, secrets or private keys are redacted.
Secret values are encrypted through Electron `safeStorage`; the database and
SDK retain only opaque references. Privileged host consumers receive one-use,
operation/runtime/plugin-bound `SecretLease` objects rather than plaintext RPC
results. See [security-and-permissions.md](security-and-permissions.md).

Application quit is coordinated with plugin shutdown after Netcatty's dirty
editor guard succeeds. Runtimes receive the two-second deactivation deadline;
the coordinator then fails open after a short outer deadline so a broken plugin
cannot make the application impossible to quit. The original `before-quit`
event remains cancelled until that asynchronous deadline finishes. On Windows
and Linux, closing the last tracked Netcatty content window initiates the same
quit path directly; hidden plugin host windows are deliberately excluded from
that count, so they cannot leave a headless application running. Terminal
popups participate in this last-window lifecycle but are not dirty-editor
owners, so they are never sent a query their renderer cannot answer.

## Development management bridge

The renderer management bridge exposes status, list, install, enable/disable,
restart and uninstall operations. The main process checks both the explicit
environment gate and the sender's trusted Netcatty origin for every operation.
With the gate off, the host service is not constructed and installed plugins do
not activate. Phase 4 adds the hidden settings, command, menu, and view UI on top
of this bridge without changing the production gate.

## Packaged-resource invariant

The CLI, contract and SDK are root production dependencies, and their runtime
files plus the browser/utility bootstrap are declared packaged resources. Tests
lock this relationship so a dependency cleanup cannot produce a build that
installs plugins but fails to start them outside the repository checkout.

`npm run test:plugin-runtime` covers the pure main-process boundaries. The
separate `npm run test:plugin-runtime:electron` smoke launches both a real
sandboxed BrowserWindow plugin and a real utilityProcess plugin, verifies
bidirectional storage RPC, and checks the recorded runtime ownership.

Static `appearance.theme-packs` packages are an explicit non-executable admission
form: `main.data = "theme"`, theme-only contributions and no permissions,
activation events or companions. The runtime supervisor never starts them. This
exception does not admit Node code or arbitrary host access in normal Settings.
