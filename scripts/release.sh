#!/bin/bash
# Cut a release: check → release build (allman embedded, Developer ID) → notarize → GitHub release.
#
#   ./scripts/release.sh            version from package.json; tag v<version>
#   ./scripts/release.sh --dry-run  build, sign and zip only (no notarization, tag or upload)
#
# Needs: a "Developer ID Application" identity in the keychain, and notarytool credentials stored once as the
# keychain profile "switchboard-notary" (docs/RELEASING.md). No secret is read or printed here.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=false; [[ "${1:-}" == "--dry-run" ]] && DRY=true
REPO=AI-House-VC/switchboard
V=$(python3 -I -c 'import json; print(json.load(open("package.json"))["version"])')
ZIP="dist/switchboard-$V-darwin-arm64.zip"

if ! $DRY; then
  [[ -z "$(git status --porcelain)" ]] || { echo "Working tree not clean." >&2; exit 1; }
  [[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "Release from main." >&2; exit 1; }
  git fetch -q origin main && [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "main isn't in sync with origin." >&2; exit 1; }
  ! git rev-parse -q --verify "refs/tags/v$V" >/dev/null || { echo "Tag v$V exists: bump the version in package.json." >&2; exit 1; }
fi

./check
./scripts/build.sh --release
[[ "$(dist/switchboard --version)" == "$V" ]] || { echo "Built binary reports a different version." >&2; exit 1; }

rm -f "$ZIP"
# The zip holds switchboard and its notices at its root (docs/INSTALL.md runs ./switchboard after unzipping).
cp LICENSE THIRD_PARTY_NOTICES.md dist/
rm -f "$ZIP" && (cd dist && zip -q -X "../$ZIP" switchboard LICENSE THIRD_PARTY_NOTICES.md)
[[ "$(unzip -Z1 "$ZIP" | sort | tr '\n' ' ')" == "LICENSE THIRD_PARTY_NOTICES.md switchboard " ]] || { echo "Unexpected zip layout." >&2; exit 1; }
shasum -a 256 "$ZIP" | sed 's|dist/||' > "$ZIP.sha256"
echo "✓ $ZIP"

# Switchboard.app and its dmg, once the SwiftUI app is in the repo (app/Package.swift).
ASSETS=("$ZIP" "$ZIP.sha256")
DMG="dist/Switchboard-$V.dmg"
if [[ -f app/Package.swift ]]; then
  ./scripts/build-app.sh --release
  [[ -z "$(find dist/Switchboard.app/Contents -path '*LaunchAgents*' -print -quit)" ]] || { echo "Stray LaunchAgents in the app." >&2; exit 1; }
fi

if $DRY; then echo "(dry run: not notarized, tagged or uploaded)"; exit 0; fi

xcrun notarytool submit "$ZIP" --keychain-profile switchboard-notary --wait
spctl --assess --type execute --verbose=2 dist/switchboard 2>&1 | sed 's/^/  /' || true

if [[ -d dist/Switchboard.app && -f app/Package.swift ]]; then
  ID=$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)
  rm -f dist/Switchboard-app.zip && ditto -c -k --keepParent dist/Switchboard.app dist/Switchboard-app.zip
  xcrun notarytool submit dist/Switchboard-app.zip --keychain-profile switchboard-notary --wait
  xcrun stapler staple dist/Switchboard.app
  ./scripts/make-dmg.sh "$ID"
  xcrun notarytool submit "$DMG" --keychain-profile switchboard-notary --wait
  xcrun stapler staple "$DMG"
  spctl --assess --type open --context context:primary-signature -v "$DMG" 2>&1 | sed 's/^/  /' || true
  shasum -a 256 "$DMG" | sed 's|dist/||' > "$DMG.sha256"
  ASSETS+=("$DMG" "$DMG.sha256")
fi

git tag -a "v$V" -m "Switchboard $V"
git push -q origin "v$V"
gh release create "v$V" --repo "$REPO" --title "Switchboard $V" \
  --notes "Install: download Switchboard-$V.dmg, drag Switchboard to Applications, open it (docs/INSTALL.md). Apple Silicon, macOS 14+. The switchboard-*.zip is the command-line build." "${ASSETS[@]}"
echo "✓ Released v$V on $REPO"
