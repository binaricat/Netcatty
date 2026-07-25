#!/usr/bin/env bash
#
# bump-homebrew-cask.sh — push a new version of the Netcatty cask to the
# binaricat/homebrew-netcatty tap.
#
# Called from the release pipeline (`build.yml` → `homebrew-tap` job) after
# the GitHub Release has been published with the signed + notarized DMGs.
# Computes SHA-256 of the arm64 and x64 DMGs, rewrites the cask file, and
# pushes the bump back to the tap repository using HOMEBREW_TAP_TOKEN.
#
# Required env vars:
#   VERSION              — semver without leading "v" (e.g. 1.1.6)
#   HOMEBREW_TAP_TOKEN   — PAT with contents:write on the tap repo
#
# Optional env vars:
#   TAP_REPO             — default: binaricat/homebrew-netcatty
#   ARTIFACTS_DIR        — default: artifacts
#   CASK_PATH            — default: Casks/netcatty.rb
#   MAX_PUSH_ATTEMPTS    — default: 5
set -euo pipefail

: "${VERSION:?VERSION env var required (no leading v)}"
: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN env var required}"

TAP_REPO="${TAP_REPO:-binaricat/homebrew-netcatty}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
CASK_PATH="${CASK_PATH:-Casks/netcatty.rb}"
MAX_PUSH_ATTEMPTS="${MAX_PUSH_ATTEMPTS:-5}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::VERSION must be a stable numeric semver: $VERSION"
  exit 1
fi
if [[ ! "$MAX_PUSH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::MAX_PUSH_ATTEMPTS must be a positive integer."
  exit 1
fi

version_is_newer() {
  local candidate="$1"
  local baseline="$2"
  local index
  local -a candidate_parts baseline_parts
  IFS='.' read -r -a candidate_parts <<<"$candidate"
  IFS='.' read -r -a baseline_parts <<<"$baseline"
  for index in 0 1 2; do
    if (( 10#${candidate_parts[$index]} > 10#${baseline_parts[$index]} )); then
      return 0
    fi
    if (( 10#${candidate_parts[$index]} < 10#${baseline_parts[$index]} )); then
      return 1
    fi
  done
  return 1
}

ARM_DMG="${ARTIFACTS_DIR}/Netcatty-${VERSION}-mac-arm64.dmg"
X64_DMG="${ARTIFACTS_DIR}/Netcatty-${VERSION}-mac-x64.dmg"

for f in "$ARM_DMG" "$X64_DMG"; do
  if [[ ! -f "$f" ]]; then
    echo "::error::Required DMG artifact not found: $f"
    exit 1
  fi
done

ARM_SHA=$(shasum -a 256 "$ARM_DMG" | awk '{print $1}')
X64_SHA=$(shasum -a 256 "$X64_DMG" | awk '{print $1}')

echo "Computed checksums:"
echo "  arm64: ${ARM_SHA}"
echo "  x64  : ${X64_SHA}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 \
  "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${TAP_REPO}.git" \
  "$TMP/tap"
cd "$TMP/tap"

git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"

# The shared tap is a compare-and-retry boundary. Each attempt starts from the
# latest main branch, refuses to replace a newer release, then retries only a
# non-fast-forward race from another release workflow.
for ((attempt=1; attempt<=MAX_PUSH_ATTEMPTS; attempt++)); do
  git fetch --depth=1 origin main
  git switch -C main origin/main

  if [[ ! -f "$CASK_PATH" ]]; then
    echo "::error::Cask file not found in tap: $CASK_PATH"
    exit 1
  fi
  current_version="$(
    sed -nE 's/^[[:space:]]*version[[:space:]]+"([^"]+)".*$/\1/p' "$CASK_PATH" |
      head -n 1
  )"
  if [[ ! "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::Current Cask version is not a stable numeric semver: $current_version"
    exit 1
  fi
  if version_is_newer "$current_version" "$VERSION"; then
    echo "Tap already has newer version ${current_version}; skip ${VERSION} without downgrading it."
    exit 0
  fi

  # Patch the cask in place. The three lines are anchored so the architecture
  # declaration earlier in the file cannot be mistaken for the checksum line.
  sed -i -E 's|^(\s*version)\s+"[^"]+"|\1 "'"$VERSION"'"|' "$CASK_PATH"
  sed -i -E 's|(sha256\s+arm:\s+)"[^"]+"|\1"'"$ARM_SHA"'"|' "$CASK_PATH"
  sed -i -E 's|^(\s*intel:\s+)"[^"]+"|\1"'"$X64_SHA"'"|' "$CASK_PATH"

  if command -v ruby >/dev/null 2>&1; then
    ruby -c "$CASK_PATH" >/dev/null
  fi
  if git diff --quiet; then
    echo "Cask already at ${VERSION} with matching checksums — nothing to push."
    exit 0
  fi

  echo "Cask diff (attempt ${attempt}/${MAX_PUSH_ATTEMPTS}):"
  git --no-pager diff "$CASK_PATH"
  git add "$CASK_PATH"
  git commit -m "Bump netcatty to ${VERSION}"

  if push_output="$(git push origin HEAD:main 2>&1)"; then
    printf '%s\n' "$push_output"
    echo "Pushed bump for ${VERSION} to ${TAP_REPO}."
    exit 0
  fi
  printf '%s\n' "$push_output" >&2
  if ! grep -Eqi 'non-fast-forward|fetch first' <<<"$push_output"; then
    echo "::error::Homebrew tap push failed for a reason that cannot be retried safely."
    exit 1
  fi
  if (( attempt == MAX_PUSH_ATTEMPTS )); then
    echo "::error::Homebrew tap push kept racing with another release after ${MAX_PUSH_ATTEMPTS} attempts."
    exit 1
  fi
  echo "::notice::Push raced with another release; refresh the tap and retry."
  sleep "$attempt"
done
