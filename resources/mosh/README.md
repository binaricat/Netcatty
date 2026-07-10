# Bundled `mosh-client`

This directory holds the network-protocol-only `mosh-client` binary
bundled with the Netcatty installer. Netcatty drives the `ssh` +
`mosh-server` bootstrap itself and then launches this bundled client
directly (see `electron/bridges/moshHandshake.cjs` and
`electron/bridges/terminalBridge.cjs`).

## Source: [MoshCatty](https://github.com/binaricat/MoshCatty)

All platforms ship the pure Rust client from
[`binaricat/MoshCatty`](https://github.com/binaricat/MoshCatty)
(no Cygwin, no terminfo runtime, no DLL bag).

| Target | Asset |
|--------|--------|
| `linux-x64` | `mosh-client-linux-x64.tar.gz` |
| `linux-arm64` | `mosh-client-linux-arm64.tar.gz` |
| `darwin-universal` | `mosh-client-darwin-universal.tar.gz` |
| `win32-x64` | `mosh-client-win32-x64.tar.gz` |

Release tags: `moshcatty-*` (e.g. `moshcatty-0.1.0`). Every release includes
`SHA256SUMS`.

### How binaries land here

1. MoshCatty CI builds multi-platform `mosh-client` and publishes a GitHub
   Release.
2. Netcatty packaging / `npm run dev` runs
   `scripts/resolve-mosh-bin-release.cjs` then
   `scripts/fetch-mosh-binaries.cjs`:
   - Explicit `MOSH_BIN_RELEASE` if set
   - else latest non-draft `moshcatty-*` (or legacy `mosh-bin-*`) from
     `binaricat/MoshCatty` (override with `MOSH_BIN_OWNER` /
     `MOSH_BIN_REPO` only for staging mirrors)
3. `electron-builder.config.cjs` copies the host binary into
   `Resources/mosh/mosh-client[.exe]`.

```sh
# Pin a release (optional)
export MOSH_BIN_RELEASE=moshcatty-0.1.0
npm run fetch:mosh

# Dev: host platform only
npm run fetch:mosh:dev
```

Development of the client itself lives in the MoshCatty repo — not in this
tree.

## Licenses

- MoshCatty client: **GPL-3.0-or-later**
- Upstream Mosh protocol reference: **GPL-3.0**
- Netcatty is **GPL-3.0**, so redistribution in the installer is fine
