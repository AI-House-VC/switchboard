#!/bin/bash
# Assemble and sign dist/Switchboard.app.
#
#   ./scripts/build-app.sh            dev: "Switchboard Dev" identity (ad-hoc if absent)
#   ./scripts/build-app.sh --release  Developer ID, hardened runtime, secure timestamp (for notarization)
#
# Layout:
#   Contents/MacOS/<SwiftUI app>                 app/ (swift build), or SWITCHBOARD_APP_EXE
#   Contents/Helpers/switchboard                 the daemon/CLI (bun compile; allman NOT embedded here)
#   Contents/Helpers/allman                      pinned allman, verified against the pin, then re-signed
#   Contents/Resources/allman.sha256             sha256 of the re-signed allman (sealed by the app signature)
#   The app runs the daemon as its own child (app/Sources/SwitchboardApp/ServiceRunner.swift), so its Full Disk Access covers it.
set -euo pipefail
cd "$(dirname "$0")/.."
RELEASE=false; [[ "${1:-}" == "--release" ]] && RELEASE=true
V=$(python3 -I -c 'import json; print(json.load(open("package.json"))["version"])')
APP=dist/Switchboard.app

# The SwiftUI front end.
EXE="${SWITCHBOARD_APP_EXE:-}"
if [[ -z "$EXE" ]]; then
  [[ -f app/Package.swift ]] || { echo "No app/Package.swift (the SwiftUI app) and no SWITCHBOARD_APP_EXE." >&2; exit 1; }
  swift build -c release --arch arm64 --package-path app >/dev/null
  EXE=$(swift build -c release --arch arm64 --package-path app --show-bin-path)/$(python3 -I - <<'PY'
import re
s = open("app/Package.swift").read()
m = re.search(r'\.executable\(\s*name:\s*"([^"]+)"', s) or re.search(r'executableTarget\(\s*name:\s*"([^"]+)"', s)
print(m.group(1) if m else "SwitchboardApp")
PY
)
fi
[[ -x "$EXE" ]] || { echo "SwiftUI executable not found: $EXE" >&2; exit 1; }
EXE_NAME=$(basename "$EXE")

if $RELEASE; then
  ID="${SWITCHBOARD_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)}"
  [[ -n "$ID" ]] || { echo "No 'Developer ID Application' identity (docs/RELEASING.md)." >&2; exit 1; }
  TS=(--timestamp)
elif security find-identity -v -p codesigning | grep -q '"Switchboard Dev"'; then
  ID="Switchboard Dev"; TS=(--timestamp=none)
else
  ID="-"; TS=(--timestamp=none)
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$EXE" "$APP/Contents/MacOS/$EXE_NAME"

bun build --compile --target=bun-darwin-arm64 src/cli/main.ts --outfile "$APP/Contents/Helpers/switchboard" >/dev/null
[[ -x vendor/allman ]] || ./scripts/fetch-allman.sh >/dev/null
PIN=$(sed -n 's/^export const ALLMAN_SHA256_DARWIN_ARM64 = "\(.*\)";/\1/p' src/adapters/linkedin/allman.ts)
[[ "$(shasum -a 256 vendor/allman | cut -d' ' -f1)" == "$PIN" ]] || { echo "vendor/allman doesn't match the pin; run scripts/fetch-allman.sh" >&2; exit 1; }
cp vendor/allman "$APP/Contents/Helpers/allman"
cp THIRD_PARTY_NOTICES.md LICENSE "$APP/Contents/Resources/"

ICON=""
if [[ -f app/Resources/AppIcon.icns ]]; then
  cp app/Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
  ICON="<key>CFBundleIconFile</key><string>AppIcon</string>"
fi
sed -e "s|__EXECUTABLE__|$EXE_NAME|" -e "s|__VERSION__|$V|g" -e "s|__ICON__|$ICON|" scripts/app/Info.plist.template > "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"

# Inside out: helpers (hardened runtime + Bun JIT entitlements), the sealed allman hash, the app executable, the bundle.
sign() { codesign --force --options runtime "${TS[@]}" --sign "$ID" "$@"; }
sign --entitlements scripts/entitlements.plist --identifier vc.aihouse.allman "$APP/Contents/Helpers/allman"
shasum -a 256 "$APP/Contents/Helpers/allman" | cut -d' ' -f1 > "$APP/Contents/Resources/allman.sha256"
sign --entitlements scripts/entitlements.plist --identifier vc.aihouse.switchboard "$APP/Contents/Helpers/switchboard"
sign --identifier vc.aihouse.Switchboard "$APP/Contents/MacOS/$EXE_NAME"
sign "$APP"
codesign --verify --deep --strict "$APP"
echo "✓ $APP $V signed by ${ID/-/ad-hoc}"
