# Official static distribution client

Community starts at the fixed main-process endpoint
`https://plugins.netcatty.app/v1/snapshot.json`. The renderer cannot choose an
endpoint. All automatic catalog, README and potential package reads allow only
that exact HTTPS origin: no credentials, query, fragment, noncanonical URL or
redirect. No GitHub API/raw/avatar/release fallback exists. Explicit user-opened
source links may still open GitHub in an external browser.

## Snapshot contract

This client implements the version-1 contract from
`binaricat/netcatty-plugins@7bfe23e5627e16ba63806de6dded5b2667c02984`.
The source catalog/index remain unchanged; **no `readmeAsset` field is added**.

The pointer contains `schemaVersion: 1`, `registryCommit`, `snapshotId`, and
`catalog`, `index`, `delivery` references, each `{path, sha256, size}`. Paths must
be `/snapshots/<snapshotId>/<name>.json`; `snapshotId` equals the raw delivery
SHA-256. The host checks the pointer before requesting its three documents,
then checks raw byte counts/hashes, JSON budgets, schemas and cross-document
identity. The three documents must all validate before replacing any cache.

Delivery contains `schemaVersion`, `registryCommit`, `catalogSha256`,
`indexSha256`, `sourceLockSha256`, `builderSha256` and `plugins`. Each item matches
one exact catalog `id/version/repository/commit` tuple and supplies `readme`,
`iconLight`, `iconDark`, `avatar`, `artifact`. Asset references are
`{path, sha256, size}`, with `/assets/<sha256>.md` for README and `.png`/`.webp`
for brand icons. This v1 publishing schema requires **avatar and artifact to
be null**. The client rejects unsupported delivery metadata rather than
inventing installable packages or deriving a GitHub avatar URL.

Delivery v2 retains those fields and admits hash-bound packages plus the reserved
avatar as null or a positive-size PNG/WebP asset reference of at most 256KiB.
The host fetches only the selected source's same-origin asset, verifies bytes,
and reuses its bounded icon rasterizer and cache. The renderer receives a PNG
data URI. Author imagery does not verify a GitHub account, and no GitHub avatar
URL is derived. See [author presentation](author-identity.md).

Index is validated with its pinned schema. Plugin/version identities must be
unique; each catalog entry must exactly equal the index's current, non-withdrawn,
source-only entry. Withdrawal does not disable, uninstall or delete any existing
plugin: this is catalog admission, not a remote installed-code kill switch.

Schemas are vendored under `electron/plugins/distribution/`, with provenance and
fixtures described there. All schema references resolve locally; schema validation
does not fetch GitHub or netcatty.com.

## Bounds, cache and selection

Pointer reads are bounded to 16 KiB, each JSON document to 2 MiB, and each README
to 256 KiB. Reads time out after 30 seconds. Whole JSON values retain the existing
128-level / 100,000-value / finite-number boundary. Catalogs contain at most 1,000
entries. Existing manifest identity, license and browser-only policies remain.

The host prepares private entries, private delivery resources and all public
selection tokens before one synchronous cache publication. Parse, integrity,
schema, clone, tuple or network failures preserve the last complete good snapshot.
The cache remains **in memory for this app session**; a fresh offline launch lists
bundled examples. No new disk database, sync record or credential is introduced.

A host-generated selection token binds the complete entry and its delivery item.
This prevents silent selection changes; it is **not a signature**. README requests
capture the matched static reference and verify its exact byte count and digest.
Missing/offline snapshots show an error/Retry; they never synthesize a raw GitHub URL.
README HTML and remote images remain inert in the existing safe renderer.

The current v1 distribution cannot install packages. A later publishing/client
schema revision must jointly introduce reviewed package mirroring, keep source
manifest/hash admission, and recheck the current pointer and fresh root withdrawal
ledger before any install. A historical snapshot alone cannot establish availability.
The existing lower-level package downloader accepts only official static URLs and
exact SHA-256 bytes; it does not relax those future gates or auto-enable code.

## Network inventory

| Path | Automatic source | Failure behavior |
| --- | --- | --- |
| Pointer / manual refresh | Fixed `/v1/snapshot.json` | Complete session cache, or bundled source-only entries |
| Catalog/index/delivery | Pointer-bound same-origin immutable paths | Reject partial or mixed snapshots |
| README details | Exact delivery `/assets/<hash>.md` | Visible error/Retry, no upstream fallback |
| Uninstalled brand icons | Existing reviewed bundled previews | Default icon; delivery icon metadata validated but not fetched by UI |
| Installed brand icons | Host-owned local package decoder | Default icon; no activation/network request |
| Author avatars | Visible-row host fetch of a validated v2 same-origin resource; v1 remains null | Default placeholder; no GitHub lookup or renderer URL fetch |
| Package artifacts | Not published or admitted by delivery v1 | Source-only; no download action fabricated |
| Source/README links | Explicit user-opened external HTTPS link | May open GitHub; no background dependency |

The real PR3 bootstrap is retained as a test fixture with its original bytes and
hashes. Tests also verify its brand-icon asset bytes; this does not claim a new
remote icon renderer. The static publisher is not a proxy. Client tests do not
prove deployment, mainland reachability or successful native CDN access. Native
QA must independently verify the published endpoint and visible failure state.
