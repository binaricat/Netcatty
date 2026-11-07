# Plugin security and permission boundary

Status: unreleased plugin platform; browser plugins remain sandboxed. Advanced
utility packages remain restricted to developer mode.

Declared capabilities that the platform exposes default to **Allow**. Installing
or enabling a plugin does not open a permission checklist. In Settings, each
plugin has host-owned **Allow / Ask / Deny** controls with its declared resource
scope. Allow skips permission dialogs; Ask requests one scoped decision; Deny
rejects before side effects or content release. Target selection, model selection,
and editing/saving drafts remain normal host workflows. SSH authentication and
host-key checks are unchanged.

## Policy storage, updates and source changes

Policies live in `plugin_host_preferences`, separate from plugin-writable
settings, under `permission:<host source owner>:<capability>`. Missing entries mean
Allow. No historical plugin-policy migration or unrelated user-data reset runs.
Policies survive restart, disable/re-enable, uninstall/reinstall from the same
source, and package/version/publisher/declaration changes within that source.
An explicit Deny therefore survives an update, including removal and later
reintroduction of that capability. New declared capabilities default to Allow;
existing Ask/Deny modes apply to the current declared scope. Undeclared
permissions, unsupported methods and out-of-scope resources still fail closed.

Changing a source requires the existing explicit uninstall/private-data reset.
That reset removes only the old source's plugin policies and private records.
A different source receives independent defaults. Policies never come from a
manifest, plugin setting, RPC payload or imported grant. Existing grant hashes
still include the immutable package principal and declaration boundaries; this
change does not turn an old package grant into a cross-version grant.

Every policy edit clears saved grants, cancels pending decisions and active RPCs,
and invalidates host resource handles and model/stream state. Guards bind the
source and policy revision before asynchronous authorization resolution, recheck
before commits and content delivery, and remain invalid after a Deny-to-Allow
flip. A late prompt reply cannot revive old work. The user must start a fresh
operation after changing policy.

Ask uses Netcatty's existing in-app Dialog, typography and theme. Its recipient
must be a ready, focused, visible, unlocked top-level app renderer in the managed
window registry, including the standalone Settings window. Arbitrary windows,
plugin view contents and subframes cannot register or respond. Each single-use
token and cancellation lifecycle remains bound to the receiving window; another
renderer's readiness changes cannot cancel or inherit that request. No main-window
focus handoff is needed. Close, cancel, timeout, lock, hide/blur, reload, crash
and stale runtime/source fail closed. The dialog uses the existing host security
surface marker so attached native plugin views yield while it is visible and
restore through their existing lifecycle on dismissal.
Ordinary landing rows do not suspend native views. The logging dialog and its
verbose confirmation are marked security surfaces; the confirmation opts into
the existing marker because it temporarily accessibility-hides its parent dialog.
A plugin DOM click never becomes a host gesture. Choosers, drafts, terminal and
clipboard sharing use their existing host-owned action tokens. Ask integrates
with that workflow instead of opening a second capability dialog. Allow skips
sharing and connection permission confirmations while retaining validation and
operation/resource binding. AI start combines model access and exact selected
context handles into one Ask decision; its receipt is limited to that operation.
Stream reads, stop and close validate broker handles without prompting per chunk. The receipt uses a host-created RPC operation identity retained by derived
model contexts, with source/runtime/principal/revision binding. It is never a
plugin-provided field. The selected-summary chooser owns its Ask interaction;
there is no preceding generic capability prompt. Ask displays checked host
model/selection labels rather than opaque selected handles.
Selected-context reads remain selected-only and never enumerate the whole Vault.

## Authority model

Every privileged plugin-to-host method is registered in
`PluginHostRpcRegistry` with one explicit authorization descriptor. Parameters
are validated first; the descriptor is then built without probing protected
host state, and quota and permission middleware run immediately before the
handler. Filesystem and credential existence checks happen only after that
permission boundary. An unclassified method is denied. The only current public
method is bounded, redacted logging.

