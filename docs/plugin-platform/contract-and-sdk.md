# Netcatty plugin contract and SDK

Status: internal preview (`0.1.0-internal.1`; legacy `0.1.0-internal` remains offered)
Tracking issue: [#2269](https://github.com/binaricat/Netcatty/issues/2269)

Phases 2 and 3 consume this contract in the isolated host runtime and secure
capability boundary. See
[isolated-runtime.md](./isolated-runtime.md) for installation transactions,
runtime placement, RPC routing, lifecycle and crash quarantine, and
[security-and-permissions.md](./security-and-permissions.md) for grants,
credentials and host-mediated capabilities.

This document describes the canonical contract first delivered by phase 1 and
extended before public release. Runtime loading and capability enforcement live
in the host rather than the schema package. UI contributions, terminal
Providers, terminal interceptors, and connection/authentication/importer
Providers have now extended the same internal contract before public release.
Synchronization Providers and signed distribution remain later phases.

## Contract ownership

`packages/plugin-contract/schema/plugin-contract.schema.json` is the canonical
public protocol. It uses JSON Schema 2020-12 and defines:

- package manifests and entrypoints;
- permission declarations;
- setting, command, menu, view, and provider contributions;
- JSON-RPC requests, notifications, results, cancellation, and errors;
- runtime initialization, feature negotiation, and progress notifications;
- JSON and binary stream frames with flow-control windows;
- companion-process Content-Length framing;
- permission requests and decisions;
- provider requests and results.

`npm run generate:plugin-contract` derives two committed artifacts from that
file:

1. TypeScript types exported by `@netcatty/plugin-contract`;
2. a self-contained schema bundle under `electron/plugins/generated/` for the
   future host runtime.

`npm run check:plugin-contract` compares both outputs byte-for-byte. CI can
therefore reject a schema edit whose SDK or Electron representation was not
regenerated.

The contract is intentionally marked internal. Compatibility is not promised
until the final rollout PR freezes API 1.0. Review revisions made before this
first contract is merged remain `0.1.0-internal`; after a contract revision is
merged, every breaking change must update the schema identifier, workspace
package versions, and generated artifacts in the same commit.

## Package layout

A plugin is a directory with `netcatty.plugin.json` at its root. The manifest
declares one or both execution entrypoints:

```json
{
  "manifestVersion": 1,
  "id": "com.example.my-plugin",
  "name": "my-plugin",
  "version": "0.1.0",
  "publisher": "example",
  "engines": {
    "netcatty": ">=0.0.0",
    "api": ">=0.1.0-internal <0.2.0"
  },
  "features": {
    "required": ["netcatty.rpc.progress"],
    "optional": ["netcatty.stream.binary"]
  },
  "main": {
    "browser": "dist/browser.js",
    "node": "dist/node.js"
  }
}
```

Manifest bytes must be valid UTF-8. Directory validation and archive validation
share one fatal UTF-8 parser; invalid byte sequences are rejected instead of
being replaced with `U+FFFD` before JSON and semantic validation.

Paths use relative POSIX syntax and are limited to 128 Unicode code points and
512 UTF-8 bytes. The schema and package validator reject absolute paths,
drive-letter paths, repeated separators, backslashes, `.` and `..` segments,
Windows reserved names, control or platform-special characters, and
platform-specific trailing dots or spaces. The semantic package validator also
requires NFC-normalized text and uses conservative Unicode compatibility/case
folding when detecting path aliases. It applies the same syntax and portability
checks after Unicode compatibility normalization, so compatibility characters
cannot introduce separators, traversal segments, drive prefixes, reserved
names, or trailing dots. Every official host consumer must run it after schema
validation because JSON Schema cannot express these filesystem rules.
Every entrypoint, view document, package icon, and companion variant must exist
in the package.

Browser and Node entrypoints express placement. A Node entrypoint additionally
requires the explicit high-risk `runtime.advanced` declaration and grant; the
runtime still evaluates the remaining manifest permissions, trust level, and user grants
before activating either entrypoint.

Each advanced companion has a stable contribution ID and one or more platform
variants. A variant binds one package path and SHA-256 digest to one or more
compatible OS/architecture targets, allowing a universal script to be shared
while macOS, Linux, and Windows native binaries remain distinct. A companion
cannot declare the same target platform twice, and no two companion variants
may claim the same package path. A manifest with companions must also provide a
Node utility entrypoint and declare both `runtime.advanced` and a resource-bound
`companion.execute` permission. The first-party placement resolver selects the
utility entrypoint for companion manifests even when a browser entrypoint is
also present. An ordinary browser placement cannot authorize or launch a
companion.

## Contribution identity

Every setting, command, view, provider, and companion executable has a globally
unique contribution ID. Its exact prefix is the owning plugin ID followed by a
dot:

```text
<pluginId>.<localContributionName>
com.netcatty.hello.sayHello
com.netcatty.hello.settings.greeting
```

The schema requires a namespaced contribution shape. Semantic validation then
checks the dynamic relationship to `manifest.id`; a contribution declared by
`com.netcatty.hello` cannot use `com.other.plugin.sayHello`. Menu command
references and `onCommand:` activation events must resolve to commands declared
by the same manifest. This prevents two independently installed plugins from
claiming the same command, setting, provider, view, or companion identifier.
The same ID also cannot be reused across registry kinds within one plugin, so a
command and a view never compete for one routing key.
Activation uses one canonical top-level registry. The supported events are
`onStartupFinished`, `onCommand:<id>`, `onView:<id>`, and `onProvider:<id>`;
every targeted ID must resolve to a contribution in the same manifest. Provider
entries do not carry a second, potentially conflicting activation field.

Commands own their canonical title, description, icon, and enablement state.
Menus can override the title or icon for a particular placement and declare an
alternate command, visibility, enablement, checked state, ordering, and whether
the resolved keybinding is displayed. Keybindings are separate contributions:
each binding names its command, portable fallback key, optional macOS/Linux/
Windows overrides, Context Key condition, and JSON command arguments. This
avoids treating one command-level shortcut as the only binding and permits the
host to resolve platform conflicts centrally. Menu and keybinding command
references must resolve to commands in the same manifest.

Icons are discriminated references. A `theme` icon names a host-owned icon; a
`package` icon names a required light asset and optional dark asset. Package icon
paths receive the same normalization, traversal, archive-presence, and integrity
checks as code and view entrypoints. Views also declare placement, order,
visibility, icon, and whether their isolated context remains alive while hidden.
All `when`, `enablement`, and `checked` values are opaque host-parsed Context Key
expressions; plugin code never evaluates or injects them into native UI.

## Compatibility and feature negotiation

Both `engines.netcatty` and `engines.api` are node-semver ranges. Schema
validation rejects unsafe range characters, while the semantic validator uses
the complete node-semver grammar. An exact API version is a valid range, but
plugins should normally declare the compatible internal API interval so the
intent is explicit. Prerelease versions are not globally enabled: a range must
name a compatible prerelease baseline explicitly, so `<0.2.0` does not silently
accept `0.2.0-alpha`.

The optional manifest `features` object separates required and optional feature
IDs. Required and optional sets cannot overlap. During runtime initialization,
the host sends the `plugin.initialize` JSON-RPC method using
`RuntimeInitializeRequest` and `RuntimeInitializeParams` with its exact Netcatty
version, API version, and supported features. The plugin answers with
`RuntimeInitializeSuccess` and `RuntimeInitializeResult`, including only the
features enabled for that runtime.
Initialization must fail before activation when either engine range is not
satisfied or a required feature is unavailable. Optional features are enabled
only when both sides support them.

The CLI exposes the same algorithm before installation or packaging:

```bash
netcatty-plugin compatibility ./my-plugin \
  --netcatty 1.4.0 \
  --api 0.1.0-internal \
  --features netcatty.rpc.progress,netcatty.stream.binary
```

`checkPluginCompatibility()` is also exported for the phase-2 package manager
and runtime. It returns the enabled optional features, missing required features,
and deterministic incompatibility reasons rather than a single boolean.

Before applying a version-specific full schema, a host reads
`PluginManifestHeader`. This bootstrap shape deliberately permits unknown fields
and future positive `manifestVersion` values while validating identity, plugin
version, and engine ranges. The host can therefore select a supported schema or
report a precise API/schema incompatibility before the strict full manifest
validator rejects unknown fields. The full `PluginManifest` remains closed with
`additionalProperties: false` so misspelled security declarations never become
silent no-ops.

## RPC, progress, streams, and companion stdio

Control messages follow JSON-RPC 2.0. `RpcFailure.id` is nullable for parse and
invalid-request errors where the request ID cannot be recovered. Long-running
operations use `$/progress` notifications with `begin`, `report`, and `end`
values and stable string or integer progress tokens. A report may use an
absolute percentage or an incremental percentage, never both.
Numeric RPC IDs and progress tokens are restricted to non-negative JavaScript
safe integers. Peers that need a larger opaque identifier use the string form;
this prevents distinct JSON numbers from collapsing onto one correlation key
when Electron or Node parses them.

One JSON-RPC control message is limited to 1 MiB. The generated
`PLUGIN_RPC_MAX_JSON_BYTES` constant exposes that boundary; payloads above it
must use the stream protocol. Stream frames use the separate generated
`PLUGIN_STREAM_MAX_FRAME_JSON_BYTES` limit (24 MiB), which is large enough for
one maximum-size base64 chunk without turning the control plane into an
unbounded data channel.

Stream control envelopes remain schema-valid JSON, but chunk data has three
explicit encodings:

- `json` carries a normal JSON value;
- `base64` carries binary bytes over JSON-only transports such as companion
  stdio;
- `transfer` declares that the `MessagePortStreamEnvelope` carries an
  `ArrayBuffer` in its `transfer` property. The sender passes that same buffer
  in the structured-clone transfer list.

The declared `byteLength` is the UTF-8 JSON or unencoded binary byte count. A
receiver validates JSON serialization, base64 decoding, or transferred buffer
length before accepting credit. The contract exports `createJsonStreamChunk()`,
`createBase64StreamChunk()`, `materializeStreamChunk()`, and
`createMessagePortStreamEnvelope()` so every host path applies the same checks.
`assertStreamChunkData()`, `assertStreamFrame()`, and the envelope helper accept
untyped boundary values. Inline JSON and base64 assertions verify the encoded
bytes against the declared length before a consumer advances sequence or credit
state; transfer chunks defer that comparison until the envelope supplies the
actual `ArrayBuffer`. The frame helpers also reject unknown frame kinds, missing
or additional properties, malformed chunk/error payloads, and stream IDs
outside the Schema-owned 128-character limit. The envelope helper returns a
normalized frame assembled only from validated own data properties rather than
returning the caller's object unchecked.
The open frame is sequence 0 and grants the initial `windowBytes`; data and
terminal frames begin at sequence 1. Sequence numbers increase independently in
each sending direction and cannot exceed `Number.MAX_SAFE_INTEGER`. A producer
must open a replacement stream before exhausting that range. It subtracts every
chunk's declared byte length from its credit and must stop at zero.
The initial receive window is 1 KiB through 16 MiB, and each
`windowUpdate.creditBytes` grant is 1 byte through 16 MiB. The public
MessagePort envelope helper enforces the same Schema-owned ranges before
returning a frame. The generated runtime constants, including the stream ID,
chunk, frame-byte, window, credit, safe-integer, RPC-byte, and error-code limits,
are derived from the same Schema and checked for drift. `windowUpdate.creditBytes` grants an
additional amount rather than replacing the window, so retries and duplicate
control frames cannot be interpreted as an absolute reset. A stdio peer must
never emit the `transfer` encoding because stdio has no structured-clone
transfer list; the framing encoder rejects it.

Public encoders validate runtime values instead of trusting TypeScript casts.
They reject non-finite numbers, `undefined`, sparse arrays, accessors, symbols,
cycles, and non-plain objects before serialization. Serialization reads only
validated own data properties and does not invoke inherited `toJSON()` hooks,
so prototype mutation cannot change the bytes after validation. Base64 must use
canonical RFC 4648 padding bits, and every stream chunk remains bounded to 16
MiB even when a caller bypasses JSON Schema validation. This prevents a browser
plugin and a native companion from computing different bytes for the same
apparent message.

All public JSON validators also enforce a maximum nesting depth of 128 and a
maximum of 100,000 values per message. Manifest validation applies the same
structural budget before invoking the recursive JSON Schema validator. Deep or
pathologically wide payloads are therefore rejected as ordinary validation
failures instead of exhausting the JavaScript call stack or monopolizing the
runtime.

Advanced companion processes exchange UTF-8 JSON using this exact framing:

```text
Content-Length: <decimal UTF-8 byte length>\r\n
Content-Type: application/json; charset=utf-8\r\n
\r\n
<JSON bytes>
```

`Content-Length` is required exactly once. `Content-Type` is optional when
decoding but, when present, must be `application/json` with an optional UTF-8
charset. Header names are case-insensitive and the default header limit is
8 KiB; unknown or duplicate headers,
non-ASCII header bytes, invalid UTF-8, malformed JSON, and frames above 16 MiB
are rejected. Syntactically valid numbers that overflow JavaScript to a
non-finite value are also rejected before a decoded message is returned.
Decoder options may lower but never raise the 16 MiB absolute content limit.
`encodeContentLengthFrame()` and the incremental
`ContentLengthFrameDecoder` implement this contract without shell or line-based
parsing. The decoder uses an amortized queue instead of removing array heads,
and coalesces small inputs into bounded slabs, so adversarial one-byte
fragmentation remains linear without retaining one object per byte. Incoming
Node.js `Buffer` data is copied before `push()` returns and cannot mutate a
partially buffered frame later.
`finish()` detects truncated frames when a process exits.

JSON-RPC standard failures retain their standard integer codes. SDK
`PluginError` values use stable implementation-defined codes in JSON-RPC's
reserved server-error range:

| SDK code | Wire code |
| --- | ---: |
| `cancelled` | -32001 |
| `unknown` | -32002 |
| `invalid_argument` | -32003 |
| `deadline_exceeded` | -32004 |
| `not_found` | -32005 |
| `already_exists` | -32006 |
| `permission_denied` | -32007 |
| `resource_exhausted` | -32008 |
| `failed_precondition` | -32009 |
| `aborted` | -32010 |
| `out_of_range` | -32011 |
| `unsupported` | -32012 |
| `internal` | -32013 |
| `unavailable` | -32014 |
| `data_loss` | -32015 |
| `unauthenticated` | -32016 |

`pluginErrorToRpcError()` performs the mapping and includes the stable SDK code
in `error.data.pluginCode` so clients can preserve meaning without parsing text.
Permission decisions and Provider results are also discriminated unions: an
`allow` decision requires a grant scope, denied/cancelled decisions cannot
smuggle one, successful Provider results require `result`, and failed results
require a stable RPC error.

Reserved RPC methods cannot fall back to the generic request or notification
shape. `plugin.initialize`, `$/progress`, and `$/cancelRequest` must validate
against their dedicated schemas at the aggregate `RpcMessage` boundary. RPC
responses are validated against the method recorded for their pending request;
the generic success envelope alone is not sufficient to validate a
method-specific result.

## TypeScript SDK

`@netcatty/plugin-sdk` exports the generated contract types and a small set of
lifecycle primitives:

- `definePlugin` keeps exact plugin types while checking the activation shape;
- `DisposableStore` gives activation code one cleanup owner;
- `CancellationTokenSource` provides cooperative cancellation without exposing
  host abort controllers;
- `PluginError` carries a stable machine-readable error code and JSON details;
- `PluginContext` exposes the exact Netcatty/API versions, negotiated feature
  set, storage, opaque secret references, credential leases, mediated network
  and filesystem access, companion handles, contribution settings, command
  registration/execution, Context Keys, view messaging/state, locale/theme/
  application theme tokens/accessibility environment, logging, and
  subscriptions.

The terminal Provider registry, bounded result shapes, lifecycle snapshots,
host adapters, and the explicit PR-6 raw-interceptor boundary are documented in
[`terminal-providers.md`](./terminal-providers.md).

Phase-4 contribution methods stay on the same validated control plane. The
runtime registers command handlers only after activation; the host routes
`plugin.command.execute` back to the owning runtime. Setting reads and writes
are scoped by the declaration, view state is namespaced by plugin/view/window,
and environment changes arrive as notifications. Custom-view preload APIs are
separate from `PluginContext` and cannot acquire the runtime's capability
objects.

Phase-5 Provider handlers are activation-owned SDK registrations. The host
performs immutable enumeration without activation, authorizes the exact
Provider permission set at first use, invokes through `RuntimeSupervisor`, and
validates the canonical Provider result plus the terminal operation's bounded
result shape before application use. Phase 6 reuses the same declarations and
registration ownership but moves raw terminal bytes onto a dedicated
worker-to-utility MessagePort; they never traverse the JSON-RPC control plane.
The ready, chunk, successful-result, and failed-result frame metadata is owned
by `TerminalInterceptorFrame` in the canonical Schema. Both peers validate the
generated Schema shape and the shared transfer envelope verifies that only
chunk and successful-result frames carry a real attached `ArrayBuffer` whose
length exactly matches the declared bounded `byteLength`.

The PR 7 implementation adds connection, authentication, and importer Providers without changing
the Provider ownership model. Connection Provider result types are operation
specific. The SDK registers connection Providers as an operation-keyed handler
map so TypeScript binds each invocation to its exact result: `validateConfiguration`,
`probe`, `open`, and `getStatus` each return their named result object, while
`resize`, `signal`, `reconnect`, and `close` acknowledge completion with JSON
`null`. Objects on those control operations are rejected by the generated
schema, SDK type map, runtime dispatch shape, and runtime validator.
`ConnectionStatusResult` may carry bounded `ProviderValidationIssue`
diagnostics; when a later status poll reports `closed` or `error`, those
diagnostics are forwarded with the terminal-session exit event rather than
being available only during the initial `open`.
The application validates configuration and runs `probe` before opening a
session, routes an explicit terminal interrupt through `signal`, and gives a
retryable runtime failure one host-owned `reconnect` attempt before closing the
session. Resize, close, status polling, and reconnect remain bound to the same
host-owned session identity.

Importer draft records are also exact public shapes, not arbitrary JSON bags.
Host, identity, key, snippet, and group drafts each declare required fields,
allowed enums, byte/array limits, and closed object properties. Host drafts may
either name a built-in host with a hostname or a plugin protocol plus an opaque
`pluginConnection` object whose provider ID must match the `plugin:<id>`
protocol during host-owned semantic normalization. Executable startup commands,
hidden built-in plaintext credentials, and unknown host properties are not part
of the importer contract; plugin-owned credentials must flow through identity
or key drafts and then through the existing host-owned encrypted persistence
path. Safe preview output is redacted and bounded before UI display.
Importer Providers use their own operation-keyed handler map, so `detect` must
return a detection result and `parse` must return completion counters. Streamed
records use the public `ImporterLimits` byte and count bounds. A plugin
connection draft may reference an identity or key draft from the same import by
its source ID; Netcatty maps that reference to the new host-owned credential ID
before encrypted persistence and rejects unresolved or ambiguous references.

PR 8 adds sync Providers as another operation-keyed map under permission
`provider.sync`. Plugins implement only encrypted object storage: `connect`,
`disconnect`, `getAccount`, `getCapabilities`, `readObject`, `writeObject`, and
`deleteObject`. Capability reporting covers revisions, conditional writes,
atomic replacement, and size limits (`SyncLimits`). Large objects leave the
JSON control plane on the existing stream seam; plugins never receive the cloud
master key or plaintext vault. Netcatty continues to own encryption, CRDT merge,
migrations, protection snapshots, conflict handling, and read-merge-write-verify.
WebDAV is adapted through the shared encrypted-object storage interface so the
same path can exercise configuration, secret handles, upload/download,
verification, and recovery.

`PluginSecretStore.get()` never returns plaintext. It returns a host-issued
`SecretRef`. Its random ID stays opaque; its non-secret `key` binds later lease
authorization to the same manifest resource used by `get()`/`set()`. `set()`
immediately transfers a value already known to the plugin into host storage
before returning the same kind of reference. Network,
authentication, and companion brokers can consume a one-use lease for the
reference while the main process revalidates plugin ownership and operation
scope. PR 7 also supplies a host-issued `CredentialRef` for Netcatty-owned
Vault credentials through the same SDK method; its injected resolver does not
materialize plaintext until lease consumption. Neither reference kind is a
bearer capability, and neither may bypass permission, ownership, runtime, and
operation checks.
Host-rendered password settings likewise expose only references to plugin code.

The isolated host and phase-3 capability brokers provide these implementations.
No renderer decision provider means requests fail closed; a manifest declaration
never grants authority by itself.

`PluginFilesystemClient.writeFile()` currently requires `{ overwrite: true }`
and an existing regular file. This preserves one stable SDK method while the
cross-platform host denies unsafe arbitrary-path creation until it can bind a
new child to an opened parent directory without a path race.
`readDirectory()` likewise keeps its stable SDK/RPC method but fails closed
unless the main process supplies a native adapter whose inode checks and entry
enumeration are bound to the same directory handle.
The host advertises `filesystem.directory-enumeration` only when it supplies that
adapter. Declare the feature as required, or optional and check
`context.enabledFeatures.has(PLUGIN_FILESYSTEM_DIRECTORY_ENUMERATION_FEATURE)`.
The default host supplies no adapter and does not enable this feature. Both the
SDK and direct RPC return `unsupported` before a permission request or path probe.
An enabled feature still requires the declared `filesystem.read` directory
resource and the normal permission, root, symlink and same-handle checks.

Permission names already use the phase-3 enforcement boundaries: clipboard
read/write, terminal metadata/output/input and input/output interception, Vault
metadata/write/credentials, SFTP read/write, filesystem read/write, network
origins, companion execution, and each Provider registration class are separate
grants. A broad permission such as `terminal.read` or `filesystem` is not part
of the contract. Setting controls likewise include the complete planned native
set, including radio, slider, font, file/directory, sortable list, and structured
table controls. Secret settings cannot opt into sync; list and table controls
must declare a host-validated `valueSchema`. The accepted schema subset has
bounded depth/nodes, explicit types and closed object properties; executable or
backtracking features such as `$ref`, `pattern`, formats and conditionals are
rejected. Defaults are checked against the control's value type, declared
options, numeric range, step, and structured schema; duplicate option values
and unsafe text patterns fail package validation. File and
directory paths are device-local values and cannot opt into cloud sync.
Semantic validation also requires every contribution class to declare its
capability: commands, menus, views,
settings, companion executables, and each Provider kind cannot appear without
the matching required or optional permission. Companion-specific permission
lists reuse the same canonical permission catalog and must be a subset of the
manifest declarations. Provider capability IDs use the same lowercase,
namespaced feature-ID grammar as runtime negotiation.
Provider `configurationSchema` values are declarative JSON data interpreted by
the host's restricted schema validator; providers never receive a way to inject
configuration UI code into Netcatty.

Terminal Provider declarations are also tied to their least-privilege data
capabilities. Completion requires `terminal.complete`; text-derived visual
providers require terminal output plus decoration access; backgrounds require
decoration access only. Raw interception is represented by two distinct kinds,
`terminal.interceptor.input` and `terminal.interceptor.output`, and each requires
its matching high-risk permission. One generic interceptor kind cannot be used
to acquire both directions implicitly.

Plugin entrypoints should return or register every acquired resource:

```ts
import { definePlugin } from "@netcatty/plugin-sdk";

export default definePlugin({
  activate(context) {
    context.subscriptions.add(registerSomething());
  },
});
```

Activation code must treat cancellation and deadlines as normal outcomes.
Host-side cancellation can stop waiting for a plugin but cannot forcibly unwind
arbitrary JavaScript without terminating the isolated runtime.

## CLI

`@netcatty/plugin-cli` supplies five commands:

- `init` creates a minimal TypeScript plugin;
- `validate` checks a source directory or packaged archive;
- `compatibility` checks Netcatty/API ranges and negotiates required and
  optional features;
- `build` validates the manifest and runs the plugin's npm build script without
  a shell;
- `pack` emits a deterministic `.ncpkg` archive.

The packer sorts UTF-8 package paths, stores fixed ZIP timestamps and file
modes, and writes entries without platform-dependent compression output. The
same files and manifest therefore produce the same archive bytes.
The validated source-manifest byte length and SHA-256 are bound to the scanned
manifest entry before writing; the archive writer then rechecks every scanned
file while streaming it. A manifest changed after validation cannot be packaged
under the previously validated object model. Source hashing enforces its byte
budget during the read, and archive writing stops before emitting bytes beyond
the scanned size, so a concurrently growing file cannot cause unbounded I/O.
Build, archive-validation, extraction, and directory-validation results also
carry the same versioned `contentSha256`. It hashes sorted logical entries
(path, byte length, declared-companion classification, and file SHA-256), so the host
can compare an extracted tree with a valid archive without assuming that all
publishers used the same ZIP encoder or compression method.

Package validation rejects:

- path traversal, absolute paths, backslashes, and case-colliding names;
- non-UTF-8 names and local/central ZIP header disagreements;
- symbolic links and non-regular files;
- executable files not declared as companion executables;
- companion binaries whose SHA-256 does not match the manifest;
- duplicate entries, encrypted entries, and unsupported compression methods;
- missing entrypoints, views, package icons, and companion variants;
- a source manifest whose packaged bytes differ from the validated snapshot;
- excessive path, file, archive, or expanded-package sizes.

These checks are repeated when reading `.ncpkg` files. Installation in phase 2
must not trust a package merely because the publisher previously ran the CLI.

## Compatibility rules for later phases

The following rules are fixed for this internal pre-release contract:

1. JSON Schema is the wire authority. TypeScript types alone never justify
   accepting an unvalidated message.
2. Unknown manifest properties are rejected within API 0.1. This prevents a
   misspelled security declaration from silently becoming ineffective.
3. Runtime control envelopes are JSON values. Binary stream data crosses a
   MessagePort only through the declared `ArrayBuffer` envelope property and
   the matching structured-clone transfer list; native objects,
   functions, Electron handles, DOM nodes, and cyclic values remain forbidden.
4. Permission declarations do not grant access. They only make a future user
   grant possible.
5. Required and optional permission sets cannot overlap.
6. Secret settings cannot contain defaults in the manifest.
7. Companion executables are content-addressed and explicitly declared.
8. Cancellation identifiers and deadlines are part of the RPC contract so a
   slow plugin cannot retain an unbounded host request.
9. Stream sequence numbers and receive windows are part of the public protocol;
   producers must stop when the receiver's advertised capacity is exhausted.
10. Manifest schema validation is followed by semantic package validation.
    This enforces NFC paths and content-dependent rules that JSON Schema cannot
    represent by itself.
11. Secret reads return opaque `SecretRef` values. Plaintext is never a normal
    SDK storage result, and possession of a reference never replaces identity,
    permission, ownership, or operation checks at the privileged boundary.
12. Contribution IDs use the exact owning plugin ID as their namespace.
13. Engine ranges and required features are checked before activation.
14. Companion stdio uses bounded Content-Length-framed UTF-8 JSON; newline JSON
    and unbounded reads are not compatible transports.

## Phase-consumer audit and evolution rules

The cross-phase contract was checked against every planned consumer:

| Phase | Contract used without importing application internals |
| --- | --- |
| PR 2 runtime | manifest header/full validation, `plugin.initialize`, JSON-RPC, progress, cancellation, framing, streams |
| PR 3 security | principal-bound grants, canonical resources, permission requests/decisions, `SecretRef`/`CredentialRef`/`SecretLeaseRef`, mediated SDK capabilities, stable failures and cancellation |
| PR 4 contributions | namespaced settings, commands, menus, views and strict semantic references |
| PR 5 terminal providers | namespaced provider IDs, provider request/result envelopes and bounded streams |
| PR 6 data pipeline | direct MessagePort transfer envelopes, sequence, per-chunk credit, and bounded receive-window fields |
| PR 7 connection/auth/import | provider kinds and configuration schemas, platform-specific companion variants, framing, stable failures and progress |
| PR 8 sync | implemented: namespaced `sync` Providers, `SyncLimits`, operation-keyed connect/read/write/delete/capabilities, inline or streamed encrypted objects |
| PR 9 rollout | schema/API selection, compatibility reporting and the final API 1.0 freeze |

The contract tests construct representative manifests for the contribution UI,
ordinary terminal Provider, privileged input/output interceptor, and combined
connection/authentication/sync/importer phases. These fixtures are validated by
the same strict schema and semantic validator used by the CLI, so a later edit
cannot silently make a planned phase inexpressible.

Core meanings are never changed in place after merge: contribution ownership,
RPC method names, error-code mappings, framing, stream encodings, and feature
negotiation require a new contract revision for incompatible changes. New
setting controls, permission names, provider capabilities, or optional fields
may be added only with an API/schema revision; a plugin that uses them declares
the matching API range and required feature. This keeps strict validation while
giving old hosts a deterministic fail-closed path through the manifest header.

## Repository commands

```bash
npm run generate:plugin-contract
npm run check:plugin-contract
npm run test:plugin-contract
npm run build:plugin-packages
```

The complete application checks remain mandatory because workspace and root
dependency changes affect installation and release builds.


## Plugin brand icons (internal revision 0.1.0-internal.1)

Optional top-level `icon` reuses `IconReference` from contributions. A package
using it must require `metadata.brand-icon` and an API range accepting
`0.1.0-internal.1` but excluding `0.1.0-internal`. See
[the author guide](plugin-icons.md) for bounds and packaging commands.

The host still offers the previous wire revision to plugins with no top-level
icon whose range matches only that revision. Compatibility selection returns the
negotiated API version and runtime initialization uses and verifies that exact
version. Host version bounds remain independently enforced; unknown required
features still fail closed. No old manifest is rewritten and no permission grant
is migrated by this revision.

## Declarative host color contributions

`appearance.theme-packs` adds `contributes.themes` and generated palette/reference
schemas. A pure package uses `main: { "data": "theme" }`, contributes only themes
and omits permissions/activation/companions. It has no executable runtime. Normal
admission accepts this data-only form alongside browser-only code packages; Node
and arbitrary IPC remain advanced/unsupported public boundaries. Selection is a
trusted host Appearance action, not an SDK setter or `appearance.write` grant.
See [Theme packs](./theme-packs.md) for limits, preview, persistence and fallback.
