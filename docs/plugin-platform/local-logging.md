# Local plugin logging

Local file persistence defaults to off. The existing permission panel keeps its
bounded security history independently. Changing or clearing local log files does
not clear that history, grant permissions, or change a plugin's source.

## Saved records

`PluginLogService` extends the existing `PluginLogger`. It owns one shared sink at
`<userData>/plugins/logs/host-v1`, outside plugin storage. Files contain JSON Lines.
They stay on the device. No cloud upload or sync path includes these files or the
local preference at `<userData>/plugins/local-logging.json`.

Host audit records contain these facts:

- Host-assigned plugin ID, installed version, archive SHA-256, runtime ID and kind.
- Source ID, source kind, and namespace from an injected host provenance resolver.
  Missing provenance is `null`. Manifest claims never imply an official source.
- Registered host RPC operation, authorization outcome, result, numeric error code,
  elapsed milliseconds, and available input/output `data` field byte counts.
- Target identifiers from host authorization descriptors, replaced with a keyed
  SHA-256 digest. The random key stays in memory, so target correlation lasts only
  for the current app process.
- Cumulative dropped-record and write-error counts at enqueue time.

Runtime start, running, stop, failure, protocol rejection, and permission revocation
produce separate host facts. Required and advanced activation permission failures
produce a fixed `runtime.authorization` event even before a runtime ID exists. The registry records known RPC attempts even when
validation or authorization fails. Authorization has separate `allowed`, `denied`,
`not-required`, and `not-reached` states. A handler error after approval preserves
`allowed` and records the failed result. Unknown values remain explicit.

The byte counts measure UTF-8 bytes in a string `data` field, or byte length for a
binary `data` field. They are not total wire traffic or decoded base64 size.
Missing measurements are `null`. Streaming traffic outside these calls does not
become a complete per-byte trace. Host facts describe what the host observed;
plugin-returned success cannot prove an external side effect occurred.

Host audit records never copy request bodies, response bodies, error messages,
credentials, API keys, passwords, prompts, Notes, SQL, query results, or terminal
content. Error codes come from the host RPC error set. No audit field accepts
plugin-supplied source identity.

## Optional plugin text

Verbose diagnostics require a separate confirmation and turn off after app
restart. Console messages, utility stdout/stderr, and `logger.write` text use
`recordType: plugin-diagnostic` and `trust: plugin-authored-unverified`. The host
adds identity outside the nested `diagnostic` object. Plugin fields named
`pluginId`, `sourceId`, or `recordType` cannot replace reserved metadata.

Text and structured fields have traversal, length, depth and total-record limits.
Control characters are removed and known sensitive field names are replaced.
These bounds do **not** make arbitrary plugin text safe. A plugin can put a secret
under an unexpected key or inside a sentence. Review files before sharing them.
No plugin text is persisted when verbose diagnostics are off.

## Limits and lifecycle

The shared sink retains at most three files of 1 MiB each, for at most seven days.
Expiry uses the first host timestamp in each segment, read within the existing
16 KiB record bound. Appending cannot extend a segment's lifetime. Export uses
the same cutoff. A segment is removed when its first record expires; capacity
rotation or segment expiry can remove later records sooner. Retention runs on
startup, writes and hourly while the app runs, including after saving is disabled. The app cannot delete expired files while it is closed.
The asynchronous queue accepts at most 256 KiB and records drops when full.
Plugin text can occupy only a quarter of that queue, leaving capacity for host
facts. Diagnostics also reuse the existing per-runtime log token bucket (240
records per minute, with a 240-record initial burst), including console output. Each
record is limited to 16 KiB. Oversized records are dropped. Write failures increase
both drop and error counts and never fail the plugin operation.

Turning saving off stops ingress, discards queued records that have not started,
and waits for any current write. Runtime cleanup closes its diagnostic logger.
App shutdown drains accepted writes through the existing manager shutdown path,
including when another cleanup stage rejects. A failed settings write refreshes
the checkbox from actual host state while retaining the original error.
Clearing pauses ingress, discards queued records, waits for a current write and
removes only the sink's known files. Cancellation leaves them intact. Export takes
a bounded snapshot on the write queue and uses the native Save dialog.

Files use mode 0600 and the directory uses 0700 on systems that support them.
The host filesystem broker rejects writes to the audit directory and preferences,
including canonical paths reached through symlinks. Plugin views cannot invoke
log management IPC. No plugin API exposes audit mutation. These local files are
not a tamper-evident ledger against the OS account or the development-only utility
runtime, which already has full Node and filesystem authority.

## Integration boundaries

`PluginLogSettings` presents a compact settings row on `PluginSettingsLanding`.
Its standard host dialog contains the save and verbose switches plus local file
actions. The landing page also shows installed-plugin quick controls using the
existing host manager. The Installed, Official and Third-party manager pages keep
their existing layout; declared settings links open the relevant installed detail.
The logging backend and source database are unchanged by this UI restructuring.