The host supplies immutable plugin ID, version, runtime ID, placement, manifest,
package root, cancellation signal, active-runtime guard, and security principal.
Plugin payload fields can never replace that identity. The default pre-signature
principal is a hash of plugin ID, declared publisher, and immutable package
SHA-256, so changed unsigned code cannot inherit persistent grants. The
placement seam also accepts a `resolveSecurityPrincipal` function so phase 9 can
substitute a verified publisher-key fingerprint without changing the permission
engine.

The grant key includes:

- plugin ID and permission;
- canonical resource;
- required-versus-optional declaration semantics and declared resource bounds;
- the host-resolved security principal.

Changing any declaration boundary or principal invalidates reuse. A renderer
decision cannot grant a resource broader than the manifest declaration.
Permission prompts use the canonical contract directly: absent operation and
session IDs are omitted, long host-generated operation IDs become stable
SHA-256 identifiers, reasons are bounded, and no request can carry more than
128 canonical resources.
Runtime trust/placement resolves before advanced-runtime authorization. Required
preflight validates declarations without asking for capability grants. The
`runtime.advanced` policy is checked only if the host selects the developer-only
utility runtime.

## Grant lifetimes

- `once` applies only to the request waiting on that decision and is not stored.
- `session` is held in memory and requires a host-owned session ID; ending the
  session removes it.
- `application` is held in memory until explicit revoke or shutdown.
- `always` is persisted in `plugin_permission_grants`.

All lifetimes use the same resource-coverage function. Every resource carries
an explicit `exact` or `directory` kind. Only a filesystem `directory` grant
covers descendants with path-boundary comparison; a file remains exact even if
the path is later replaced by a directory. Origins and companions are exact;
`*` is valid only when the manifest declaration also allows it. Concurrent
identical prompts coalesce. Prompt timeout, runtime abort,
cancel, denial, absence of a decision provider, and stale activation all fail
closed. Grant/use/deny/revoke events enter the bounded security audit.

`PermissionRequest` remains part of the canonical schema. It carries host-bound
identity, capability, canonical resource scope and optional related capabilities
for one combined operation. The trusted host UI renders text, never plugin HTML
or body payloads. A response must match its request and action token. Ordinary
Ask decisions apply once; long-lived stream attachment may use a host session.
The older grant lifetimes remain supported by the engine, not exposed as a
mandatory install flow.

Changing `runtime.advanced` to Ask or Deny disables and stops the privileged
development activation through the existing manager queue. Policy IPC awaits
that teardown. Queued lifecycle updates check the original source owner, so a
replacement source cannot be stopped by a stale edit. Ordinary browser sandboxes
are unchanged.

## Host-mediated capabilities

These brokers are the only authority path for ordinary browser plugins. An
advanced utility entrypoint is intentionally different: `runtime.advanced`
exposes ambient Node, filesystem and network APIs in its
contained process. Fine-grained broker grants do not sandbox that ambient Node
authority. Phase 9 must also require a verified publisher principal before the
advanced path can be publicly enabled.

Required resource-scoped permissions (`network`, filesystem read/write, and
companion execution) must declare non-empty activation-time resource bounds;
the all-resources `*` wildcard is not a valid bound.
The string shorthand remains available only for optional declarations, whose
concrete resource is checked against its policy and scope on use.

Native companions are an advanced-runtime capability. Their manifests require
a Node utility entrypoint plus `runtime.advanced`, and `companion.start` rejects
browser runtime identities before permission middleware can persist a grant.
The first-party placement path selects the utility runtime whenever companions
are declared, including manifests that also provide a browser entrypoint.
The supervisor repeats the placement check immediately before reserving or
spawning a process. Phase 9 adds verified publisher trust to this same boundary.
Privileged Terminal interceptors use the same deterministic utility placement
rule and additionally require their direction-specific interception grant.

### Network

The ordinary browser SDK has no direct network primitive. `network.request` supports
HTTP(S) only, exact origin authorization, bounded headers, a 128 KiB request and
response body, explicit timeout, no URL credentials, no ambient cookies, no
transport headers, and manual redirects. Every redirect origin is authorized.
The SDK forwards the validated request timeout as the host RPC deadline, so the
router cancels stalled broker work at the same boundary.
Cross-origin redirects strip sensitive headers; 301/302/303 transitions do not
replay POST bodies as GET requests.

