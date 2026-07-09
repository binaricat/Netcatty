#!/usr/bin/env bash
# Build a universal EternalTerminal `et` client on macOS (arm64 + x86_64).
#
# Inputs (env):
#   ET_REF   — git ref of MisterTea/EternalTerminal to build (e.g. et-v6.2.10)
#   OUT_DIR  — directory to write et-darwin-universal.tar.gz + sha256
#   MACOSX_DEPLOYMENT_TARGET — min macOS (default 11.0)
#
# Output:
#   $OUT_DIR/et-darwin-universal.tar.gz          (single universal `et`)
#   $OUT_DIR/et-darwin-universal.tar.gz.sha256
#
# Builds each arch separately (vcpkg arm64-osx / x64-osx static triplets) and
# lipo-combines the two `et` binaries. Links only macOS system dylibs.
set -euo pipefail

: "${ET_REF:?missing ET_REF}"
: "${OUT_DIR:?missing OUT_DIR}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

validate_et_ref() {
  if [[ ! "$ET_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
    || [[ "$ET_REF" == *..* ]] \
    || [[ "$ET_REF" == *@\{* ]] \
    || [[ "$ET_REF" == */ ]] \
    || [[ "$ET_REF" == *.lock ]]; then
    echo "ERROR: invalid ET_REF: $ET_REF" >&2
    exit 1
  fi
}
validate_et_ref

command -v ninja >/dev/null 2>&1 || brew install ninja
command -v cmake >/dev/null 2>&1 || brew install cmake
command -v autoconf >/dev/null 2>&1 || brew install automake autoconf libtool
NINJA_BIN=$(command -v ninja)

retry_command() {
  local attempt=1
  local max_attempts=4
  local delay=15
  until "$@"; do
    local status=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      return "$status"
    fi
    echo "WARN: command failed with exit $status; retrying in ${delay}s (attempt $((attempt + 1))/$max_attempts): $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

cd "$WORK"
git init et
git -C et remote add origin https://github.com/MisterTea/EternalTerminal.git
git -C et fetch --depth 1 origin "$ET_REF"
git -C et checkout --detach FETCH_HEAD
git -C et submodule update --init --recursive --depth 1

# Drop sentry-native from the vcpkg manifest — see build-linux.sh for the
# full rationale. -DDISABLE_TELEMETRY=ON means ET never references Sentry,
# yet vcpkg's manifest would otherwise force-build it (and crashpad) anyway.
if ! grep -q '"sentry-native"' "$WORK/et/vcpkg.json"; then
  echo "ERROR: sentry-native not in vcpkg.json (ET manifest changed?)" >&2; exit 1
fi
grep -v '"sentry-native"' "$WORK/et/vcpkg.json" > "$WORK/et/vcpkg.json.tmp"
mv "$WORK/et/vcpkg.json.tmp" "$WORK/et/vcpkg.json"

# Release-only vcpkg deps (skip the Debug pass) to halve build time, via
# overlay triplets that mirror the osx triplets but force release-only.
OVERLAY="$WORK/vcpkg-overlay-triplets"
mkdir -p "$OVERLAY"
for t in arm64-osx x64-osx; do
  src=$(find "$WORK/et/external/vcpkg/triplets" -name "$t.cmake" | head -1)
  [ -n "$src" ] || { echo "ERROR: vcpkg triplet $t.cmake not found" >&2; exit 1; }
  cp "$src" "$OVERLAY/$t.cmake"
  echo 'set(VCPKG_BUILD_TYPE release)' >> "$OVERLAY/$t.cmake"
done
export VCPKG_OVERLAY_TRIPLETS="$OVERLAY"

( cd et && ./external/vcpkg/bootstrap-vcpkg.sh -disableMetrics )

build_arch() {
  local arch="$1"       # arm64 | x86_64
  local triplet="$2"    # arm64-osx | x64-osx
  local build_dir="$WORK/build-$arch"
  echo "=== building et for $arch ($triplet) ===" >&2
  retry_command cmake -S "$WORK/et" -B "$build_dir" \
    -GNinja \
    -DCMAKE_MAKE_PROGRAM="$NINJA_BIN" \
    -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DDISABLE_TELEMETRY=ON \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DVCPKG_TARGET_TRIPLET="$triplet"
  cmake --build "$build_dir" --target et
  echo "$build_dir/et"
}

ARM_BIN=$(build_arch arm64 arm64-osx | tail -1)
X64_BIN=$(build_arch x86_64 x64-osx | tail -1)

BUNDLE_DIR="$WORK/darwin-universal-bundle"
mkdir -p "$BUNDLE_DIR"
OUT_BIN="$BUNDLE_DIR/et"
lipo -create -output "$OUT_BIN" "$ARM_BIN" "$X64_BIN"
strip "$OUT_BIN" || true

echo "--- lipo info ---"
lipo -info "$OUT_BIN"
echo "--- otool -L ---"
otool -L "$OUT_BIN" || true

# Sanity check: only macOS system dylibs (/usr/lib, /System/Library) allowed.
# A universal binary makes `otool -L` print a "<path> (architecture X):"
# header per slice; key off the "(compatibility version ...)" suffix that only
# real dependency lines carry, so those per-arch headers aren't misread as a
# non-system dylib (tail -n +2 only drops the first one).
if otool -L "$OUT_BIN" | awk '/\(compatibility version/ {print $1}' \
   | grep -Ev '^(/usr/lib/|/System/Library/)' | grep -q .; then
  echo "ERROR: et links a non-system dylib; static linking failed." >&2
  otool -L "$OUT_BIN" >&2
  exit 1
fi

BUNDLE_TGZ="$OUT_DIR/et-darwin-universal.tar.gz"
( cd "$BUNDLE_DIR" && tar -czf "$BUNDLE_TGZ" "et" )
( cd "$OUT_DIR" && shasum -a 256 "et-darwin-universal.tar.gz" > "et-darwin-universal.tar.gz.sha256" )
cat "$OUT_DIR/et-darwin-universal.tar.gz.sha256"
