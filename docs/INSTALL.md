# Installing Switchboard

You need a Mac with Apple Silicon on macOS 14 or later (plus Google Chrome, Microsoft Edge, Brave or Chromium if you
use LinkedIn: the sign-in window opens in it), and about 10 minutes at it (macOS asks you to grant
permissions). Everything stays on your Mac: your LinkedIn login, your messages index and your settings.
Nothing in setup sends a message.

## Switchboard.app

1. Download `Switchboard-<version>.dmg` from the
   [latest release](https://github.com/AI-House-VC/switchboard/releases/latest).
2. Open the dmg, drag **Switchboard** into **Applications**, then open it from Applications. It lives in the menu
   bar (no Dock icon) and starts at login.
3. Follow the window:
   - Grant **Full Disk Access**: drag Switchboard into the list.
   - Choose what each channel may do: **Off**, **Read only** or **Read & write**. Everything starts Off.
   - Sign in to LinkedIn if you turned it on.
   - Connect your assistants. The Claude app and Claude Code are connected for you (quit and reopen Claude
     afterwards); OpenMausBot gets a block to paste.

Quitting Switchboard from the menu bar stops it, and your assistants lose access until you open it again.
Switching a channel to Off deletes Switchboard's local copy of it. Your messages in LinkedIn, Messages and
WhatsApp aren't touched.

If reads fail after an update that changed the signature, open **System Settings → Privacy & Security → Full
Disk Access**, remove Switchboard with **−** and add it again. Toggling it isn't enough.

## Checking it

```bash
/Applications/Switchboard.app/Contents/Helpers/switchboard doctor
```

`doctor` prints states and counts only, never message text.

## Sending

Assistants can ask to send, but every message needs your approval of the exact text: either in the assistant,
when it can show a form, or on your Mac, where a notification opens an approval page. For WhatsApp, the app opens
with the text typed in and you press Enter yourself. macOS asks for permission to control Messages the first
time an iMessage is sent.

## Assistants on another machine

If your bot host runs on another machine, such as OpenMausBot on a home server, use
`scripts/http-token.sh` from this repo. It turns on a token-guarded loopback HTTP endpoint and stores the token
in 1Password. Then reach the endpoint through a private proxy such as `tailscale serve`
([DESIGN.md](DESIGN.md#assistants-on-another-machine-optional)).

If the Mac sleeps (a laptop), also run the relay on the bot host, so bots don't stall while it's closed:

```bash
node switchboard-relay.mjs --upstream https://<your-mac>.<tailnet>.ts.net/mcp --port 47822
```

Then point the bot host's `switchboard` server at `http://127.0.0.1:47822/mcp` and keep its Authorization
header. Build the file with `./scripts/build-relay.sh`, and keep it running with the bot host's service manager.

## Command-line build

Each release also has `switchboard-<version>-darwin-arm64.zip`: the helper alone, with allman built in, for a
setup without the app. This build runs as a LaunchAgent, so it needs its own Full Disk Access grant.

```bash
mkdir -p ~/Downloads/switchboard && cd ~/Downloads/switchboard
curl -fLO https://github.com/AI-House-VC/switchboard/releases/latest/download/switchboard-<version>-darwin-arm64.zip
ditto -x -k switchboard-*-darwin-arm64.zip . && ./switchboard install
```

`install` puts Switchboard in `~/Applications/Switchboard` and starts it in the background. It also registers
it with Claude Code. Grant Full Disk Access to `~/Applications/Switchboard/switchboard` when System Settings
opens, then run `~/Applications/Switchboard/switchboard doctor`. If LinkedIn isn't signed in, run
`~/Applications/Switchboard/switchboard linkedin-login`.
