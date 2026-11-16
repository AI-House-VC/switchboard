#!/bin/bash
# Compile one arm64 binary and sign it.
#
#   ./scripts/build.sh            dev build: "Switchboard Dev" identity (ad-hoc if absent), allman not embedded
#   ./scripts/build.sh --release  release build: pinned allman embedded, signed with a "Developer ID Application"
#                                 identity, hardened runtime + Bun's JIT entitlements (needed for notarization)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [[ "${1:-}" == "--release" ]]; then
  ./scripts/fetch-allman.sh >/dev/null # verifies vendor/allman against the sha256 pin
  IDENTITY="${SWITCHBOARD_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)}"
  [[ -n "$IDENTITY" ]] || { echo "No 'Developer ID Application' signing identity in the keychain (see docs/RELEASING.md)." >&2; exit 1; }
  # vendor/allman as a second entrypoint is embedded as a file (Bun.embeddedFiles); install extracts and re-checks it.
  bun build --compile --target=bun-darwin-arm64 src/cli/main.ts vendor/allman --outfile dist/switchboard
  codesign --force --options runtime --timestamp --entitlements scripts/entitlements.plist \
    --sign "$IDENTITY" --identifier vc.aihouse.switchboard dist/switchboard
  codesign --verify --strict --verbose=1 dist/switchboard
  echo "✓ dist/switchboard (release, allman embedded) signed by $IDENTITY"
  exit 0
fi

bun build --compile --target=bun-darwin-arm64 src/cli/main.ts --outfile dist/switchboard
if security find-identity -v -p codesigning | grep -q '"Switchboard Dev"'; then
  codesign --force --sign "Switchboard Dev" --identifier vc.aihouse.switchboard dist/switchboard
  echo "✓ dist/switchboard signed (Switchboard Dev)"
else
  codesign --force --sign - --identifier vc.aihouse.switchboard dist/switchboard
  echo "! dist/switchboard ad-hoc signed; run scripts/make-dev-cert.sh so FDA survives rebuilds"
fi
