#!/bin/bash
# dist/Switchboard.app → dist/Switchboard-<version>.dmg (drag-to-Applications layout), signed when an identity is given.
#   ./scripts/make-dmg.sh ["Developer ID Application: …"]
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(python3 -I -c 'import json; print(json.load(open("package.json"))["version"])')
DMG="dist/Switchboard-$V.dmg"
[[ -d dist/Switchboard.app ]] || { echo "Build dist/Switchboard.app first (scripts/build-app.sh)." >&2; exit 1; }
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto dist/Switchboard.app "$STAGE/Switchboard.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "Switchboard" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
if [[ -n "${1:-}" ]]; then codesign --force --timestamp --sign "$1" "$DMG"; fi
echo "✓ $DMG"