### Filesystem

Read, write, stat and directory listing require an absolute path. Authorization
first uses only the lexically resolved requested path, including removal of
redundant trailing separators, so an ungranted request cannot probe path
existence, type, symlink targets or real paths. After permission,
the handler resolves the real path and requires it to equal the authorized
resource; callers must therefore supply an already canonical path and symlink
aliases fail closed. File opens use `O_NOFOLLOW` where supported and bind the
opened handle to both the pre-open authorized inode and the current path inode.
Directory listing requires a host adapter that can bind both inode checks and
enumeration to the same native directory handle. Portable Node does not expose
that primitive, so the default implementation fails closed while preserving
the SDK/RPC seam for a native adapter. Reads use the actual handle bytes rather
than trusting a pre-read size, with a 128 KiB cap. Larger payloads use streams.
Arbitrary-path writes currently require an existing regular file and explicit
overwrite; no `O_CREAT` path exists because Node cannot portably bind creation
to an opened parent-directory handle across macOS, Linux, and Windows. A later
native implementation can add secure relative creation behind the same SDK
method. Writes recheck runtime activity immediately before mutation, and
listing is limited to 1,000 entries.

### Secrets and credentials

Secret values are encrypted with Electron `safeStorage`; unavailable OS
encryption or Linux's insecure `basic_text` fallback denies the operation.
SQLite stores ciphertext plus a `SecretRef` containing an opaque random ID and
the non-secret originating key, never plaintext. The key lets lease permission
checks use the same manifest resource as `secrets.get`/`set`; post-permission
lookup revalidates that the random ID still belongs to that key and plugin.
Secret tables and grants are user-owned security
data and do not cascade when a package version is removed.

Plugins can ask `PluginCredentialBroker` for a `SecretLeaseRef`. A lease is
single-consumption, opaque, maximum 60 seconds, and bound to plugin, active
runtime, operation ID, abort signal and secret ownership. Only a host capability
broker can redeem it. A plugin-owned `SecretRef`, a Netcatty-owned opaque
`CredentialRef`, or a lease ID alone is not authority. Netcatty credential
references use an injected main-process resolver. Authorization treats both
secret and credential IDs as opaque identifiers and does not reveal whether
they exist; secret keys are already plugin-declared resources. Ownership,
ID-to-key binding, and existence are checked only after permission,
immediately before lease issue. Plaintext resolves only when the one-use lease
is consumed. This is the stable credential handoff used by
connection/authentication Providers in PR 7. Importer Providers cannot smuggle
hidden built-in plaintext credentials through host drafts; credentials must be
declared as identity/key drafts and then pass through the same host-owned
encrypted persistence and credential-reference flow.

### Companion executables

Only the manifest variant matching the current OS/architecture can start. Its
real path must remain inside the package, be a regular file, and match the
declared SHA-256 immediately before spawn. The host uses an absolute executable,
empty argument vector, private plugin data directory, minimal environment,
`shell:false`, bounded Content-Length JSON-RPC, at most four processes per
runtime and 64 pending calls per process. Companion-to-host methods receive
method-not-found; privileged work remains in the main host brokers.
Timed-out companion RPC identifiers are retired until one late response is
discarded, and the runtime SDK retries a failed stop rather than marking the
handle locally stopped before the host confirms cleanup.
The validated companion request timeout is also forwarded as its host RPC
deadline.

On POSIX, companions start in a dedicated process group; shutdown signals the
whole group, escalates the whole group to `SIGKILL`, and waits until it no longer
exists. Windows uses shell-free `taskkill /T` for both graceful and forced tree
cleanup. A direct parent exit also starts tree cleanup before the handle or
quota monitor is released. An unreaped companion tree is a containment failure
and disables its plugin. Runtime stop events revoke leases and release all owned
companion handles. Disable, restart, upgrade and uninstall wait for that tree
cleanup before returning or mutating package code; a cleanup failure is
persisted as a containment failure and blocks replacement activation.