`createPluginHostService` now injects the host-owned
`createPluginLogProvenanceResolver(database)` by default. It consumes the source
API confirmed on #3981 at `59721f97172acffffe960a6268a2916a90a6c554`:

- `getActivePlugin(pluginId)` supplies the installed version, hash and source.
- `getRetainedPluginSource(pluginId)` must agree with the installed source.
- `privateOwner(pluginId)` supplies the opaque namespace.
- `publicPluginId(owner)` must round-trip to the host-assigned public ID.

The adapter receives host activation identity only, after the existing caller
guards. It never accepts source or owner fields from plugin request parameters.
Missing APIs, an absent installation, changed version/hash, a retained-source
mismatch or an orphaned owner leave provenance explicitly unknown. There is no
bare-plugin-ID fallback. The current host API encodes every owner, including
local imports; a bare ID returned as an owner remains unknown.

Each logger snapshots the source binding and supplies a host-only `isCurrent`
check. The sink checks it at enqueue, after asynchronous preflight, before
rotation mutations and immediately before appending. Records from a replaced or
uninstalled source are dropped and counted. They are never relabelled as the new
source. Already saved records keep their original identity.

The optional `resolvePluginProvenance` override remains host-owned. Its result
contains `sourceId`, `sourceKind`, `namespace`, and an optional synchronous
`isCurrent` function. Source IDs and kinds accept 1-128 ASCII letters, digits,
periods, underscores, colons and hyphens. Opaque namespaces accept the same
characters up to 256 bytes. URLs, display names and plugin claims are not source
identity. `official` describes the host-bound source, not official maintenance.

The source database, marketplace page and sync implementation are unchanged by
this adapter. It also needs no new shared host-registration change for transport.

## Native QA with synthetic data

Use the parent's working cloud GUI machine, a fresh isolated profile, and the
synthetic fixture below. Do not retry the blocked local Electron launch.
Do not open real logs or credentials. Capture screenshots of the settings card,
verbose disclosure, and native Clear confirmation. Record a short flow:

1. Open Plugins settings and choose **Configure** in the local logging row.
   Confirm both options are off and no host-v1 files exist.
2. Enable local saving. Invoke a synthetic plugin host operation and deny another.
3. Open the folder and export to a synthetic destination. Inspect parsed JSONL for
   host identity, outcomes, target digests, and absence of synthetic secret bodies.
4. Open verbose disclosure and cancel. Confirm no plugin text is saved. Confirm
   the disclosure, write synthetic text, and verify the unverified record type.
5. Disable/revoke the plugin. Confirm its later text cannot append. Restart the
   app and verify that local saving remains selected but verbose text is off.
6. Cancel Clear, then confirm it. Confirm the files are removed and the permission
   panel's separate security history remains. Turn local saving off.

The fixture is `electron/plugins/fixtures/local-logging-plugin`. Build it with:

```sh
node --input-type=module -e 'import { buildPluginPackage } from "@netcatty/plugin-cli"; await buildPluginPackage("electron/plugins/fixtures/local-logging-plugin", "/tmp/netcatty-local-logging-fixture.ncpkg");'
```

Package: 3,270 bytes. SHA-256:
`c3770a55676ed708f01ec1e0e0b9968ffb5e03c02303ee7cb9f739bde27c9de0`.
It declares only `commands` and `menus`; its command-palette entries are under
**Logging QA**. **Emit synthetic diagnostic** tests redaction and nested spoofed
identity fields. **Emit synthetic diagnostic burst** emits 400 console messages
to exercise drop accounting. **Test undeclared network denial** must return denial
without a prompt or network I/O because the manifest declares no network access.
No request body or credential is supplied. Do not grant additional permissions.

Capture the compact settings card, verbose disclosure and native Clear dialog,
plus a short recording of the enable/emit/export/clear flow. On a #3981 integration
build, a normal local import must log the source and opaque owner returned by its
host database. On the older base, both stay explicitly unknown. Do not forge an
Official source through fixture metadata. The real-source replacement case is
covered by `pluginLogProvenance.integration.test.cjs` on the documented source
integration worktree; it uses only temporary synthetic database state.

The execution environment for this change could not launch Electron: its SUID
sandbox helper is not root-owned with mode 4755. Electron aborted before opening
any profile. No sandbox-disable retry or system-permission change was attempted.
`npm run pack:dir` also failed while rebuilding the serialport native dependency:
node-gyp tried to create `/home/agent/.electron-gyp` and received ENOENT. No
system-directory change or packaging retry was attempted.

Native screenshots and recording therefore remain pending in the parent desktop
QA queue. Component interaction tests are separate evidence and do not replace
that acceptance.
