#!/usr/bin/env bash
# Build a portable mosh-client binary inside manylinux2014.
#
# Inputs (env):
#   MOSH_REF  — git ref of mobile-shell/mosh to build (e.g. mosh-1.4.0)
#   ARCH      — x64 | arm64 (for output naming only; container is already that arch)
#   OUT_DIR   — directory to write mosh-client-linux-<arch>.tar.gz + sha256
#
# Output:
#   $OUT_DIR/mosh-client-linux-<arch>.tar.gz       (binary + terminfo bundle)
#   $OUT_DIR/mosh-client-linux-<arch>.tar.gz.sha256
#
# The bundle ships a private terminfo database next to the binary because
# our statically-linked ncurses has its compiled-in TERMINFO path pointing
# at the build-time prefix (a temp dir). Without bundling, mosh-client on
# distros lacking /usr/share/terminfo (or stripped containers) fails with
# "Terminfo database could not be found." See issue #890.
#
# Strategy: build OpenSSL, protobuf, ncurses as static archives in a
# scratch prefix, then build mosh against those and link libstdc++/libgcc
# statically. The resulting binary still depends on standard Linux system
# libraries such as glibc/libz/libutil from the manylinux2014 baseline
# (compatible with virtually every distro released since 2014, including
# Debian 9+, Ubuntu 18.04+, CentOS 7+).
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

OPENSSL_VER=3.0.13
PROTOBUF_VER=21.12
NCURSES_VER=6.4

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX/lib" "$PREFIX/include" "$OUT_DIR"

yum install -y -q autoconf automake libtool perl perl-IPC-Cmd make gcc gcc-c++ pkgconfig zlib-devel

cd "$WORK"

# OpenSSL static
curl -fsSL "https://www.openssl.org/source/openssl-$OPENSSL_VER.tar.gz" | tar xz
( cd "openssl-$OPENSSL_VER"
  ./config no-shared no-tests --prefix="$PREFIX" --openssldir="$PREFIX/ssl"
  make -j"$(nproc)"
  make install_sw )

# protobuf static (3.x stays compatible with mosh's generated proto code)
curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOBUF_VER/protobuf-cpp-3.$PROTOBUF_VER.tar.gz" | tar xz
( cd "protobuf-3.$PROTOBUF_VER"
  ./configure --prefix="$PREFIX" --enable-static --disable-shared --with-pic
  make -j"$(nproc)"
  make install )

# ncurses static
curl -fsSL "https://invisible-island.net/archives/ncurses/ncurses-$NCURSES_VER.tar.gz" | tar xz
( cd "ncurses-$NCURSES_VER"
  CFLAGS="-fPIC -O2" CXXFLAGS="-fPIC -O2" \
  ./configure --prefix="$PREFIX" --without-shared --without-debug --without-cxx-shared --without-tests --disable-pc-files --enable-widec
  make -j"$(nproc)"
  make install )

# Mosh. Fetch the requested ref explicitly so branch names, tags, and commit
# SHAs all work from workflow_dispatch.
git init mosh
git -C mosh remote add origin https://github.com/mobile-shell/mosh.git
git -C mosh fetch --depth 1 origin "$MOSH_REF"
git -C mosh checkout --detach FETCH_HEAD
( cd mosh
  export PATH="$PREFIX/bin:$PATH"
  ./autogen.sh
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig" \
  ./configure --enable-completion=no --disable-server \
    CPPFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw" \
    CXXFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw -O2" \
    CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw -O2" \
    LDFLAGS="-L$PREFIX/lib -L$PREFIX/lib64 -static-libstdc++ -static-libgcc" \
    LIBS="-ldl -lpthread"
  make -j"$(nproc)" )

BUNDLE_DIR="$WORK/linux-$ARCH-bundle"
mkdir -p "$BUNDLE_DIR"
OUT_BIN="$BUNDLE_DIR/mosh-client"
cp mosh/src/frontend/mosh-client "$OUT_BIN"
strip "$OUT_BIN"

echo "--- file ---"
file "$OUT_BIN"
echo "--- ldd ---"
ldd "$OUT_BIN" || true
echo "--- size ---"
ls -lh "$OUT_BIN"

# Sanity check: must not link any non-system shared libraries. Allow only
# the glibc runtime family and the ELF loader.
ldd "$OUT_BIN" > "$WORK/ldd.txt" || true
awk '
  /=>/ { print $1; next }
  /^[[:space:]]*\/.*ld-linux/ { print $1; next }
' "$WORK/ldd.txt" > "$WORK/deps.txt"
if grep -Ev '^(linux-vdso\.so\.1|lib(c|m|pthread|rt|dl|resolv|util|z)\.so\.[0-9]+|/lib.*/ld-linux.*\.so\.[0-9]+|ld-linux.*\.so\.[0-9]+)$' "$WORK/deps.txt"; then
  echo "ERROR: mosh-client links a non-system shared library; static linking failed." >&2
  exit 1
fi

# Bundle the terminfo entries our statically-linked ncurses needs. The
# ncurses `make install` above populated $PREFIX/share/terminfo/ with the
# full upstream terminfo.src. Ship a curated subset so users hit a
# working entry regardless of TERM.
TERMINFO_SRC="$PREFIX/share/terminfo"
TERMINFO_OUT="$BUNDLE_DIR/terminfo"
mkdir -p "$TERMINFO_OUT"
copy_terminfo_entry() {
  local name="$1"
  for src in "$TERMINFO_SRC"/?/"$name" "$TERMINFO_SRC"/??/"$name"; do
    [ -f "$src" ] || continue
    local rel
    rel=$(basename "$(dirname "$src")")
    mkdir -p "$TERMINFO_OUT/$rel"
    cp "$src" "$TERMINFO_OUT/$rel/$name"
    return 0
  done
  return 1
}
for entry in xterm-256color xterm xterm-color vt100 vt220 ansi screen screen-256color tmux tmux-256color dumb linux; do
  copy_terminfo_entry "$entry" || echo "WARN: terminfo entry $entry not found in $TERMINFO_SRC" >&2
done
if [ ! -f "$TERMINFO_OUT/x/xterm-256color" ] && [ ! -f "$TERMINFO_OUT/78/xterm-256color" ]; then
  echo "ERROR: failed to bundle xterm-256color terminfo for mosh-client (linux-$ARCH)." >&2
  exit 1
fi

echo "--- bundled terminfo ---"
find "$TERMINFO_OUT" -type f -print

BUNDLE_TGZ="$OUT_DIR/mosh-client-linux-$ARCH.tar.gz"
( cd "$BUNDLE_DIR" && tar -czf "$BUNDLE_TGZ" "mosh-client" "terminfo" )

( cd "$OUT_DIR" && sha256sum "mosh-client-linux-$ARCH.tar.gz" > "mosh-client-linux-$ARCH.tar.gz.sha256" )
cat "$OUT_DIR/mosh-client-linux-$ARCH.tar.gz.sha256"
