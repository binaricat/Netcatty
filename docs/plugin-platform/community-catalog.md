# Curated plugin catalog

The catalog lives in `electron/plugins/catalog.json` in this repository. There
is no new marketplace account service or external directory repository. It is
shipped with the app; catalog changes become available with an app update.
Normal Settings exposes browser-only management and catalog browsing. Advanced
local packages require `NETCATTY_PLUGIN_DEV=1`; that flag never grants permissions.
Native acceptance and security/distribution review remain required before merge.

## Submit or update a plugin

Open a PR changing one entry. Provide:

- Stable reverse-domain plugin ID, author, name and short description.
- Public GitHub source repository and explicit license matching the package.
- Exact version, full 40-character source commit and relative README `.md` path.
- The complete validated manifest: engine/API ranges, required/optional permissions,
  bounded resources, features and data/sync declarations must match package bytes.
- Optional published artifact URL and SHA-256. No artifact means a source-only
  example: the UI does not offer installation. Do not invent an artifact URL.
- A concise change log, permission diff, supported OS test results, and synthetic
  reproduction instructions. Current public runtime eligibility is browser-only
  on the host platforms; native/platform-specific companions are excluded.

Use the local CLI from the repository root:

```sh
npm ci
npm run build:plugin-packages
node packages/plugin-cli/dist/cli.js validate examples/plugins/hello-netcatty
node packages/plugin-cli/dist/cli.js pack examples/plugins/hello-netcatty --out /tmp/hello-netcatty.ncpkg
node packages/plugin-cli/dist/cli.js validate /tmp/hello-netcatty.ncpkg
```

The catalog contains first-party source examples: Plugin Starter for minimal
settings/command use, and Hello Netcatty for terminal provider demonstrations.
No downloadable release is fabricated or published by this change. A maintainer
must verify real artifact provenance before adding the artifact object.

## Enforced install boundary

The renderer sends only a catalog ID. The main process selects the shipped
entry, downloads over HTTPS from approved GitHub hosts with bounded size/time
and redirects, checks SHA-256, and hands a private file to the same serialized
PluginManager and PackageStore used for local imports. The immutable staged
snapshot is hashed again before any version switch. Its exact ID/version,
license and full manifest must match the catalog. Unknown permissions fail
canonical schema validation. Browser-only eligibility rejects Node entrypoints,
companions, raw terminal interceptors and advanced runtime declarations.

The directory is a curated integrity assertion, not a publisher signature.
Unsigned runtime grants remain bound to package digest. No latest fallback and
no background code updates exist. Installing an update stops the old version;
the new version remains disabled until reviewed and explicitly enabled. Required
permissions are mediated again by the existing runtime permission engine.
Local advanced development packages require the developer flag and use the existing permission model;
this does not grant advanced privileges or make Node a sandbox.

README is fetched only from the selected commit, on opening details. Redirects
are refused and responses are limited to 256 KiB. Rendering constructs a small
allowlist of React elements from Markdown; HTML remains escaped text and images
are not fetched. Only explicit HTTPS links can be opened. README content is
untrusted author documentation; permissions come from the manifest.

## Review and maintenance

CI now runs canonical plugin contract drift checks and the runtime suite,
including catalog validation and install-boundary regression tests.
Run `node --test electron/plugins/catalogService.test.cjs` and the plugin
contract/runtime tests for every entry change. Review actual package/source
provenance and permission/resource differences manually on first submission and
sensitive updates. Packaging validation includes traversal/integrity checks but
is not a malware audit. Human review is mandatory before adding an artifact;
there is no automated acceptance bot in this slice.

Authors maintain their plugins, document data handling and respond to security
reports. Maintainers may remove entries or decline updates. Directory checks
are limited checks, not a safety certification, legal waiver or a promise to
repair third-party plugins. No third-party terms are copied here.

## Data and lifecycle

Local KV is per-plugin and does not sync. Only explicitly syncable non-secret
settings enter encrypted sidecars; machine paths, grants, packages, runtime
state and secrets do not become cloud authority. Existing sidecar conflict and
account isolation mechanisms are reused. A generic KV sync API remains a separate
schema/migration decision.

Incompatible host/API/features disable plugins before lazy contributions are
published, retain package/data and record a reason. A compatible downgrade never
automatically re-enables them. Disable stops runtime and contributions; uninstall
removes package code and local KV, while user-owned settings/secrets/sidecars
remain. Existing crash quarantine and generation-bound cancellation apply.

Missing OS-backed key storage blocks secrets/credentials, without blocking
catalog browsing or non-secret plugins. The Settings manager reports this state;
never switch to plaintext storage or disable Chromium sandboxing for a demo.

## When permission prompts appear

Enabled is an availability switch, not a security review or a grant. A lazy
plugin can become enabled without starting code. Its first command/provider use
starts the runtime; required permissions are authorized at that activation
boundary. Optional permissions are requested when a broker operation needs them.
Missing/denied decisions fail closed. Never interpret an Enabled badge as proof
that terminal, credential, network or filesystem access has been approved.
