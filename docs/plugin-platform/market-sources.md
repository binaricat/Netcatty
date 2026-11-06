# Market sources (unreleased)

The plugin manager has Installed, Official marketplace and Third-party marketplace
pages. Listing a plugin in the official market does not certify it or establish
that Netcatty maintains it. Remote manifests, publisher names, source names and
README content cannot create a host-issued official badge. The separate gold
maintainer badge requires the built-in official source and an exact host-curated
first-party ID/repository pair. It describes maintenance, not safety certification.
README text and images remain author content.

## Add a source

Enter a public HTTPS origin, for example `https://plugins.example.com`, or that
origin's `/v1/snapshot.json`. Names can change; identity is derived by the host
from the canonical origin. Credentials, query strings, fragments, custom ports,
IP literals and local hostnames are rejected. The initial third-party transport
requires public IPv4 DNS records, pins the checked address to the TLS connection,
and rejects private/reserved destinations. IPv6-only sources are not supported
in this revision. No cookies, login tokens, redirects or GitHub fallback are used.

Third-party sources begin empty. A failed request never substitutes the official
catalog. Each source has its own in-memory last-known-good snapshot and selection
tokens; an offline snapshot is browse-only. A process restart requires a fresh
third-party fetch. The official source remains fixed to `plugins.netcatty.app`
and retains its bundled source examples when unavailable.

## Publish a static source

Use the existing snapshot protocol in the registry project's
`docs/STATIC-DISTRIBUTION.md`. Every source
serves `/v1/snapshot.json`, pointing to hash/size-bound catalog, index and delivery
JSON under `/snapshots/<delivery-sha256>/`. All resources remain on the source's
origin under content-addressed `/assets/` paths. Whole-JSON budgets, schema,
manifest, compatibility, browser-runtime admission and archive validation still
apply. Third-party source consent is not permission consent.

Delivery v1 is unchanged and source-only. Delivery **v2** has the same fields and
strict schema as v1, with `schemaVersion: 2`. Each plugin's `artifact` can be null
or a package reference:

```json
{"path":"/assets/<64-lowercase-hex-sha256>.ncpkg","sha256":"<same-sha256>","size":12345}
```

V2 delivery packages are at most 16 MiB. The catalog entry must contain
`artifact: {url: "https://plugins.example.com/assets/<same-sha256>.ncpkg", sha256}`.
The index's current, non-withdrawn version must exactly equal the catalog entry
and use `distribution: "release"`. Source-only entries retain null delivery
artifacts and `distribution: "source-only"`. The reserved `avatar` can also be
null or a same-origin `/assets/<sha256>.png` or `.webp` reference, with a positive
size no greater than 256KiB. The host verifies and rasterizes its bytes through
the existing image infrastructure. Missing or invalid imagery uses a placeholder.
Remote README embeds are not loaded. README and PNG/WebP references retain the v1 bounds.
Existing official bootstrap entries are not changed or made installable.
See [author presentation](author-identity.md) for subject and maintenance authority.

Before every install, refresh and validate the entire snapshot again. A changed
selection, withdrawal, unavailable source, altered hash or size prevents install;
there is no fallback to another source or latest release. Packages install disabled.

## Ownership and changing source

A public plugin ID can have only one installed source. The package's host install
metadata and durable database binding record that source, including across
recovery and uninstall. Cross-source install or update is rejected, even when
version and package bytes match. Local imports are a separate source.

Private settings, view state, persistent and in-memory grants, secrets, and cloud
sidecars are namespaced by host-derived source identity. Every source, including local imports, uses an opaque encoded owner; public plugin IDs are never storage-owner aliases in sync payloads. Before each sync entry and after every awaited contribution update/reset, the host rechecks that owner against the live source and contributions. Hydration captures its owner before yielding and never remaps a public ID for a later write. KV keys are qualified
inside the existing per-plugin FK. Code, permissions and source configuration do
not participate in cloud sync. Old-source cloud settings may remain orphaned;
they cannot hydrate the same plugin ID from a different source. Generic KV still
is not cloud-synced. No host/Vault/input migration changes are made.

To change source, uninstall and explicitly select **clear this source's private
data, grants and secrets**. The host serializes shutdown, revocation, private-file
cleanup and binding reset. This is destructive and is never selected by default.
Then install from the new source and review permissions again. An uninstall that
retains data deliberately retains the binding and continues to reject other sources.

Removing a market keeps its installed plugins and data. Updates stop; optionally
disable its plugins. No other market silently takes over. Disabling a source only
stops browsing/install/update access; it does not silently revoke existing plugins.

## Validation limits

Tests use synthetic source responses and first-party packages. Passing tests is
not a sandbox certification. Native UI, real third-party hosting, network
availability and multi-device encrypted-sync acceptance must be reported
separately. No real credentials or untrusted community code are needed for tests.

## Source-owner integration

Use `PluginDatabase.getActivePlugin(context.pluginId)` to require a current host
installation, then `database.privateOwner(plugin.id)` for an opaque data partition.
`plugin.source` is host-owned `{id, kind, name, origin}`.
`getRetainedPluginSource(pluginId)` returns a retained uninstall binding or null.
`publicPluginId(owner)` resolves only an encoded owner matching the current source;
it rejects raw public IDs and stale owners. Never accept owner/source from a plugin
request or invent a `pluginId` fallback. Capture owner/source at async operation
start and revalidate before committing; follow runtime lifecycle cancellation.

Plugin database schema 7 atomically converts existing raw local private rows and
KV keys to the same encoded-owner model without deleting them. This is a one-time
conversion, not a parallel runtime compatibility path. A conflicting conversion
fails without publishing schema 7. Old raw-ID cloud entries remain orphaned and
cannot hydrate an installed plugin. Host/Vault/input schemas are unchanged.
