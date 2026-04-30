#!/usr/bin/env bash
# Build a universal2 (arm64 + x86_64) mosh-client for macOS.
#
# Inputs (env):
#   MOSH_REF                  — git ref of mobile-shell/mosh
#   OUT_DIR                   — destination directory
#   MACOSX_DEPLOYMENT_TARGET  — minimum macOS version (default 11.0)
#
# Output:
#   $OUT_DIR/mosh-client-darwin-universal
#   $OUT_DIR/mosh-client-darwin-universal.sha256
#
# Strategy: build OpenSSL/protobuf/ncurses for arm64 and x86_64
# (cross-compile via Apple clang's -arch flag), link mosh-client per arch,
# then lipo the two single-arch binaries into one universal binary. The
# final binary is allowed to depend only on macOS system dylibs.
set -euo pipefail

: "${MOSH_REF:?missing MOSH_REF}"
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

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

OPENSSL_VER=3.0.13
PROTOBUF_VER=21.12
NCURSES_VER=6.4

# Install build tools when they are not already present on the runner.
brew list autoconf >/dev/null 2>&1 || brew install autoconf
brew list automake >/dev/null 2>&1 || brew install automake
brew list pkg-config >/dev/null 2>&1 || brew install pkg-config
brew list libtool >/dev/null 2>&1 || brew install libtool

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"
NATIVE_PROTOC_DIR=""

# Pre-fetch sources once.
cd "$WORK"
curl -fsSL "https://www.openssl.org/source/openssl-$OPENSSL_VER.tar.gz" -o openssl.tgz
curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v$PROTOBUF_VER/protobuf-cpp-3.$PROTOBUF_VER.tar.gz" -o protobuf.tgz
curl -fsSL "https://invisible-island.net/archives/ncurses/ncurses-$NCURSES_VER.tar.gz" -o ncurses.tgz
git init mosh-src
git -C mosh-src remote add origin https://github.com/mobile-shell/mosh.git
git -C mosh-src fetch --depth 1 origin "$MOSH_REF"
git -C mosh-src checkout --detach FETCH_HEAD

build_arch() {
  local ARCH="$1"
  local TRIPLE
  case "$ARCH" in
    arm64)  TRIPLE=aarch64-apple-darwin ;;
    x86_64) TRIPLE=x86_64-apple-darwin ;;
    *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
  esac

  local PREFIX="$WORK/prefix-$ARCH"
  mkdir -p "$PREFIX"

  local CFLAGS_COMMON="-arch $ARCH -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -O2"
  local LDFLAGS_COMMON="-arch $ARCH -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"

  # OpenSSL
  rm -rf "openssl-$OPENSSL_VER"
  tar xf openssl.tgz
  ( cd "openssl-$OPENSSL_VER"
    if [ "$ARCH" = "arm64" ]; then
      ./Configure darwin64-arm64-cc no-shared no-tests --prefix="$PREFIX" --openssldir="$PREFIX/ssl" -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET
    else
      ./Configure darwin64-x86_64-cc no-shared no-tests --prefix="$PREFIX" --openssldir="$PREFIX/ssl" -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET
    fi
    make -j"$(sysctl -n hw.ncpu)"
    make install_sw )

  # protobuf
  rm -rf "protobuf-3.$PROTOBUF_VER"
  tar xf protobuf.tgz
  ( cd "protobuf-3.$PROTOBUF_VER"
    ./configure --prefix="$PREFIX" --enable-static --disable-shared --with-pic --host="$TRIPLE" \
      CXX="clang++" CC="clang" \
      CFLAGS="$CFLAGS_COMMON" CXXFLAGS="$CFLAGS_COMMON" LDFLAGS="$LDFLAGS_COMMON"
    # protoc must run on the host (not the cross-target) — but here host arch is one of the two,
    # so this works directly when ARCH matches the runner. For the *other* arch we reuse the
    # protoc compiled in the first pass via PATH.
    make -j"$(sysctl -n hw.ncpu)" || make -j1
    make install )
  if [ "$ARCH" = "$NATIVE_ARCH" ]; then
    NATIVE_PROTOC_DIR="$PREFIX/bin"
  fi

  # ncurses
  rm -rf "ncurses-$NCURSES_VER"
  tar xf ncurses.tgz
  ( cd "ncurses-$NCURSES_VER"
    ./configure --prefix="$PREFIX" --without-shared --without-debug --without-cxx-shared --without-tests --disable-pc-files --enable-widec --host="$TRIPLE" \
      CC="clang" CXX="clang++" \
      CFLAGS="$CFLAGS_COMMON" CXXFLAGS="$CFLAGS_COMMON" LDFLAGS="$LDFLAGS_COMMON"
    make -j"$(sysctl -n hw.ncpu)"
    make -C include install
    make -C ncurses install )

  # mosh per-arch build
  ( cd mosh-src
    make distclean >/dev/null 2>&1 || true
    export PATH="${NATIVE_PROTOC_DIR:-$PREFIX/bin}:$PATH"
    ./autogen.sh
    PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" \
    ./configure --enable-completion=no --disable-server --host="$TRIPLE" \
      CXX="clang++" CC="clang" \
      CPPFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw" \
      CXXFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw $CFLAGS_COMMON" \
      CFLAGS="-I$PREFIX/include -I$PREFIX/include/ncursesw $CFLAGS_COMMON" \
      LDFLAGS="-L$PREFIX/lib $LDFLAGS_COMMON"
    make -j"$(sysctl -n hw.ncpu)"
    cp src/frontend/mosh-client "$WORK/mosh-client-$ARCH" )
}

# Build host arch first so the first protobuf pass can use a native protoc.
NATIVE_ARCH=$(uname -m)
if [ "$NATIVE_ARCH" = "arm64" ]; then
  build_arch arm64
  build_arch x86_64
else
  build_arch x86_64
  build_arch arm64
fi

OUT_BIN="$OUT_DIR/mosh-client-darwin-universal"
lipo -create "$WORK/mosh-client-arm64" "$WORK/mosh-client-x86_64" -output "$OUT_BIN"
strip -x "$OUT_BIN" || true

echo "--- file ---"
file "$OUT_BIN"
echo "--- otool -L ---"
otool -L "$OUT_BIN"
echo "--- lipo -info ---"
lipo -info "$OUT_BIN"
echo "--- size ---"
ls -lh "$OUT_BIN"

# Sanity check: must not depend on non-system dylibs.
if otool -L "$OUT_BIN" | tail -n +2 | awk '{print $1}' | grep -Ev "^(/usr/lib/|/System/)"; then
  echo "ERROR: mosh-client links a non-system dylib; static linking failed." >&2
  exit 1
fi

( cd "$OUT_DIR" && shasum -a 256 "mosh-client-darwin-universal" > "mosh-client-darwin-universal.sha256" )
cat "$OUT_DIR/mosh-client-darwin-universal.sha256"
