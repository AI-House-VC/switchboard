#!/bin/bash
# Download the pinned allman release into vendor/allman and verify it against the in-repo pin.
# Never auto-upgrades: changing the version means editing ALLMAN_VERSION and the sha256 pin in
# src/adapters/linkedin/allman.ts in the same commit.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/^export const ALLMAN_VERSION = "\(.*\)";/\1/p' src/adapters/linkedin/allman.ts)
PIN=$(sed -n 's/^export const ALLMAN_SHA256_DARWIN_ARM64 = "\(.*\)";/\1/p' src/adapters/linkedin/allman.ts)
ASSET=allman-darwin-arm64
mkdir -p vendor
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gh release download "v$VERSION" -R tarkaai/allman-cli -p "$ASSET" -p "$ASSET.sha256" -D "$tmp"
got=$(shasum -a 256 "$tmp/$ASSET" | cut -d' ' -f1)
published=$(cut -d' ' -f1 < "$tmp/$ASSET.sha256")
[ "$got" = "$published" ] || { echo "✗ checksum doesn't match the release's .sha256" >&2; exit 1; }
[ "$got" = "$PIN" ] || { echo "✗ checksum $got doesn't match the in-repo pin $PIN" >&2; exit 1; }
install -m 755 "$tmp/$ASSET" vendor/allman
echo "✓ vendor/allman $VERSION ($got)"
