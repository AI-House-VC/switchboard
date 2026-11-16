# Switchboard

Give your AI assistants your LinkedIn, iMessage and WhatsApp conversations, on your own Mac, with you approving
every message they send.

Switchboard is a small Mac app that runs a local [MCP](https://modelcontextprotocol.io) server. Claude Code,
Claude Desktop, [OpenMausBot](https://github.com/milind-soni/OpenMausBot) and other MCP clients can then search
your conversations, find who's waiting on a reply, read a thread, and draft and send replies. You approve each
reply on your Mac. Nothing goes to a server: your messages, your LinkedIn login and the index stay on your Mac.

## Why

People who work with lots of outside contacts (founders, investors, recruiters, anyone in a "who's waiting on me?"
job) end up with conversations spread across three apps. Their AI assistants can read their email and calendar
but not these three apps, so arranging one meeting means copying text between LinkedIn, Messages, WhatsApp and a
chat window.

Switchboard puts the three behind one set of tools, so you can say "who's waiting on a reply from me?" or "find
my last thread with Ada and suggest a time for next week" and get an answer drawn from all three. It was built
for one person's daily use and is shared in case it's useful to others.

## What it does

- **Reads** LinkedIn messages (through [allman](https://github.com/tarkaai/allman-cli)), iMessage (from
  Messages' local database) and WhatsApp (from the WhatsApp desktop app's local database), plus Contacts to
  link one person across channels. It reads from temporary copies and never opens a live Apple or WhatsApp
  database.
- **Finds** the threads that need a reply, grouped into 1:1, group, and unknown senders.
- **Sends** only after you approve the exact text. LinkedIn sends through allman, and iMessage through
  Messages.app. For WhatsApp, the app opens with the text typed in and you press Enter.
- **Lets you choose, per channel,** whether assistants can read nothing (**Off**), read only (**Read only**), or
  read and ask to send (**Read & write**). Switching a channel to Off deletes Switchboard's copy of it.

## Install

You need an Apple Silicon Mac on macOS 14 or later. For LinkedIn you also need Google Chrome, Microsoft Edge, Brave
or Chromium installed: the one-time sign-in window opens in it.

1. Download `Switchboard-<version>.dmg` from the [latest release](../../releases/latest).
2. Open it and drag **Switchboard** into **Applications**, then open it. It lives in the menu bar and starts at
   login.
3. Follow the window:
   - Grant **Full Disk Access**, which it needs to read Messages, WhatsApp and Contacts.
   - Choose what each channel may do. Everything starts Off.
   - Sign in to LinkedIn if you turned LinkedIn on. allman opens a browser, and Switchboard never sees your
     password.
   - Connect your assistants.

More detail, including the command-line build, is in [docs/INSTALL.md](docs/INSTALL.md).

### Connecting assistants

- **The Claude app** (Claude Desktop) and **Claude Code** are connected for you each time Switchboard opens. Quit and
  reopen Claude afterwards so it loads Switchboard. The Claude app gets this entry in
  `~/Library/Application Support/Claude/claude_desktop_config.json`, and the rest of that file is kept as it was:
  ```json
  "switchboard": {
    "command": "/Applications/Switchboard.app/Contents/Helpers/switchboard",
    "args": ["mcp", "--client", "claude-desktop"]
  }
  ```
- **OpenMausBot**: the app's *Connect Your Bots* page copies a block to paste into **Plugins → MCP servers**.
- **Other MCP clients**: run `switchboard mcp --client <label>` as a stdio server, after adding `<label>` to
  `clients` in `~/Library/Application Support/Switchboard/config.json`. Unknown labels are refused.

## Tools

| Read | Send |
|---|---|
| `channel_status`, `needs_reply`, `list_threads`, `read_thread`, `search_messages`, `find_person`, `sync_now` | `send_message`, `get_send_status`; optional drafts: `draft_message`, `update_draft`, `send_draft`, `list_drafts`, `discard_draft` |

Message bodies come back wrapped as `{ "untrusted_text": … }`. Other people wrote them, so assistants are told to
treat them as data and never as instructions.

## Safety and privacy

- **Local only.** The only network traffic is allman talking to LinkedIn and your assistant talking to
  Switchboard. There is no telemetry.
- **Every send needs your approval of the exact text.** You approve either in the assistant, when it can show
  a form, or on a Mac notification that opens a local approval page. An approval works once and expires after
  10 minutes. If a new message arrives after you approved, the send is stopped. Nothing is retried
  automatically.
- **Rate limits.** LinkedIn: 30 sends a day, 2 a minute, at least 30 seconds apart. iMessage: 30 a day. New
  iMessage conversations only go to people in your Contacts.
- **Logs hold no message content.** The audit log records which tool was called, by which client, and the
  shapes and sizes of arguments.
- **Known gap:** any program running as you on your Mac could reach the approval page, so an approval isn't
  proof that a human gave it. See [docs/DESIGN.md](docs/DESIGN.md#known-gaps).

### About LinkedIn

LinkedIn has no public messaging API. allman uses the same private API as LinkedIn's website, with your own
signed-in session. That may break when LinkedIn changes things, and you are responsible for following
[LinkedIn's User Agreement](https://www.linkedin.com/legal/user-agreement). Use it for your own conversations:
not for bulk outreach, scraping or operating other people's accounts. See allman's
[responsible-use notes](https://github.com/tarkaai/allman-cli/blob/main/RESPONSIBLE_USE.md). Switchboard isn't
affiliated with LinkedIn, Apple, WhatsApp or Meta.

## Credits

LinkedIn support is built on **[allman](https://github.com/tarkaai/allman-cli)** by Tarka Ventures, a local-first
LinkedIn messenger CLI. allman handles LinkedIn sign-in, sync and sending. Switchboard pins one allman release by
checksum, bundles it, and never upgrades it on its own. allman is MIT-licensed. Its license and notice are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and ship inside the app.

Also built with [Bun](https://bun.sh), the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and SwiftUI.

## Develop

```bash
bun install
./check                       # typecheck, lint (biome), tests
./scripts/fetch-allman.sh     # the pinned allman, checksum-verified, into vendor/
./scripts/build-app.sh        # dist/Switchboard.app, signed with a local dev identity
```

Tests use synthetic data only and never reach LinkedIn, Messages or WhatsApp. They run against fake stand-ins
for those (`scripts/fake-*`). [docs/DESIGN.md](docs/DESIGN.md) explains the pieces,
[docs/GLOSSARY.md](docs/GLOSSARY.md) the terms, and [CLAUDE.md](CLAUDE.md) the rules for working in the repo.
Releases are in [docs/RELEASING.md](docs/RELEASING.md).

Issues and pull requests are welcome. Please keep real names, numbers and message text out of them.

## License

[MIT](LICENSE). Bundled third-party software keeps its own license ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
