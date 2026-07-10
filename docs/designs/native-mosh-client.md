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

## Decision log

- **2026-07-10:** Feasibility accepted; client extracted to `binaricat/MoshCatty`.
- **2026-07-10:** Netcatty defaults packaging to MoshCatty releases.
- **2026-07-10:** Removed legacy Cygwin build pipeline, FluentTerminal fallback,
  `mosh-bin-*` tags, dll/terminfo runtime helpers. Pure MoshCatty only
  (`moshcatty-0.1.1`: ConPTY Ctrl+C + static MSVC CRT).
