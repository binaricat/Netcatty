# Native Cross-Platform Mosh Client

Status: **shipped via [MoshCatty](https://github.com/binaricat/MoshCatty)**  
Related: [#2025](https://github.com/binaricat/Netcatty/issues/2025), [#2072](https://github.com/binaricat/Netcatty/issues/2072)

## Canonical repository

Implementation, CI, and multi-platform releases live in:

**https://github.com/binaricat/MoshCatty**

Netcatty only **consumes** release binaries into `resources/mosh/` via
`scripts/fetch-mosh-binaries.cjs` (default `MOSH_BIN_REPO=MoshCatty`).

There is **no** in-tree Rust source for the client anymore.

## Integration contract

```text
MOSH_KEY=<key> mosh-client <host> <port>
```

Netcatty still owns SSH bootstrap (`moshHandshake` + PTY), then swaps to the
bundled MoshCatty binary under `node-pty`.

| Concern | Owner |
|---------|--------|
| SSH auth / `MOSH CONNECT` parse | Netcatty Electron |
| UDP Mosh data plane | MoshCatty binary |
| Packaging / fetch / electron-builder | Netcatty scripts |

## Why (summary)

Windows Cygwin `mosh-client` + partial runtime + ConPTY sandwich was
architecturally broken. MoshCatty is a pure Rust, wire-compatible client with
one code path on Linux / macOS / Windows.

See the [MoshCatty README](https://github.com/binaricat/MoshCatty#readme) for
protocol stack, build, and release details.

## Decision log

- **2026-07-10:** Feasibility accepted; Rust client developed in-tree then
  extracted to `binaricat/MoshCatty`.
- **2026-07-10:** Netcatty defaults packaging to MoshCatty releases; in-tree
  `native/netcatty-mosh` vendor snapshot removed.
- **2026-07-10:** `fetch-mosh-binaries` accepts pure Windows tarballs (exe only;
  no Cygwin dlls / terminfo required). MoshCatty `moshcatty-0.1.1` ships
  ConPTY Ctrl+C fix + static MSVC CRT (no `VCRUNTIME140`).
