#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <prepare|verify> <x64|arm64>" >&2
  exit 1
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

electron_bin() {
  echo "./node_modules/.bin/electron"
}

log_file_info() {
  local file="$1"
  echo "[node-pty] file: ${file}"
  ls -lh "${file}"
  checksum "${file}"
}

log_electron_runtime_info() {
  ELECTRON_RUN_AS_NODE=1 "$(electron_bin)" -e '
    console.log(`[node-pty] electron=${process.versions.electron || "unknown"} node=${process.versions.node} modules=${process.versions.modules}`);
  '
}

assert_loadable_native_module() {
  local file="$1"
  echo "[node-pty] loading native module with Electron runtime: ${file}"
  ELECTRON_RUN_AS_NODE=1 "$(electron_bin)" -e '
    require(process.argv[1]);
    console.log("[node-pty] native module loaded successfully");
  ' "${file}"
}

prepare() {
  local arch="$1"
  local root="node_modules/node-pty"
  local release_dir="${root}/build/Release"
  local prebuild_dir="${root}/prebuilds/linux-${arch}"

  echo "[node-pty] rebuilding native modules for Electron on linux-${arch}"
  log_electron_runtime_info
  npm run rebuild

  test -f "${release_dir}/pty.node"
  test -f "${release_dir}/spawn-helper"
  test -x "${release_dir}/spawn-helper"

  echo "[node-pty] built Linux runtime artifacts:"
  log_file_info "${release_dir}/pty.node"
  log_file_info "${release_dir}/spawn-helper"
  assert_loadable_native_module "${release_dir}/pty.node"

  mkdir -p "${prebuild_dir}"
  cp "${release_dir}/pty.node" "${prebuild_dir}/pty.node"
  cp "${release_dir}/spawn-helper" "${prebuild_dir}/spawn-helper"

  echo "[node-pty] mirrored Linux runtime artifacts into ${prebuild_dir}:"
  log_file_info "${prebuild_dir}/pty.node"
  log_file_info "${prebuild_dir}/spawn-helper"
}

verify() {
  local arch="$1"
  local release_dir
  local prebuild_dir

  log_electron_runtime_info

  release_dir="$(find release -type d -path "*/resources/app.asar.unpacked/node_modules/node-pty/build/Release" -print -quit)"
  prebuild_dir="$(find release -type d -path "*/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-${arch}" -print -quit)"

  if [[ -z "${release_dir}" ]]; then
    echo "[node-pty] packaged build/Release directory not found under release/" >&2
    exit 1
  fi

  if [[ -z "${prebuild_dir}" ]]; then
    echo "[node-pty] packaged prebuild directory not found for linux-${arch} under release/" >&2
    exit 1
  fi

  test -f "${release_dir}/pty.node"
  test -f "${release_dir}/spawn-helper"
  test -f "${prebuild_dir}/pty.node"
  test -f "${prebuild_dir}/spawn-helper"
  test -x "${release_dir}/spawn-helper"
  test -x "${prebuild_dir}/spawn-helper"

  echo "[node-pty] packaged build/Release artifacts:"
  log_file_info "${release_dir}/pty.node"
  log_file_info "${release_dir}/spawn-helper"
  assert_loadable_native_module "${release_dir}/pty.node"

  echo "[node-pty] packaged prebuild artifacts:"
  log_file_info "${prebuild_dir}/pty.node"
  log_file_info "${prebuild_dir}/spawn-helper"
  assert_loadable_native_module "${prebuild_dir}/pty.node"

  echo "[node-pty] packaged artifact locations:"
  find release -path "*/resources/app.asar.unpacked/node_modules/node-pty/*" \
    \( -name 'pty.node' -o -name 'spawn-helper' \) \
    -print | sort
}

main() {
  if [[ $# -ne 2 ]]; then
    usage
  fi

  case "$1" in
    prepare)
      prepare "$2"
      ;;
    verify)
      verify "$2"
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
