# How Switchboard works

This doc covers the moving parts, why they're built the way they are, and the gaps that remain. Terms are
defined in [GLOSSARY.md](GLOSSARY.md).

## The pieces

```
 Claude Code / Claude Desktop / OpenMausBot / any MCP client
        │ stdio: `switchboard mcp --client <label>`        │ or HTTP + bearer token (optional)
        ▼                                                  ▼
  switchboard daemon ── unix socket (0600) ── loopback 127.0.0.1 only
        │
        ├─ readers: LinkedIn (allman store) · iMessage (chat.db copy) · WhatsApp (ChatStorage copy) · Contacts
        ├─ index.db   searchable cache, rebuildable
        ├─ outbox.db  durable send state: operations, drafts, approvals
        └─ senders:   allman (LinkedIn) · osascript → Messages · `open` → WhatsApp (prefilled)
        ▲
  Switchboard.app (menu bar): starts the daemon as its child, sets channel modes, shows health
```

- **Switchboard.app** (`app/`, SwiftUI) holds everything: the app, the `switchboard` helper (TypeScript compiled
  with Bun) and the pinned allman. It runs the daemon as its own child process, because macOS's Full Disk Access
  grant to the app then covers the daemon. A separately registered launch agent was tested and wasn't covered.
  The app starts at login. Quitting it stops Switchboard, and the daemon exits if the app disappears.
- **The daemon** reads each channel on a schedule, writes `index.db`, and serves MCP over a 0600 unix socket.
  Each assistant starts `switchboard mcp --client <label>`, a thin stdio shim that connects to that socket.
- **Data** lives in `~/Library/Application Support/Switchboard/`. allman keeps its LinkedIn store in `~/.allman`.

## Reading

- **iMessage and WhatsApp** are read from temporary copies of their SQLite databases (plus WAL files), never the
  live files. That needs Full Disk Access.
- **LinkedIn** is read from allman's local store. The daemon runs `allman sync` and `allman listen` (argv arrays
  only, absolute `--store`) and never reads allman's cookies.
- **Contacts** joins handles (phone, email, LinkedIn URL) into one person. People are only joined on exact
  handles, never on names. An assistant can pass handles from another tool, such as a CRM, to `find_person`.
- **Backfill** is 12 months per channel. WhatsApp groups larger than `whatsapp.group_max` (default 8) are
  skipped.
- **Channel modes**, set per channel in the app (`switchboard set-channel`):
  - *Off*: not read, and its rows are deleted from the index.
  - *Read only*: sends are refused with `channel_read_only`.
  - *Read & write*: reads, and sends with approval.
  - A new install starts with everything Off.
- **Untrusted text.** Every message body leaving the index is wrapped `{ untrusted_text }`, and the tool
  descriptions say that it is third-party data. Sender names are truncated.

## Sending

There is one path, and every send tool goes through it: `SendService.send` → `approve` → `dispatch`
(`src/send/service.ts`). Drafts are thin wrappers over it.

1. **Resolve** the target. Existing threads are addressed by id. New conversations are 1:1 only:
   - LinkedIn by profile slug or URL.
   - iMessage only to handles already in Contacts.
   - WhatsApp by phone number.
   - Unsupported cases are errors, never best guesses.
2. **Policy.** Each client label has a `send_policy`:
   - `confirm` (the default) needs the human to approve the exact text, every time.
   - `draft-only` never sends.
   - `autonomous` is refused unless `profile` is `"allow-autonomous"`, and even then only for listed thread ids,
     until an expiry date, within a daily cap.
3. **Approval** is bound to a hash of the exact payload, works once, and expires after 10 minutes. It comes from
   one of two places:
   - an MCP elicitation form in the assistant, when the client supports one, or
   - a macOS notification that opens a local approval page (`127.0.0.1`, CSRF token, same-origin checks).
   Clients set to `approval: "mac_page"` always use the page. So does every HTTP client.
4. **Dispatch** happens once. Only `dispatch` moves an operation to `dispatching`, and nothing is ever retried.
   If a new inbound message arrives after approval, the send becomes `stale`.
   - LinkedIn goes through allman, capped at 30 a day, 2 a minute and at least 30 seconds apart. It stops on an
     auth challenge.
   - iMessage goes through AppleScript into Messages.app, capped at 30 a day. macOS asks for Automation
     permission once.
   - WhatsApp opens the chat with the text typed in, and the human presses Enter (`awaiting_user_send`).

Message text and recipients are passed as argv elements only: `--` before allman's positional arguments, and
`on run argv` for AppleScript. `outbox.db` is separate from the index, so rebuilding the index never loses
send state. Message bodies in the outbox are purged 30 days after an operation finishes.

## Assistants on another machine (optional)

Some bot hosts run on another machine, such as OpenMausBot on a home server. For them the daemon can also
serve MCP over Streamable HTTP on `127.0.0.1:<http.port>`, which is off by default. That endpoint:

- needs a per-client bearer token. The config stores only the token's sha256, and the token decides the
  client.
- binds each session to the token that opened it.
- refuses any `Origin` header and any Host other than loopback or a listed `http.public_hosts` name.

The intended way in is a private proxy, such as `tailscale serve` on the Mac. `scripts/http-token.sh` mints a
token and stores it in 1Password.

## Privacy rules

- The only network traffic is allman to LinkedIn and the assistant to Switchboard. There is no telemetry.
- The audit log (JSONL, rotated) records the tool, the client, argument shapes and sizes. It never records
  message text. `doctor` and the app show counts and states only.
- Tests and fixtures are synthetic (555-01xx numbers, example.com). They never touch the real allman,
  Messages, WhatsApp or LinkedIn: `scripts/fake-*` stand in for them.

## Signing and Full Disk Access

macOS ties Full Disk Access to the code signature. Releases are signed with a Developer ID, use the hardened
runtime (with Bun's JIT entitlements, `scripts/entitlements.plist`), and are notarized. Dev builds use a local
"Switchboard Dev" identity (`scripts/make-dev-cert.sh`), so the grant survives rebuilds. When the signature
changes, remove the Full Disk Access entry and add it again; toggling it isn't enough.

The bundled allman is checked against the in-repo sha256 pin at build time and then re-signed. The re-signed
copy's hash is sealed inside the app's signature, which is what the daemon and `doctor` check. allman is never
upgraded automatically: changing `ALLMAN_VERSION` and its pin is a deliberate code change.

## Known gaps

- **Approval isn't proven to be human.** Any process running as you can open the 0600 socket, and it can also
  reach the loopback approval page, CSRF token included, because it can fetch the page. MCP elicitation isn't
  verified to be human-only either. `--client` labels are policy names, not identities. A Touch ID or password
  guard on approval would close this, and it's an open design question.
- **LinkedIn depends on allman** and LinkedIn's private API, which can change without notice.
- **iMessage group sends** are off until proven reliable (`imessage.group_send`).
- **Apple Silicon only** for now.

## Not in scope

- Bulk or cold outreach, connection requests, profile scraping.
- Any copy of message content leaving the Mac other than to the assistant you're driving.
- A hosted service.
