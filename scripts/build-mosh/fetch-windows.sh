#!/usr/bin/env bash
# Source: pin the last known-good Windows mosh bundle built by Netcatty's
# Cygwin workflow. The bundle carries mosh-client.exe, runtime DLLs, and the
# xterm-256color terminfo entry needed by packaged Windows builds.
#
# Keep the old FluentTerminal standalone exe as a release fallback. It is
# PE32+ x86-64 with no cygwin1.dll dependency. FluentTerminal is GPL-3.0, same
# license as Netcatty, and the binary itself is GPL-3.0 from upstream
# mobile-shell/mosh.
#
# Inputs (env): OUT_DIR
# Output:       $OUT_DIR/mosh-client-win32-x64.tar.gz (+ .sha256)
#               $OUT_DIR/mosh-client-win32-x64.exe (+ .sha256 fallback)
set -euo pipefail

: "${OUT_DIR:?missing OUT_DIR}"

WINDOWS_BUNDLE_URL="${WINDOWS_BUNDLE_URL:-https://github.com/binaricat/Netcatty-mosh-bin/releases/download/mosh-bin-1.4.0-2/mosh-client-win32-x64.tar.gz}"
WINDOWS_BUNDLE_SHA256="${WINDOWS_BUNDLE_SHA256:-3d4c4ae9fc8026dc8f4972856b9dedfb5e67fc623f2c23133c83b24c08bc1b2f}"

# Fallback pin: github.com/felixse/FluentTerminal commit bad0f85,
# Dependencies/MoshExecutables/x64/mosh-client.exe.
LEGACY_SOURCE_URL="${LEGACY_SOURCE_URL:-https://raw.githubusercontent.com/felixse/FluentTerminal/bad0f85/Dependencies/MoshExecutables/x64/mosh-client.exe}"
LEGACY_EXPECTED_SHA256="${LEGACY_EXPECTED_SHA256:-5a8d84ff205c6a0711e53b961f909484a892f42648807e52d46d4fa93c05e286}"

check_sha256() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual=$(sha256sum "$file" | awk '{print $1}')

  if [ "$actual" != "$expected" ]; then
    echo "ERROR: SHA256 mismatch for $label" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  printf '%s' "$actual"
}

mkdir -p "$OUT_DIR"

BUNDLE_OUT="$OUT_DIR/mosh-client-win32-x64.tar.gz"
LEGACY_OUT="$OUT_DIR/mosh-client-win32-x64.exe"

curl -fsSL "$WINDOWS_BUNDLE_URL" -o "$BUNDLE_OUT"
BUNDLE_ACTUAL=$(check_sha256 "$BUNDLE_OUT" "$WINDOWS_BUNDLE_SHA256" "mosh-client-win32-x64.tar.gz")

echo "Fetched mosh-client-win32-x64.tar.gz (sha256=$BUNDLE_ACTUAL)."
ls -lh "$BUNDLE_OUT"
echo "$BUNDLE_ACTUAL  mosh-client-win32-x64.tar.gz" > "$BUNDLE_OUT.sha256"
cat "$BUNDLE_OUT.sha256"

curl -fsSL "$LEGACY_SOURCE_URL" -o "$LEGACY_OUT"
LEGACY_ACTUAL=$(check_sha256 "$LEGACY_OUT" "$LEGACY_EXPECTED_SHA256" "mosh-client.exe")

echo "Fetched fallback mosh-client.exe (sha256=$LEGACY_ACTUAL)."
ls -lh "$LEGACY_OUT"
echo "$LEGACY_ACTUAL  mosh-client-win32-x64.exe" > "$LEGACY_OUT.sha256"
cat "$LEGACY_OUT.sha256"