## Quotas and failure behavior

The raw-message token bucket runs before schema traversal. Capability
concurrency/rate, logging rate, per-category byte windows, companion count and
pending RPC limits bound retained work. Electron process metrics enforce memory
and sustained-CPU policy for browser/utility runtimes and companion processes.
The runtime monitor is attached and takes its first sample immediately when the
BrowserWindow renderer or utility process is created, before initialize or
activation runs. A process policy violation disables and stops only its owning
plugin.

Network, filesystem, secret, credential and companion handlers recheck the
active runtime immediately before commits or returned results. Cancellation,
disable, update, uninstall, quarantine and shutdown therefore cannot resume a
stale privileged operation.

## Initial database policy

The plugin platform has never shipped. The complete current database remains
schema version 1 and includes package/runtime tables plus grants, secrets and
security audit. There is no migration chain. A developer using an older preview
must reset `userData/plugins/plugins.sqlite`; released migrations begin only
after durable user data can exist.

## Downstream contracts

- PR 4 consumes `PermissionRequest`, structured grant lists/revocation, runtime
  events and the existing RPC registry for settings/commands/views. Secret
  settings retain their declared key in `SecretRef` without exposing plaintext.
- PRs 5-6 reuse immutable caller identity, permission middleware, cancellation,
  quotas and runtime-stop cleanup; the direct terminal fast path remains a
  separate MessagePort and must still enforce sensitive-input bypass. Their
  larger payloads use streams rather than the 128 KiB control-plane budget.
- PR 7 consumes operation-bound secret leases and digest-verified companions;
  secret lease authorization uses the declared key while ID ownership remains
  a post-permission lookup. Importers use bounded streams, not directory walks,
  and their draft schemas reject executable startup commands and hidden
  plaintext built-in credential fields before Vault persistence.
- PR 8 stores encrypted sync sidecars in `plugin_sync_sidecars` (no package
  cascade) for non-secret `sync: true` settings plus account/CRDT baselines, and
  transports larger encrypted objects over the existing stream seam. Secret
  settings never enter cloud sidecars.
- PR 9 supplies signed publisher principals and trust policy through placement;
  signed identity changes force a fresh grant instead of widening an unsigned
  grant silently.

## Inspect and revoke actual grants

The installed package detail shows declared capabilities, resources and effective
Allow / Ask / Deny modes alongside any saved grants. The host-only panel lists resource, scope, session (when applicable),
and grant time. Each row indicates whether its declaration hash and security
principal match the host-owned current activation. Saved grants from an older
package or a stopped/disabled activation remain visible as inactive. One-use decisions do not appear as retained grants. Refresh
reads the engine again. Recent security events include at most 100 entries and
project only event, time, permission, and scope. Arbitrary database details,
operation IDs, terminal content, and credential material never cross this UI
boundary.

**Disable and revoke all grants** runs through the manager mutation queue. It
persists disabled state before revoking grants, invalidates contributions, and
waits for runtime shutdown. Existing runtime teardown cancels RPC, streams,
leases, providers, and companions. Every cleanup stage is attempted if grant deletion, audit persistence, or
contribution invalidation fails. Multiple errors are aggregated and reported;
the UI never claims successful revocation when persistence or cleanup failed. Explicit enable retains the saved policy; Deny remains in force.
This management bridge is available only to the trusted app renderer. It is
not a plugin RPC method and grants no plugin authority over another package.

`PluginNetworkRequest` and `PluginNetworkResponse` now derive from the canonical
schema. `credentialLease` and `authorization` describe the existing host lease
injection path. Hosts advertise `network.credential-lease` for discovery without
changing existing API versions or disabling legacy requests. Plugins may
require that feature or handle its absence. Optional authorization defaults to
Bearer. Basic authorization accepts a bounded username. Plaintext is redeemed
only inside the host after origin permission and operation binding checks.
See the [synthetic fixture](../../examples/plugins/lease-http/README.md).
