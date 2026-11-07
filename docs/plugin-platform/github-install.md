# Install from GitHub

Settings > Plugins > Open plugin manager > **Install from GitHub** installs a
published package from a public GitHub repository. Local `.ncpkg` import and
marketplace installation remain available.

Accepted repository inputs are `https://github.com/owner/repo`,
`github.com/owner/repo`, and `owner/repo`. HTTP is upgraded to HTTPS. An optional
trailing `.git` and single `/` are removed. Case is normalized to lowercase, so
all these forms share `https://github.com/owner/repo` and the same host-owned
source ID. Credentials, explicit ports, other hosts/schemes, query/fragment,
percent escapes, backslashes, traversal, and extra path segments are rejected.
Paste a repository, not a branch, subdirectory, script or release asset URL.

## Author's release contract

The existing package contract is a `.ncpkg` ZIP produced by
`@netcatty/plugin-cli`: root `netcatty.plugin.json`, its declared browser entry
and resources, and any other validated package contents. The package validator
is the authority for paths, manifest semantics, referenced files, CRCs, archive
headers, expansion limits and companion integrity. A Git checkout, source ZIP,
`package.json`, and `prepare.mjs` are not installable packages.

Existing local preparers remain author-side tools. For example,
`examples/plugins/database-rfam-readonly/prepare.mjs` bundles `host.js` into
`browser.js`, copies `netcatty.plugin.json`, and calls `buildPluginPackage`.
The author must run this locally, validate the resulting `.ncpkg`, and attach
it to a GitHub release. Netcatty never executes a downloaded preparer, npm
lifecycle script, shell command, build tool or repository source.

There was no existing GitHub release discovery/naming contract on main. This
flow defines the narrow delivery contract:

1. Resolve the exact public repository through GitHub's unauthenticated API.
2. Read `/repos/{owner}/{repo}/releases/latest` (GitHub's latest published stable
   release, not a client-side semantic version search). Draft/prerelease-only
   repositories are unsupported.
3. Require a nonempty tag and exactly one uploaded `.ncpkg` release asset. Its
   filename may be any ASCII name beginning with an alphanumeric character and
   otherwise containing letters, digits, `.`, `_`, `-`, at most 200 characters.
   There is no required repository-name prefix. Multiple assets require local
   import so the app cannot silently choose the wrong platform/package.
4. Resolve the tag through `/repos/{owner}/{repo}/commits/{tag}` to a commit SHA.
   Download the asset's exact GitHub release URL, bound to that repository/tag.
5. Check release size, optional GitHub `sha256:` digest, ZIP structure and the
   entire existing package validator, runtime admission, compatibility and
   retained source binding before offering a review.
6. Show the actual package manifest/version, declared permission/resource
   bounds, source, tag/commit, asset and computed SHA-256. Require explicit trust
   acknowledgment. Install disabled through `PluginManager` and `PackageStore`;
   the immutable snapshot must match the reviewed digest and manifest.

The manifest is the package version authority; release tag naming is independent
and both are displayed. The tag/commit identify release context, not proof that
the binary was reproducibly built from that commit. The SHA-256 pins reviewed
bytes; neither it nor GitHub ownership verifies a publisher signature.

No accessible repository, no stable release, no tag commit, missing/ambiguous
asset, HTML/XML instead of a package, incompatible/invalid package, size/hash
mismatch, access denial, rate limit and offline/HTTP failures all fail closed.
There is no clone, auto-build, raw-file or registry fallback. Private repositories,
login and tokens are unsupported. GitHub API repository moves require entering
the current URL, rather than silently changing repository identity.

## Boundaries and persistence

Only the trusted host renderer can invoke prepare/install/discard management
IPC. Plugin RPC exposes no GitHub retrieval or arbitrary URL fetch. The backend
constructs the API URLs and allows only HTTPS `api.github.com`; API redirects
are rejected. Release downloads allow HTTPS `github.com`,
`release-assets.githubusercontent.com`, `objects.githubusercontent.com` with at
most three redirects. Each redirect is checked before contacting its host.
No cookies, Authorization headers, environment credentials or git configuration
are consulted. Redirect signing queries are allowed only on these download
hosts; repository inputs never accept queries or credentials.

Metadata is capped at 2 MiB; packages at the CLI's 100 MiB archive limit plus all
existing expansion/file limits. The network sequence has a 90 second timeout;
standalone bounded transfers default to 30 seconds. Streamed bodies are bounded
regardless of Content-Length. Temporary archives use Netcatty's managed temp
root and mode-0700 private directories, mode-0600 files. Previews are bound to the
requesting renderer, expire after ten minutes, and are consumed on install or
removed on cancel/window destruction. At most eight active/pending operations
are retained. Installation revalidates the private snapshot and reviewed hash
and manifest, then uses the existing atomic publication/recovery transaction.

The existing JSON source binding stores `kind: github`, a repository-derived
source ID, canonical URL, tag, commit and asset ID without a schema migration.
Private data ownership remains tied to the source ID. Replacing a local or
marketplace installation requires the existing explicit uninstall/private-data
reset. Installed details show the repository and pin after reopening/restart.
To update, enter the same repository again and review its current release;
registry update checks intentionally skip GitHub sources. No automatic GitHub
update checks or downgrade policy are introduced.

The existing unsigned security principal still binds package bytes and publisher
text, so changed unsigned code does not inherit grants. Normal installation
admits browser-only/data-theme packages; advanced packages remain behind the
existing developer gate. This feature does not add signing or grant advanced
runtime trust. Review installed permission modes before enabling; declared
supported permissions retain their existing default Allow/Ask/Deny behavior.

## Verification

`domain/pluginGitHubRepository.test.cjs` checks the exact three input forms and
identity equivalence. `electron/plugins/githubInstallService.test.cjs` exercises
the real CLI-produced starter package and actual manager/store/database, plus
controlled metadata/transfer failures. The renderer interaction test mounts the
real Radix dialog. Existing package/manifest and runtime suites retain the
archive abuse/companion/permission boundary checks.

Run the existing Electron smoke harness with this checkout built, the local SSH
fixture running, and:

```sh
NC_APP="$PWD" NC_OUT=/workspace/netcatty-smoke-shots/github-install/pass \
NC_EXTRA="$PWD/scripts/plugin-github-install.smoke.mjs" \
xvfb-run -a -s '-screen 0 1440x900x24' \
node /workspace/netcatty-smoke-harness/smoke.mjs
```

The extra uses Playwright on the actual app, a real starter `.ncpkg` and real
loopback HTTP downloads through a main-process-only injected transport. Production
URL checks, resolver, validator, preview, IPC, permissions and installation all
run unchanged. The repository name/commit in this fixture are explicitly
synthetic, not a claim of a public release. It records an MP4 of the display and
actual Electron screenshots, rejects invalid input and a missing release, reviews
permissions, installs disabled, changes a permission mode and reopens the manager
to verify persistence. It never enables or executes the fixture plugin, and
requires no user credential. The generic harness SSH login is its disposable
local test account.
