#!/usr/bin/env bash
# Build a portable EternalTerminal `et` client inside manylinux2014.
#
# Inputs (env):
#   ET_REF   — git ref of MisterTea/EternalTerminal to build (e.g. et-v6.2.10)
#   ARCH     — x64 | arm64 (for output naming only; container is already that arch)
#   OUT_DIR  — directory to write et-linux-<arch>.tar.gz + sha256
#
# Output:
#   $OUT_DIR/et-linux-<arch>.tar.gz          (single `et` client binary)
#   $OUT_DIR/et-linux-<arch>.tar.gz.sha256
#
# Strategy: build inside manylinux2014 (glibc 2.17) for broad distro
# compatibility. EternalTerminal vendors vcpkg under external/vcpkg and uses
# manifest mode, so its third-party deps (protobuf, libsodium, openssl, ...)
# are built as static archives by vcpkg's x64-linux / arm64-linux triplet.
# The resulting `et` still depends on baseline Linux system libraries
# (glibc family), compatible with virtually every distro since 2014.
#
# `et` is a pure network-transport client; it renders no terminal locally and
# needs no terminfo database, so the bundle ships only the binary.
set -euo pipefail

: "${ET_REF:?missing ET_REF}"
: "${ARCH:?missing ARCH}"
: "${OUT_DIR:?missing OUT_DIR}"

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

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

# manylinux2014 ships a devtoolset gcc and git, but an old cmake/ninja.
# Install modern cmake + ninja from PyPI (vcpkg requires cmake >= 3.x).
yum install -y -q zip unzip tar curl perl-IPC-Cmd >/dev/null 2>&1 || true

# manylinux ships CPython interpreters under /opt/python/<tag>/bin but puts
# none of them on PATH (a bare `python3` fails with 127). Prefer a known
# *stable* cpXY: picking "newest" would grab pre-release builds such as
# 3.15.0b1, which we don't want driving the cmake/ninja install.
if ! command -v python3 >/dev/null 2>&1; then
  for tag in cp313 cp312 cp311 cp310; do
    if [ -x "/opt/python/$tag-$tag/bin/python3" ]; then
      export PATH="/opt/python/$tag-$tag/bin:$PATH"
      break
    fi
  done
fi
command -v python3 >/dev/null 2>&1 \
  || { echo "ERROR: no stable python3 under /opt/python (manylinux layout changed?)" >&2; exit 1; }

python3 -m pip install --quiet --upgrade pip
# Pin cmake < 4: ET's pinned vcpkg baseline and some ports don't configure
# cleanly under cmake 4.x. ninja is unconstrained.
python3 -m pip install --quiet "cmake>=3.25,<4" ninja
export PATH="$(python3 -c 'import sysconfig,os;print(os.path.join(sysconfig.get_path("scripts")))'):$PATH"
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

cd "$WORK"

# Fetch EternalTerminal at the requested ref, with the vendored vcpkg
# submodule. Branch names, tags, and commit SHAs all work.
git init et
git -C et remote add origin https://github.com/MisterTea/EternalTerminal.git
git -C et fetch --depth 1 origin "$ET_REF"
git -C et checkout --detach FETCH_HEAD
git -C et submodule update --init --recursive --depth 1

# Drop sentry-native from the vcpkg manifest. We build with
# -DDISABLE_TELEMETRY=ON, so ET's CMake never calls find_package(sentry) nor
# links it; but vcpkg's manifest mode still force-builds every listed dep
# during configure. sentry-native pulls in crashpad, is the heaviest dep, and
# fails to build on arm64-linux — dropping it fixes arm64 and speeds up all.
if ! grep -q '"sentry-native"' "$WORK/et/vcpkg.json"; then
  echo "ERROR: sentry-native not in vcpkg.json (ET manifest changed?)" >&2; exit 1
fi
grep -v '"sentry-native"' "$WORK/et/vcpkg.json" > "$WORK/et/vcpkg.json.tmp"
mv "$WORK/et/vcpkg.json.tmp" "$WORK/et/vcpkg.json"

