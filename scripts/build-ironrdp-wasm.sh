#!/usr/bin/env bash
# Reproducible build script for @netcatty/ironrdp-wasm.
#
# Clones (or updates) Devolutions/IronRDP at a pinned commit (dual-licensed
# MIT OR Apache-2.0), applies Netcatty's minimal patches under
# scripts/ironrdp-web-patches/, runs host unit tests, and compiles crates/ironrdp-web
# with wasm-pack into packages/netcatty-ironrdp-wasm/.
#
# Usage:
#   ./scripts/build-ironrdp-wasm.sh
#
# Optional environment variables:
#   IRONRDP_BUILD_DIR  Scratch checkout & cargo target cache dir
#                      (default: "${TMPDIR:-/tmp}/netcatty-ironrdp-wasm-build")
#   SKIP_TESTS=1       Skip `cargo test -p ironrdp-web --lib --locked`
#   SKIP_WASM_OPT=1    Skip post-build `wasm-opt -Os` optimization

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IRONRDP_REPO="https://github.com/Devolutions/IronRDP.git"
IRONRDP_COMMIT="293cb4bee90baddfd7b8ea08d2f46e31947a3888"
IRONRDP_SHORT="${IRONRDP_COMMIT:0:8}"

PATCH_DIR="${REPO_ROOT}/scripts/ironrdp-web-patches"
OUT_DIR="${REPO_ROOT}/packages/netcatty-ironrdp-wasm"
BUILD_DIR="${IRONRDP_BUILD_DIR:-${TMPDIR:-/tmp}/netcatty-ironrdp-wasm-build}"
SRC_DIR="${BUILD_DIR}/IronRDP"
STAGE_DIR="${BUILD_DIR}/pkg-stage"

die() {
  echo "error: $*" >&2
  exit 1
}

check_toolchain() {
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v rustc >/dev/null 2>&1 || die "rustc is required (install via rustup)"
  command -v cargo >/dev/null 2>&1 || die "cargo is required (install via rustup)"
  command -v wasm-pack >/dev/null 2>&1 || die "wasm-pack is required (e.g. brew install wasm-pack)"

  echo "Toolchain (host default):"
  echo "  rustc:     $(rustc --version)"
  echo "  cargo:     $(cargo --version)"
  echo "  wasm-pack: $(wasm-pack --version)"
  if command -v wasm-opt >/dev/null 2>&1; then
    echo "  wasm-opt:  $(wasm-opt --version)"
  else
    echo "  wasm-opt:  not found (skipping extra binaryen optimization)"
  fi
}

resolve_ironrdp_toolchain() {
  IRONRDP_TOOLCHAIN=""
  if [[ -f "${SRC_DIR}/rust-toolchain.toml" ]]; then
    IRONRDP_TOOLCHAIN="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC_DIR}/rust-toolchain.toml" | head -n 1)"
  fi

  if [[ -n "${IRONRDP_TOOLCHAIN}" ]] && command -v rustup >/dev/null 2>&1; then
    export RUSTUP_TOOLCHAIN="${IRONRDP_TOOLCHAIN}"
    echo "Using IronRDP pinned Rust toolchain: ${IRONRDP_TOOLCHAIN}"
    if ! rustup target list --installed --toolchain "${IRONRDP_TOOLCHAIN}" 2>/dev/null | grep -qx "wasm32-unknown-unknown"; then
      echo "Installing wasm32-unknown-unknown target for toolchain ${IRONRDP_TOOLCHAIN}..."
      rustup target add --toolchain "${IRONRDP_TOOLCHAIN}" wasm32-unknown-unknown
    fi
  elif command -v rustup >/dev/null 2>&1; then
    if ! rustup target list --installed | grep -qx "wasm32-unknown-unknown"; then
      die "Rust target wasm32-unknown-unknown is not installed. Run: rustup target add wasm32-unknown-unknown"
    fi
  fi
}

