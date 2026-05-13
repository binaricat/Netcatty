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
set -euo pipefail

: "${VERSION:?VERSION env var required (no leading v)}"
: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN env var required}"

TAP_REPO="${TAP_REPO:-binaricat/homebrew-netcatty}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
CASK_PATH="${CASK_PATH:-Casks/netcatty.rb}"

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

if [[ ! -f "$CASK_PATH" ]]; then
  echo "::error::Cask file not found in tap: $CASK_PATH"
  exit 1
fi

# Patch the cask in place. The three lines we touch are anchored well enough
# that we don't need anything fancier than sed:
#   - the `version "X.Y.Z"` line (single line, anchored to start)
#   - the `sha256 arm:   "..."` line
#   - the `       intel: "..."` line (anchor on "intel:" at start, after the
#     leading whitespace, so we don't accidentally match the `arch arm:
#     "...", intel: "..."` line earlier in the file)
sed -i -E 's|^(\s*version)\s+"[^"]+"|\1 "'"$VERSION"'"|' "$CASK_PATH"
sed -i -E 's|(sha256\s+arm:\s+)"[^"]+"|\1"'"$ARM_SHA"'"|' "$CASK_PATH"
sed -i -E 's|^(\s*intel:\s+)"[^"]+"|\1"'"$X64_SHA"'"|' "$CASK_PATH"

# Sanity-check: parsed file should still be valid Ruby. Catches a broken
# substitution before we push.
if command -v ruby >/dev/null 2>&1; then
  ruby -c "$CASK_PATH" >/dev/null
fi

if git diff --quiet; then
  echo "Cask already at ${VERSION} with matching checksums — nothing to push."
  exit 0
fi

echo "Cask diff:"
git --no-pager diff "$CASK_PATH"

git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"
git add "$CASK_PATH"
git commit -m "Bump netcatty to ${VERSION}"
git push origin HEAD:main

echo "Pushed bump for ${VERSION} to ${TAP_REPO}."
