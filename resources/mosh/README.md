# Bundled `mosh-client` (MoshCatty)

This directory holds the pure Rust `mosh-client` from
[binaricat/MoshCatty](https://github.com/binaricat/MoshCatty).

Netcatty runs SSH + `mosh-server` bootstrap itself, then launches this binary
(see `electron/bridges/moshHandshake.cjs` and `terminalBridge/moshSession.cjs`).

## Layout

| Target | Release asset | Local path |
|--------|---------------|------------|
| Linux x64 | `mosh-client-linux-x64.tar.gz` | `linux-x64/mosh-client` |
| Linux arm64 | `mosh-client-linux-arm64.tar.gz` | `linux-arm64/mosh-client` |
| macOS universal | `mosh-client-darwin-universal.tar.gz` | `darwin-universal/mosh-client` |
| Windows x64 | `mosh-client-win32-x64.tar.gz` | `win32-x64/mosh-client.exe` |

Each tarball contains **only** the client binary (no Cygwin DLLs, no terminfo).
Windows builds static-link the MSVC CRT (`moshcatty-0.1.1+`).

Release tags: `moshcatty-*` (e.g. `moshcatty-0.1.1`) from
`binaricat/MoshCatty`, with `SHA256SUMS`.

## Fetch

```sh
# Optional pin
export MOSH_BIN_RELEASE=moshcatty-0.1.1
npm run fetch:mosh

# Dev: host platform; resolves latest moshcatty-* if unset
npm run fetch:mosh:dev
```

Env: `MOSH_BIN_OWNER` / `MOSH_BIN_REPO` (default `binaricat` / `MoshCatty`),
`MOSH_BIN_BASE_URL` for mirrors.

`electron-builder` packages `Resources/mosh/mosh-client[.exe]` only.

## Licenses

- MoshCatty client: **GPL-3.0-or-later**
- Upstream Mosh protocol reference: **GPL-3.0**
- Netcatty is **GPL-3.0**
