# Switchboard

Local, per-user MCP connector that lets a person's AI harnesses read, and with approval send, their LinkedIn,
iMessage and WhatsApp conversations. How it works and why: `docs/DESIGN.md`. Terms: `docs/GLOSSARY.md`.

## Commands
- `./check`: typecheck (tsc), lint (biome), tests (bun test). Must pass before anything is done.
- `./scripts/build.sh`: compile `dist/switchboard` and sign it ("Switchboard Dev" identity if present).
  `--release` embeds the pinned allman and signs with a Developer ID (hardened runtime).
- `./scripts/build-app.sh [--release]` / `./scripts/make-dmg.sh`: assemble and sign Switchboard.app; make the dmg.
- `./scripts/release.sh [--dry-run]`: check, release build, notarize, tag and GitHub release (`docs/RELEASING.md`).
- `./scripts/http-token.sh [client] [port]`: mint/rotate a loopback HTTP token (1Password) for a remote client.
- `./scripts/fetch-allman.sh`: download the pinned allman into `vendor/` and verify the sha256 pin.
- `./scripts/make-dev-cert.sh`: one-time, creates the local code-signing identity so FDA survives rebuilds.
- `dist/switchboard install | doctor | daemon | mcp --client <label>`.

## Rules
- **Never open a live Apple/WhatsApp database.** Read only from temp copies (`withTempCopies`).
- **All LinkedIn network I/O goes through the pinned allman binary**, argv arrays only, absolute
  `--store` (and `--account` when configured). Never read `COOKIES.json`. Never auto-upgrade allman:
  bump `ALLMAN_VERSION` and the sha256 pin together.
- **Tests never reach the real allman or LinkedIn.** Point `SWITCHBOARD_ALLMAN` at `scripts/fake-allman.sh`.
- **Synthetic data only** in fixtures, tests, logs, commits and docs (555-01xx numbers, example.com).
- **Logs hold no content.** The audit log records tool, client, redacted arg shapes and sizes. Doctor and
  install print counts only. When verifying against real data, report counts/ids, never message text.
- Every body leaving the index is wrapped `{ untrusted_text }`; tool descriptions say it's third-party data.
- `index.db` is a rebuildable cache. Durable send state (outbox, drafts, approvals) goes in a separate
  `outbox.db` and must never be lost by an index rebuild.
- Sending: one policy-checked path, `SendService.send` → `approve` → `dispatch` (`src/send/service.ts`);
  `send_draft` wraps it. Only `dispatch` moves an operation to `dispatching`, once. Never add a retry.
  Default profile `strict` refuses `autonomous`; only `profile: "allow-autonomous"` enables it.
- **Tests never reach Messages, WhatsApp or LinkedIn.** Point SWITCHBOARD_OSASCRIPT/OPEN/PBCOPY at the
  `scripts/fake-*` doubles. A live send needs the owner's yes to the exact text, every time.
- Text and recipients go to allman/osascript/open as argv elements only (`--` before allman positionals,
  `on run argv` for AppleScript). allman/osascript stderr can hold message text: match it, never log it.
- Client labels (`--client`) are audit/policy names, not proof of identity: any local process running as
  the user can open the 0600 socket. Remote (HTTP) clients get distinct bearer tokens.

## Layout
`src/adapters/{linkedin,imessage,whatsapp,contacts}` readers · `src/index` schema + queries ·
`src/mcp` tools + stdio shim · `src/outbox` outbox.db · `src/send` resolve, dispatchers, service, approval page ·
`src/daemon` switchboardd · `src/cli` install/doctor/app commands · `app/` SwiftUI Switchboard.app ·
`scripts/app` bundle template ·
`tests/fixtures` synthetic world builders.
