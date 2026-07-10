# Bundled EternalTerminal `et` client

This directory holds the EternalTerminal **client** binary (`et`) bundled
with the Netcatty installer. Netcatty launches this bundled `et` directly
(see `electron/bridges/terminalBridge/etSession.cjs`); `et` performs its
own SSH bootstrap and EternalTerminal protocol handshake against the remote
`etserver` / `etterminal`.

Like MoshCatty `mosh-client`, `et` is a pure network-transport client and does not
render a terminal locally, so there is **no terminfo bundle** here — only the
single `et` (`et.exe` on Windows) binary.

## How binaries land here

1. `.github/workflows/build-et-binaries.yml` builds `et` on relevant
   pushes/PRs, or on a manual `workflow_dispatch`. It uses
   `scripts/build-et/build-linux.sh` and `scripts/build-et/build-macos.sh`
   for Linux/macOS, and `scripts/build-et/build-windows.ps1` for Windows:

   | target            | provenance                                                       |
   |-------------------|------------------------------------------------------------------|
   | `linux-x64`       | upstream source, manylinux2014, vcpkg static deps + glibc        |
   | `linux-arm64`     | upstream source, manylinux2014, vcpkg static deps + glibc        |
   | `darwin-universal`| upstream source, lipo arm64 + x86_64, macOS system dylibs only   |
   | `win32-x64`       | upstream source, MSVC + vcpkg `x64-windows-static` (no DLLs)     |
   | `win32-arm64`     | (not built — add after a tested arm64 client is available)       |

   ET builds with CMake + Ninja + vcpkg
   (`cmake -DDISABLE_TELEMETRY=ON -GNinja -DCMAKE_BUILD_TYPE=RelWithDebInfo`).

2. When manually dispatched with `release_tag`, that workflow publishes the
   binaries to the dedicated `binaricat/Netcatty-et-bin` repository. The
   release gets a tag like `et-bin-6.2.10-1`, with `SHA256SUMS` attached.

3. Release packaging runs `scripts/resolve-et-bin-release.cjs` before
   `npm run fetch:et`. It uses an explicit workflow input first, then the
   `ET_BIN_RELEASE` repository variable, then the latest non-draft
   `et-bin-*` GitHub Release from the dedicated binary repository. The fetch
   step pulls the binaries into `resources/et/<platform-arch>/`. For local
   packaging, set `ET_BIN_RELEASE` yourself before running the same fetch
   command. Override `ET_BIN_OWNER` / `ET_BIN_REPO` only when testing a
   different binary repository. `electron-builder.config.cjs` then copies the
   matching binary into `Resources/et/et[.exe]`.

   Local dev uses the same binary path: `npm run dev` runs
   `npm run fetch:et:dev` first, which downloads the host platform's bundled
   `et` into this gitignored directory. Netcatty does not fall back to a
   system-installed `et`; if the bundled binary is missing, ET startup fails
   loudly instead of using whatever happens to be installed on the developer
   machine.

The directory is otherwise empty (binaries are gitignored).

## Licenses

- EternalTerminal is licensed under **Apache-2.0**
  (https://github.com/MisterTea/EternalTerminal).
- Netcatty is **GPL-3.0**; Apache-2.0 is one-way compatible with GPL-3.0, so
  redistribution as part of the installer is permitted.
- vcpkg-managed deps (boost Boost-License, libsodium ISC, protobuf
  BSD-3-Clause, gflags BSD-3-Clause) are compatible with GPL-3.0.

## Reproducible build

To reproduce the Linux binary locally:

```sh
docker run --rm -v $PWD:/workspace -w /workspace \
  -e ET_REF=et-v6.2.10 -e ARCH=x64 -e OUT_DIR=/workspace/out \
  quay.io/pypa/manylinux2014_x86_64 \
  bash scripts/build-et/build-linux.sh
```

For macOS the build needs an Xcode toolchain; see
`scripts/build-et/build-macos.sh`. For Windows see
`scripts/build-et/build-windows.ps1`.

## Roadmap

- Add Windows arm64 only after a tested standalone arm64 client is available.
- Make `ET_REF` track upstream release tags automatically.
