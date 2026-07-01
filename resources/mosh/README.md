# Bundled `mosh-client`

This directory holds the network-protocol-only `mosh-client` binary
bundled with the Netcatty installer. Netcatty drives the `ssh` +
`mosh-server` bootstrap itself and then launches this bundled client
directly (see `electron/bridges/moshHandshake.cjs` and
`electron/bridges/terminalBridge.cjs`).

## How binaries land here

1. `.github/workflows/build-mosh-binaries.yml` builds or fetches
   `mosh-client` on relevant pushes/PRs, or on a manual
   `workflow_dispatch`. It uses `scripts/build-mosh/build-linux.sh` and
   `scripts/build-mosh/build-macos.sh` for Linux/macOS, and
   `scripts/build-mosh/fetch-windows.sh` for the pinned Windows bundle:

   | target            | provenance                                                      |
   |-------------------|-----------------------------------------------------------------|
   | `linux-x64`       | upstream source, manylinux2014, static third-party deps + glibc |
   | `linux-arm64`     | upstream source, manylinux2014, static third-party deps + glibc |
   | `darwin-universal`| upstream source, lipo arm64 + x86_64, macOS system dylibs only  |
   | `win32-x64`       | Netcatty-pinned runtime bundle + FluentTerminal fallback        |
   | `win32-arm64`     | (not built — Cygwin arm64 port not yet stable)                  |

   The upstream Cygwin Windows build is not rebuilt in this workflow by
   default. Windows releases use a SHA256-pinned bundle that was built
   by Netcatty and verified for packaging.

2. When manually dispatched with `release_tag`, that workflow publishes
   the binaries to the dedicated `binaricat/Netcatty-mosh-bin`
   repository. The release gets a tag like `mosh-bin-1.4.0-1`, with
   `SHA256SUMS` attached.

3. Release packaging runs `scripts/resolve-mosh-bin-release.cjs` before
   `npm run fetch:mosh`. It uses an explicit workflow input first, then
   the `MOSH_BIN_RELEASE` repository variable, then the latest
   non-draft `mosh-bin-*` GitHub Release from the dedicated binary
   repository. The fetch step pulls the binaries into
   `resources/mosh/<platform-arch>/`. For local packaging, set
   `MOSH_BIN_RELEASE` yourself before running the same fetch command.
   Override `MOSH_BIN_OWNER` / `MOSH_BIN_REPO` only when testing a
   different binary repository. `electron-builder.config.cjs` then
   copies the matching binary into `Resources/mosh/mosh-client[.exe]`.

   Local dev uses the same binary path: `npm run dev` runs
   `npm run fetch:mosh:dev` first, which downloads the host platform's
   bundled `mosh-client` into this gitignored directory. Netcatty does
   not fall back to a system-installed `mosh` or `mosh-client`; if the
   bundled binary is missing, Mosh startup fails loudly instead of using
   whatever happens to be installed on the developer machine.

   Official Windows package builds currently ship x64 only for bundled
   Mosh coverage. Windows arm64 packaging should be added only after we
   have a tested arm64 client bundle.

The directory is otherwise empty (binaries are gitignored).

## Licenses

- Mosh itself is licensed under **GPL-3.0**
  (https://github.com/mobile-shell/mosh).
- Netcatty is **GPL-3.0**, so redistribution as part of the installer
  is permitted.
- The default Windows x64 artifact is a SHA256-pinned Netcatty
  `mosh-client-win32-x64.tar.gz` bundle from
  `binaricat/Netcatty-mosh-bin` release `mosh-bin-1.4.0-2`. It includes
  `mosh-client.exe`, required Cygwin runtime DLLs, and the bundled
  `xterm-256color` terminfo entry. The FluentTerminal standalone
  `mosh-client.exe` from https://github.com/felixse/FluentTerminal @
  commit `bad0f85` remains published as a pinned fallback.
- Bundled/static deps (OpenSSL Apache-2.0, protobuf BSD-3-Clause,
  ncurses MIT) are compatible with GPL-3.0.

## Reproducible build

To reproduce the binaries locally:

```sh
docker run --rm -v $PWD:/workspace -w /workspace \
  -e MOSH_REF=mosh-1.4.0 -e ARCH=x64 -e OUT_DIR=/workspace/out \
  quay.io/pypa/manylinux2014_x86_64 \
  bash scripts/build-mosh/build-linux.sh
```

For macOS the build needs an Xcode toolchain; see
`scripts/build-mosh/build-macos.sh`.

## Phase 2/3 — done in this PR

- `electron/bridges/moshHandshake.cjs` reimplements the upstream Mosh
  Perl wrapper in Node: parser + sniffer + command builders as pure
  functions.
- `terminalBridge.startMoshSession` runs the SSH bootstrap in a
  node-pty so password / 2FA / known-hosts prompts render naturally
  in the user's terminal, then swaps `session.proc` from the ssh PTY
  to a freshly-spawned `mosh-client` PTY when `MOSH CONNECT` is
  detected. Keystrokes that arrive after the swap go to mosh-client
  because `writeToSession` reads `session.proc` lazily.
- Mosh startup requires Netcatty's bundled `mosh-client` and a usable
  `ssh` client for the remote bootstrap. System-installed `mosh` /
  `mosh-client` binaries are intentionally ignored.
- Windows x64 currently ships the pinned Netcatty runtime bundle. The
  old standalone client remains only as a release fallback.

## Roadmap

- Add Windows arm64 only after a tested arm64 client bundle is
  available.
- Make `MOSH_REF` track upstream release tags automatically.
