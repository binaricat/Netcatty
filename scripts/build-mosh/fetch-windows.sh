#!/usr/bin/env bash
# Phase-1 source: pin to the FluentTerminal-shipped mosh-cygwin standalone
# build (PE32+ x86-64, statically linked Cygwin runtime, no cygwin1.dll
# dependency). FluentTerminal is GPL-3.0 — same license as netcatty —
# and the binary itself is GPL-3.0 from upstream mobile-shell/mosh.
#
# Phase-2 replaced this fetch with an in-CI Cygwin build from upstream
# source so we own the provenance end-to-end.
#
# The pinned commit is FluentTerminal master @ bad0f85 (2019-09-12), which
# is the commit where the prebuilt mosh-client.exe was added to the repo.
# Verifying SHA256 against a frozen value protects against silent updates.
#
# Inputs (env): OUT_DIR
# Output:       $OUT_DIR/mosh-client-win32-x64.exe (+ .sha256)
set -euo pipefail

: "${OUT_DIR:?missing OUT_DIR}"

# Pin: github.com/felixse/FluentTerminal commit bad0f85,
# Dependencies/MoshExecutables/x64/mosh-client.exe.
SOURCE_URL="https://raw.githubusercontent.com/felixse/FluentTerminal/bad0f85/Dependencies/MoshExecutables/x64/mosh-client.exe"
EXPECTED_SHA256="5a8d84ff205c6a0711e53b961f909484a892f42648807e52d46d4fa93c05e286"

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/mosh-client-win32-x64.exe"

curl -fsSL "$SOURCE_URL" -o "$OUT"
ACTUAL=$(sha256sum "$OUT" | awk '{print $1}')

if [ "$ACTUAL" != "$EXPECTED_SHA256" ]; then
  echo "ERROR: SHA256 mismatch for mosh-client.exe" >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $ACTUAL"   >&2
  exit 1
fi

echo "Fetched mosh-client.exe (sha256=$ACTUAL)."
ls -lh "$OUT"
echo "$ACTUAL  mosh-client-win32-x64.exe" > "$OUT.sha256"
cat "$OUT.sha256"
