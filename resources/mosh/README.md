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

Release tags: `moshcatty-*` (require `moshcatty-0.1.4+`) from
`binaricat/MoshCatty`, with `SHA256SUMS`.

### Linux glibc floors

Linux assets must start on the same distros Netcatty packages for. From
`moshcatty-0.1.2`, MoshCatty builds Linux clients on:

| Target | Build image | Max required GLIBC |
|--------|-------------|--------------------|
| `linux-x64` | AlmaLinux 8 | 2.28 |
| `linux-arm64` | Debian bullseye | 2.31 |

Do **not** pin packaging to `moshcatty-0.1.0` / `0.1.1` Linux binaries: those
were built on Ubuntu runners and require GLIBC 2.34.

## Fetch

```sh
# Optional pin (0.1.4+ includes the Windows shortcut-input fix)
export MOSH_BIN_RELEASE=moshcatty-0.1.4
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
