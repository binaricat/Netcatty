# Native Cross-Platform Mosh Client

Status: **shipped via [MoshCatty](https://github.com/binaricat/MoshCatty)**
Related: [#2025](https://github.com/binaricat/Netcatty/issues/2025), [#2072](https://github.com/binaricat/Netcatty/issues/2072)

## Canonical repository

**https://github.com/binaricat/MoshCatty**

Netcatty only **consumes** `moshcatty-*` release binaries into `resources/mosh/`
via `scripts/fetch-mosh-binaries.cjs` / `scripts/resolve-mosh-bin-release.cjs`
(default `MOSH_BIN_REPO=MoshCatty`).

There is **no** in-tree Rust source, no Cygwin packaging path, and no
FluentTerminal / `mosh-bin-*` fallback.

## Integration contract

```text
MOSH_KEY=<key> mosh-client <host> <port>
```

Netcatty owns SSH bootstrap (`moshHandshake` + PTY), then swaps to the
bundled MoshCatty binary under `node-pty`.

| Concern | Owner |
|---------|--------|
| SSH auth / `MOSH CONNECT` parse | Netcatty Electron |
| UDP Mosh data plane | MoshCatty binary |
| Packaging / fetch / electron-builder | Netcatty scripts → MoshCatty releases |

## Why

Windows Cygwin `mosh-client` + partial runtime + ConPTY sandwich was
architecturally broken. MoshCatty is a pure Rust, wire-compatible client with
one code path on Linux / macOS / Windows (static CRT on Windows).

## Linux compatibility floors

MoshCatty Linux release binaries must target the **same glibc floors as
Netcatty package jobs** (not bare `ubuntu-latest`):

| Target | Netcatty package image | Max GLIBC |
|--------|------------------------|-----------|
| `linux-x64` | `almalinux:8` | 2.28 |
| `linux-arm64` | `debian:bullseye` | 2.31 |

Enforced upstream from `moshcatty-0.1.2` via MoshCatty release CI
(`scripts/assert-max-glibc.sh`). Do not pin packaging to pre-0.1.2 Linux
assets (they require GLIBC 2.34).

## Windows compatibility floor

Netcatty requires `moshcatty-0.1.4+`. That release preserves arrow keys,
Ctrl/Alt-modified shortcuts, and Ctrl+C through Windows ConPTY. Packaging must
not resolve or accept an older MoshCatty release.

## Decision log

- **2026-07-10:** Feasibility accepted; client extracted to `binaricat/MoshCatty`.
- **2026-07-10:** Netcatty defaults packaging to MoshCatty releases.
- **2026-07-10:** Removed legacy Cygwin build pipeline, FluentTerminal fallback,
  `mosh-bin-*` tags, dll/terminfo runtime helpers. Pure MoshCatty only
  (`moshcatty-0.1.1`: ConPTY Ctrl+C + static MSVC CRT).
- **2026-07-10:** Require `moshcatty-0.1.2+` for Linux glibc floors matching
  Netcatty (x64 ≤ 2.28, arm64 ≤ 2.31).
- **2026-07-11:** Require `moshcatty-0.1.4+` for Windows ConPTY shortcut input;
  keep Mosh sessions on Netcatty's primary terminal screen so highlighting and
  scrollback remain available.
