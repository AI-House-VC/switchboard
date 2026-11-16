# Releasing Switchboard

## One-time setup (the release maintainer)

1. **Apple Developer Program.** Enroll ($99/yr) at developer.apple.com. Then in Xcode →
   Settings → Accounts → Manage Certificates, add a **Developer ID Application** certificate. It lands in the
   login keychain; `security find-identity -v -p codesigning` should list it.
2. **Notarization credentials**, stored in the keychain, never in a file:
   ```bash
   xcrun notarytool store-credentials switchboard-notary --apple-id <your Apple ID> --team-id <Team ID>
   ```
   It prompts (hidden) for an app-specific password from appleid.apple.com.

Changing the signing identity changes the Full Disk Access requirement: every user re-grants FDA once after the
first Developer ID build (yours included).

## Each release

1. Bump `version` in `package.json` and commit to main.
2. `./scripts/release.sh` — runs `./check`, builds with allman embedded (verified against the pin), signs with
   the Developer ID and hardened runtime (`scripts/entitlements.plist`), notarizes, tags `v<version>` and
   creates the GitHub release with the zip and its sha256.

   With `app/Package.swift` present it also builds Switchboard.app (`scripts/build-app.sh --release`), notarizes and
   staples it, makes the dmg (`scripts/make-dmg.sh`), notarizes and staples that, and uploads the dmg too.

`./scripts/release.sh --dry-run` does the builds, signing and zip without notarizing, tagging or uploading.
`./scripts/build-app.sh` alone makes a dev-signed app; `SWITCHBOARD_APP_EXE=<path>` uses another SwiftUI executable.
