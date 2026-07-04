#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <x86_64|aarch64> [rpm-file]" >&2
  exit 1
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

require_cmd() {
  local cmd="$1"
  command -v "${cmd}" >/dev/null 2>&1 || {
    echo "[rpm-verify] missing required command: ${cmd}" >&2
    exit 1
  }
}

assert_exists() {
  local file="$1"
  if [[ ! -e "${file}" ]]; then
    echo "[rpm-verify] expected file does not exist: ${file}" >&2
    exit 1
  fi
}

log_file_info() {
  local file="$1"
  echo "[rpm-verify] file: ${file}"
  ls -lh "${file}"
  file "${file}"
  checksum "${file}"
}

resolve_file_from_glob() {
  local search_dir="$1"
  local pattern="$2"
  find "${search_dir}" -maxdepth 1 -type f -name "${pattern}" -print | sort | head -n 1
}

resolve_single_file() {
  local search_dir="$1"
  local pattern="$2"
  local file

  file="$(resolve_file_from_glob "${search_dir}" "${pattern}")"
  if [[ -z "${file}" ]]; then
    echo "[rpm-verify] no file matched ${pattern} under ${search_dir}" >&2
    exit 1
  fi

  echo "${file}"
}

assert_file_arch() {
  local file="$1"
  local expected="$2"
  local actual

  actual="$(rpm -qp --qf '%{ARCH}' "${file}")"
  echo "[rpm-verify] rpm metadata architecture: ${actual}"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "[rpm-verify] RPM metadata architecture mismatch for ${file}" >&2
    echo "[rpm-verify] expected: ${expected}" >&2
    echo "[rpm-verify] actual: ${actual}" >&2
    exit 1
  fi
}

assert_manifest_has_no_matches() {
  local manifest="$1"
  local pattern="$2"
  local description="$3"
  local matches

  matches="$(printf "%s\n" "${manifest}" | grep -E "${pattern}" || true)"
  if [[ -n "${matches}" ]]; then
    echo "[rpm-verify] unexpected ${description} in RPM file list:" >&2
    printf "%s\n" "${matches}" | head -n 20 >&2
    exit 1
  fi
}

main() {
  if [[ $# -lt 1 || $# -gt 2 ]]; then
    usage
  fi

  local rpm_arch="$1"
  local rpm_file
  local rpm_pattern
  local manifest

  require_cmd bsdtar
  require_cmd file
  require_cmd rpm

  case "${rpm_arch}" in
    x86_64|aarch64)
      rpm_pattern="*-linux-${rpm_arch}.rpm"
      ;;
    *)
      usage
      ;;
  esac

  if [[ $# -eq 2 ]]; then
    rpm_file="$2"
    assert_exists "${rpm_file}"
  else
    rpm_file="$(resolve_single_file "release" "${rpm_pattern}")"
  fi

  echo "[rpm-verify] verifying rpm artifact: ${rpm_file}"
  log_file_info "${rpm_file}"
  assert_file_arch "${rpm_file}" "${rpm_arch}"

  manifest="$(bsdtar -tf "${rpm_file}")"
  if [[ -z "${manifest}" ]]; then
    echo "[rpm-verify] RPM file list is empty or unreadable: ${rpm_file}" >&2
    exit 1
  fi

  assert_manifest_has_no_matches \
    "${manifest}" \
    '^(\./)?usr/lib/\.build-id(/|$)' \
    "/usr/lib/.build-id entries"

  assert_manifest_has_no_matches \
    "${manifest}" \
    '(^|/)lib(ggml|ggml-base|transcribe)\.so([./0-9A-Za-z_-]*|$)' \
    "libggml/libtranscribe entries"

  echo "[rpm-verify] rpm artifact verification passed for ${rpm_file}"
}

main "$@"