prepare_source() {
  mkdir -p "${BUILD_DIR}"

  if [[ ! -d "${SRC_DIR}/.git" ]]; then
    echo "Cloning Devolutions/IronRDP at ${IRONRDP_COMMIT}..."
    git init "${SRC_DIR}" >/dev/null
    git -C "${SRC_DIR}" remote add origin "${IRONRDP_REPO}"
  fi

  if ! git -C "${SRC_DIR}" cat-file -e "${IRONRDP_COMMIT}^{commit}" 2>/dev/null; then
    echo "Fetching pinned commit ${IRONRDP_COMMIT}..."
    git -C "${SRC_DIR}" fetch --depth 1 origin "${IRONRDP_COMMIT}"
  fi

  echo "Checking out clean ${IRONRDP_COMMIT}..."
  git -C "${SRC_DIR}" checkout --force --detach "${IRONRDP_COMMIT}"
  git -C "${SRC_DIR}" reset --hard "${IRONRDP_COMMIT}" >/dev/null
  git -C "${SRC_DIR}" clean -fd crates/ironrdp-web >/dev/null

  echo "Applying patches from ${PATCH_DIR}..."
  shopt -s nullglob
  local patches=("${PATCH_DIR}"/*.patch)
  shopt -u nullglob

  if [[ ${#patches[@]} -eq 0 ]]; then
    die "No patches found in ${PATCH_DIR}"
  fi

  for patch in "${patches[@]}"; do
    echo "  applying $(basename "${patch}")"
    git -C "${SRC_DIR}" apply --check "${patch}"
    git -C "${SRC_DIR}" apply "${patch}"
  done
}

run_host_tests() {
  if [[ "${SKIP_TESTS:-0}" == "1" ]]; then
    echo "Skipping host tests (SKIP_TESTS=1)"
    return
  fi

  echo "Running ironrdp-web host unit tests (session::tests)..."
  (
    cd "${SRC_DIR}"
    # Run host-compatible session unit tests (load_balance_info, audio/printer
    # channel attachment, RDCleanPath, file-transfer marshalling). Clipboard JS
    # bridge tests require wasm32 (`wasm-pack test --node --lib`).
    cargo test -p ironrdp-web --lib --locked session::tests
  )
}

build_wasm() {
  rm -rf "${STAGE_DIR}"
  mkdir -p "${STAGE_DIR}"

  echo "Building crates/ironrdp-web with wasm-pack..."
  # Note: disable wasm-pack's internal wasm-opt invocation via --no-opt and run
  # system wasm-opt (if available) with explicit SIMD + bulk-memory flags so
  # older bundled wasm-opt binaries never choke on modern LLVM WASM output.
  (
    cd "${SRC_DIR}/crates/ironrdp-web"
    RUSTFLAGS='-Ctarget-feature=+simd128,+bulk-memory --cfg getrandom_backend="wasm_js" -Copt-level=s -Ccodegen-units=1' \
      wasm-pack build \
      --target web \
      --release \
      --no-opt \
      --out-dir "${STAGE_DIR}" \
      --out-name ironrdp_web \
      -- --locked
  )

  if [[ "${SKIP_WASM_OPT:-0}" != "1" ]] && command -v wasm-opt >/dev/null 2>&1; then
    local wasm_file="${STAGE_DIR}/ironrdp_web_bg.wasm"
    local before_bytes after_bytes
    before_bytes="$(wc -c < "${wasm_file}" | tr -d ' ')"
    echo "Optimizing ironrdp_web_bg.wasm with wasm-opt -Os..."
    wasm-opt -Os \
      --enable-simd \
      --enable-bulk-memory \
      --enable-nontrapping-float-to-int \
      --enable-sign-ext \
      --enable-mutable-globals \
      --enable-reference-types \
      --enable-multivalue \
      "${wasm_file}" -o "${wasm_file}.opt"
    mv "${wasm_file}.opt" "${wasm_file}"
    after_bytes="$(wc -c < "${wasm_file}" | tr -d ' ')"
    echo "  wasm-opt: ${before_bytes} -> ${after_bytes} bytes"
  fi
}

package_output() {
  echo "Packaging self-contained ESM+WASM module into ${OUT_DIR}..."
  rm -rf "${OUT_DIR}"
  mkdir -p "${OUT_DIR}"

  cp "${STAGE_DIR}/ironrdp_web.js" "${OUT_DIR}/ironrdp_web.js"
  cp "${STAGE_DIR}/ironrdp_web.d.ts" "${OUT_DIR}/ironrdp_web.d.ts"
  cp "${STAGE_DIR}/ironrdp_web_bg.wasm" "${OUT_DIR}/ironrdp_web_bg.wasm"
  cp "${STAGE_DIR}/ironrdp_web_bg.wasm.d.ts" "${OUT_DIR}/ironrdp_web_bg.wasm.d.ts"

  cp "${SRC_DIR}/LICENSE-MIT" "${OUT_DIR}/LICENSE-MIT"
  cp "${SRC_DIR}/LICENSE-APACHE" "${OUT_DIR}/LICENSE-APACHE"

  cat > "${OUT_DIR}/package.json" <<EOF
{
  "name": "@netcatty/ironrdp-wasm",
  "version": "0.1.0-ironrdp.${IRONRDP_SHORT}",
  "private": true,
  "description": "Self-contained patched IronRDP WebAssembly build for Netcatty (Devolutions/IronRDP)",
  "license": "MIT OR Apache-2.0",
  "type": "module",
  "main": "./ironrdp_web.js",
  "module": "./ironrdp_web.js",
  "types": "./ironrdp_web.d.ts",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./ironrdp_web.d.ts",
      "import": "./ironrdp_web.js"
    },
    "./ironrdp_web_bg.wasm": "./ironrdp_web_bg.wasm"
  },
  "files": [
    "ironrdp_web.js",
    "ironrdp_web.d.ts",
    "ironrdp_web_bg.wasm",
    "ironrdp_web_bg.wasm.d.ts",
    "LICENSE-MIT",
    "LICENSE-APACHE",
    "README.md"
  ],
  "ironrdp": {
    "repository": "https://github.com/Devolutions/IronRDP",
    "commit": "${IRONRDP_COMMIT}",
    "patches": [
      "0001-session-responsiveness.patch",
      "0002-load-balance-info-and-shell.patch"
    ]
  }
}
EOF

  cat > "${OUT_DIR}/README.md" <<EOF
# @netcatty/ironrdp-wasm

Self-contained WebAssembly build of [Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) \`crates/ironrdp-web\` for Netcatty's built-in RDP client.

- **Upstream commit:** \`${IRONRDP_COMMIT}\`
- **License:** \`MIT OR Apache-2.0\` (see \`LICENSE-MIT\` and \`LICENSE-APACHE\`)
- **Patches applied** (under \`scripts/ironrdp-web-patches/\`):
  1. \`0001-session-responsiveness.patch\` — 16ms dirty-rectangle coalescing (\`PaintTicker\`) and cooperative event-loop yielding every 16 frames so rapid screen updates do not starve DOM keyboard/mouse input.
  2. \`0002-load-balance-info-and-shell.patch\` — Exposes \`load_balance_info\`, \`alternate_shell\`, and \`work_dir\` extensions on \`SessionBuilder\` for JumpServer Razor and RDS Connection Broker routing.

## Rebuilding

\`\`\`bash
./scripts/build-ironrdp-wasm.sh
\`\`\`
EOF

  echo ""
  echo "Built @netcatty/ironrdp-wasm successfully:"
  ls -lh "${OUT_DIR}"
}

main() {
  check_toolchain
  prepare_source
  resolve_ironrdp_toolchain
  run_host_tests
  build_wasm
  package_output
}

main "$@"