# Build only the Release halves of the vcpkg deps (skip the Debug pass) to
# roughly halve build time. Overlay triplets mirror ET's chosen community
# triplet but force release-only; selected via VCPKG_OVERLAY_TRIPLETS so the
# vendored vcpkg tree stays untouched.
OVERLAY="$WORK/vcpkg-overlay-triplets"
mkdir -p "$OVERLAY"
for t in x64-linux arm64-linux; do
  src=$(find "$WORK/et/external/vcpkg/triplets" -name "$t.cmake" | head -1)
  [ -n "$src" ] || { echo "ERROR: vcpkg triplet $t.cmake not found" >&2; exit 1; }
  cp "$src" "$OVERLAY/$t.cmake"
  echo 'set(VCPKG_BUILD_TYPE release)' >> "$OVERLAY/$t.cmake"
done
export VCPKG_OVERLAY_TRIPLETS="$OVERLAY"

# Bootstrap the vendored vcpkg so CMake's vcpkg toolchain can resolve the
# manifest deps.
( cd et && ./external/vcpkg/bootstrap-vcpkg.sh -disableMetrics )

BUILD_DIR="$WORK/et/build"
# ET's CMake sets its own vcpkg toolchain + triplet (auto-detected from
# uname -m); we supply only the generator + build type. DISABLE_TELEMETRY=ON
# keeps ET from using Sentry, matching the manifest edit above.
#
# CMAKE_CXX_STANDARD_LIBRARIES=-lanl: ET (via cpp-httplib) references glibc's
# async DNS resolver getaddrinfo_a / gai_* (which live in libanl), but ET's
# link line omits -lanl, so linking `et` fails with "undefined reference to
# getaddrinfo_a". STANDARD_LIBRARIES is appended after all other libraries —
# exactly where the linker needs it to resolve those symbols.
retry_command cmake -S "$WORK/et" -B "$BUILD_DIR" \
  -GNinja \
  -DCMAKE_MAKE_PROGRAM="$NINJA_BIN" \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DDISABLE_TELEMETRY=ON \
  -DCMAKE_CXX_STANDARD_LIBRARIES=-lanl

cmake --build "$BUILD_DIR" --target et

BUNDLE_DIR="$WORK/linux-$ARCH-bundle"
mkdir -p "$BUNDLE_DIR"
OUT_BIN="$BUNDLE_DIR/et"
cp "$BUILD_DIR/et" "$OUT_BIN"
strip "$OUT_BIN"

echo "--- file ---"
file "$OUT_BIN"
echo "--- ldd ---"
ldd "$OUT_BIN" || true
echo "--- size ---"
ls -lh "$OUT_BIN"

# Sanity check: must not link any non-system shared libraries. Allow only the
# glibc runtime family and the ELF loader (matches the mosh build policy).
ldd "$OUT_BIN" > "$WORK/ldd.txt" || true
awk '
  /=>/ { print $1; next }
  /^[[:space:]]*\/.*ld-linux/ { print $1; next }
' "$WORK/ldd.txt" > "$WORK/deps.txt"
if grep -Ev '^(linux-vdso\.so\.1|lib(c|m|pthread|rt|dl|resolv|util|z|stdc\+\+|gcc_s|atomic|anl)\.so\.[0-9]+|/lib.*/ld-linux.*\.so\.[0-9]+|ld-linux.*\.so\.[0-9]+)$' "$WORK/deps.txt"; then
  echo "ERROR: et links a non-system shared library; static linking failed." >&2
  exit 1
fi

BUNDLE_TGZ="$OUT_DIR/et-linux-$ARCH.tar.gz"
( cd "$BUNDLE_DIR" && tar -czf "$BUNDLE_TGZ" "et" )

( cd "$OUT_DIR" && sha256sum "et-linux-$ARCH.tar.gz" > "et-linux-$ARCH.tar.gz.sha256" )
cat "$OUT_DIR/et-linux-$ARCH.tar.gz.sha256"
