#!/usr/bin/env bash
# Build mosh-client.exe from upstream mobile-shell/mosh source inside a
# Cygwin environment. Phase 1 pinned a third-party prebuilt
# (FluentTerminal); this rebuilds it in CI so we own the provenance
# end-to-end and ship the same upstream version everywhere.
#
# Cygwin doesn't make full static linking practical (cygwin1.dll
# implements the POSIX runtime; it must be present at runtime), so we
# bundle every required Cygwin DLL alongside `mosh-client.exe`. This
# keeps the binary reproducible and self-contained — the only
# environmental requirement is the Cygwin Project's GPL-3.0 DLLs, all
# of which we redistribute under their respective licenses.
#
# Inputs (env):
#   MOSH_REF — git ref of mobile-shell/mosh (e.g. mosh-1.4.0)
#   ARCH     — x64 (only — Cygwin's arm64 port isn't release-ready)
#   OUT_DIR  — directory to write mosh-client-win32-<arch>.exe + DLL bundle
#
# Output:
#   $OUT_DIR/mosh-client-win32-<arch>.exe
#   $OUT_DIR/mosh-client-win32-<arch>-dlls/*.dll
#   $OUT_DIR/mosh-client-win32-<arch>.sha256
#
# Expected to run inside a Cygwin bash login shell (set up by the CI's
# cygwin-install-action with development packages already installed).
set -euo pipefail

: "${MOSH_REF:?missing MOSH_REF}"
: "${ARCH:?missing ARCH}"
: "${OUT_DIR:?missing OUT_DIR}"

validate_mosh_ref() {
  if [[ ! "$MOSH_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
    || [[ "$MOSH_REF" == *..* ]] \
    || [[ "$MOSH_REF" == *@\{* ]] \
    || [[ "$MOSH_REF" == */ ]] \
    || [[ "$MOSH_REF" == *.lock ]]; then
    echo "ERROR: invalid MOSH_REF: $MOSH_REF" >&2
    exit 1
  fi
}
validate_mosh_ref

if [ "$ARCH" != "x64" ]; then
  echo "ERROR: only ARCH=x64 supported by the Cygwin Windows build (got: $ARCH)." >&2
  exit 1
fi

# Sanity: must run under Cygwin so we have access to cygcheck and the
# Cygwin gcc toolchain.
if ! uname -a | grep -qi CYGWIN; then
  echo "ERROR: build-windows.sh must run inside a Cygwin shell." >&2
  uname -a >&2
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

cd "$WORK"

# Build mosh against the Cygwin-supplied OpenSSL, protobuf, ncurses.
# Static linking against those is not supported by the upstream
# build for Cygwin, so we accept the dynamic deps and bundle the DLLs.
git init mosh
git -C mosh remote add origin https://github.com/mobile-shell/mosh.git
git -C mosh fetch --depth 1 origin "$MOSH_REF"
git -C mosh checkout --detach FETCH_HEAD
cd mosh
./autogen.sh
./configure --enable-completion=no --disable-server \
  CXXFLAGS="-O2 -static-libgcc -static-libstdc++" \
  LDFLAGS="-static-libgcc -static-libstdc++"
make -j"$(nproc)"

OUT_EXE="$OUT_DIR/mosh-client-win32-x64.exe"
DLL_DIR="$OUT_DIR/mosh-client-win32-x64-dlls"
mkdir -p "$DLL_DIR"
cp src/frontend/mosh-client.exe "$OUT_EXE"
strip "$OUT_EXE"

echo "--- file ---"
file "$OUT_EXE"
echo "--- size ---"
ls -lh "$OUT_EXE"

# Walk the import graph via cygcheck and copy every Cygwin-shipped DLL
# (paths that normalize to /usr/bin/) so the binary runs anywhere without
# an external Cygwin install.
echo "--- cygcheck ---"
CYGCHECK_OUT="$WORK/cygcheck.txt"
cygcheck "$OUT_EXE" | tee "$CYGCHECK_OUT"
bundled_count=0
while IFS= read -r line; do
  candidate=$(printf '%s' "$line" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  case "$candidate" in
    *.dll|*.DLL)
      # Convert Windows-style paths to Cygwin paths if present.
      cyg_candidate=$(cygpath -u "$candidate" 2>/dev/null || echo "$candidate")
      case "$cyg_candidate" in
        /usr/bin/*.dll|/usr/bin/*.DLL)
          if [ -f "$cyg_candidate" ]; then
            base=$(basename "$cyg_candidate")
            if [ ! -f "$DLL_DIR/$base" ]; then
              cp "$cyg_candidate" "$DLL_DIR/$base"
              echo "bundled DLL: $base"
              bundled_count=$((bundled_count + 1))
            fi
          fi
          ;;
      esac
      ;;
  esac
done < "$CYGCHECK_OUT"

if [ "$bundled_count" -eq 0 ] || [ ! -f "$DLL_DIR/cygwin1.dll" ]; then
  echo "ERROR: failed to bundle required Cygwin DLLs for mosh-client.exe." >&2
  exit 1
fi

echo "--- bundled DLLs ---"
ls -lh "$DLL_DIR"

# License: the Cygwin DLLs ship under various GPL-compatible licenses.
# Ship a top-level NOTICE so end users can see what we redistributed.
cat > "$DLL_DIR/README.txt" <<'EOF'
This directory bundles the Cygwin runtime DLLs required by
mosh-client.exe (built from https://github.com/mobile-shell/mosh ).

cygwin1.dll               : LGPL-3.0 (Cygwin Project, https://cygwin.com/)
cygcrypto-*.dll           : Apache-2.0 (OpenSSL Project, https://www.openssl.org/)
cygprotobuf-*.dll         : BSD-3-Clause (Google, https://github.com/protocolbuffers/protobuf)
cygncursesw-*.dll         : MIT-style (Free Software Foundation)
cygintl-*.dll             : LGPL-2.1 (GNU gettext)
cyggcc_s-*.dll, cygstdc++ : GPL-3.0 with GCC Runtime Library Exception

The full text of each license is reproduced in the upstream source
tree of the respective project.
EOF

# Bundle exe + DLLs into a single tar.gz artifact for distribution.
# fetch-mosh-binaries.cjs unpacks the tarball into the local
# resources/mosh/win32-x64/ directory.
BUNDLE_TGZ="$OUT_DIR/mosh-client-win32-x64.tar.gz"
BUNDLE_DIR="$WORK/win32-x64-bundle"
mkdir -p "$BUNDLE_DIR"
cp "$OUT_EXE" "$BUNDLE_DIR/mosh-client.exe"
cp -R "$DLL_DIR" "$BUNDLE_DIR/mosh-client-win32-x64-dlls"
( cd "$BUNDLE_DIR" && tar -czf "$BUNDLE_TGZ" \
  "mosh-client.exe" \
  "mosh-client-win32-x64-dlls" )

( cd "$OUT_DIR" && sha256sum "mosh-client-win32-x64.exe" > "mosh-client-win32-x64.sha256" )
( cd "$OUT_DIR" && sha256sum "mosh-client-win32-x64.tar.gz" > "mosh-client-win32-x64.tar.gz.sha256" )
cat "$OUT_DIR/mosh-client-win32-x64.sha256"
cat "$OUT_DIR/mosh-client-win32-x64.tar.gz.sha256"
