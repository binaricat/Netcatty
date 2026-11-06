# Plugin author presentation

The marketplace displays the catalog's author next to a small avatar. Installed
views reuse the author row. Missing, loading, unavailable, or invalid imagery
uses a bundled placeholder. An avatar is presentation metadata, not proof of an
authenticated GitHub publisher.

The registry binds an image to its reviewed displayed-author subject. Repository
ownership alone does not establish that subject. The current first-party author
is the Netcatty project, not an assumed personal GitHub identity. Until an image
pin is reviewed, its avatar remains null.

## Avatar delivery

Delivery v2 extends the reserved `avatar` field to null or
`{path, sha256, size}`. The path is exactly `/assets/<sha256>.png` or `.webp`.
Size is a positive integer no greater than 256KiB. The delivery digest and existing
id/version/repository/commit tuple bind the reference. Catalog and index identity
fields do not change. Source-only delivery v1 remains supported.

Only the main process fetches the selected source's same-origin asset. Existing
URL, credential, redirect, timeout, byte-count, and SHA-256 checks apply. The host
rechecks the source and selection after asynchronous work. The existing isolated
icon rasterizer validates and converts PNG or WebP to a bounded PNG data URI,
using its current queue, pending-work map, and cache. No renderer URL, arbitrary
file path, GitHub API, or GitHub avatar URL is accepted. Visible rows load lazily.

Installed presentation uses already validated catalog metadata only when source,
version, package digest, and manifest match the active installation. It does not
fetch a catalog just because the installed list opens. Without an exact match,
the declared publisher and placeholder remain visible, without a maintenance
badge. No installed-data migration or persistent identity cache is added.

## Official maintenance

The borderless gold pill means that the Netcatty project maintains the plugin.
It does not certify the plugin's safety or grant permissions. It is separate
from the official marketplace source label.

The main process requires the built-in official source and one of these explicit
first-party ID and repository pairs:

- `com.netcatty.starter`, `binaricat/Netcatty`
- `com.netcatty.hello`, `binaricat/Netcatty`

A local import, a third-party copy, an ID prefix, author text, manifest publisher,
README, or membership in the official marketplace cannot create this badge.
The renderer consumes the host result through the existing trusted-app IPC
boundary. No new plugin permission or plugin RPC is introduced.

## Validation scope

Focused registered tests cover source spoofing, exact installed identity,
hash-bound images, invalid metadata and decoding, redirects, source removal,
selection changes, cache reuse, lazy loading, stale UI cleanup, placeholders,
and borderless light/dark theme classes. These tests do not establish native
layout, actual account identity, live CDN deployment, or successful network access.
Actual app screenshots and native acceptance remain separately scheduled.
