#!/bin/bash
# One-shot developer setup on your own Mac: signing identity → pinned allman → build → install →
# LinkedIn login. Steps that need you (keychain password, Full Disk Access, LinkedIn browser login)
# pause with instructions. Prints no secrets and no message content.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/5 Signing identity (macOS asks for your login password once)"
./scripts/make-dev-cert.sh

echo "== 2/5 Pinned allman"
[ -x vendor/allman ] && echo "✓ vendor/allman present" || ./scripts/fetch-allman.sh

echo "== 3/5 Build"
bun install --frozen-lockfile >/dev/null
./scripts/build.sh

echo "== 4/5 Install"
dist/switchboard install
echo
read -r -p "Add ~/Applications/Switchboard/switchboard under Full Disk Access (toggle it on), then press Enter… " _
launchctl kickstart -k "gui/$(id -u)/vc.aihouse.switchboard"

echo "== 5/5 LinkedIn"
if ls ~/.allman/*/AUTH.json >/dev/null 2>&1; then
  echo "✓ LinkedIn account already in ~/.allman"
else
  echo "A browser opens: log in to LinkedIn there. Switchboard never sees your credentials."
  ~/Applications/Switchboard/allman login --store ~/.allman
  ~/Applications/Switchboard/allman sync --since 1y --store ~/.allman >/dev/null
  launchctl kickstart -k "gui/$(id -u)/vc.aihouse.switchboard"
fi

sleep 5
~/Applications/Switchboard/switchboard doctor
