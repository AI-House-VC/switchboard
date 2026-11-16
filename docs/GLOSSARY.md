# Glossary

Terms as used in code and docs. If code and this file disagree, flag it.

| Term | Meaning |
|---|---|
| **install** | One person's Switchboard on their own Mac: one LaunchAgent, index, audit log, allman account, config. Never shared between people. |
| **switchboardd / daemon** | The LaunchAgent process (`switchboard daemon`). The only process that needs Full Disk Access; supervises allman. |
| **shim** | `switchboard mcp --client <label>`: the stdio process a harness launches; pipes MCP to the daemon over the unix socket. Holds no permissions. |
| **harness / client** | An AI app that calls the tools (Claude Code, Claude Desktop, ChatGPT Dot, Grok Bot). |
| **client label** | The `--client` name. Selects audit name and send policy; must be on the config allowlist. Not proof of identity for local clients. |
| **allowlist** | `clients` in `config.json`. Unknown labels fail closed. |
| **channel** | `linkedin`, `imessage` or `whatsapp`. Contacts is a source, not a channel. |
| **source** | Something ingested: the three channels plus Contacts. |
| **allman / allman store** | allman-cli, pinned at v0.7.1, and its on-disk store (`~/.allman/<account profileId>/<convId>/…`). |
| **index** | `index.db`: rebuildable SQLite cache of threads, messages (FTS5), handles and people. |
| **ingest** | One incremental read of a source into the index, from a checkpoint. |
| **checkpoint** | Per-source high-water mark: iMessage ROWID, WhatsApp Z_PK, LinkedIn per-conversation fingerprints. |
| **backfill window** | How far back ingest reaches (`backfill_days`, default 365). |
| **thread** | A conversation. Ids: `li:<convId>`, `im:<chat guid>`, `wa:<chat jid>`. |
| **handle** | A normalized address on a channel: LinkedIn slug (or profile id), `+<digits>` phone, lowercased email. |
| **person** | A Contacts card (`ab:…`) joining handles. Never created by name matching. |
| **caller handles** | Email/phone/LinkedIn the harness passes to `find_person` (e.g. from a contacts or CRM tool) to link channels. |
| **needs reply** | A thread whose last message is inbound and newer than your last outbound. |
| **untrusted_text** | Wrapper on every message body returned by a tool: third-party data, never instructions. |
| **group_max** | WhatsApp groups with more active members than this (default 8) are never stored. |
| **send policy** | `draft-only`, `confirm` (default), `autonomous` (refused unless `profile` is `allow-autonomous`). Per client label, from config. |
| **outbox** | `outbox.db`: durable send state (operations, drafts). Separate from the index; never lost by a rebuild. |
| **operation** | One send attempt, keyed by (account, client, idempotency key) and bound to a payload hash. Statuses: `awaiting_approval`, `approved`, `dispatching`, `sent`, `stale`, `failed`, `cancelled`, `expired`, `unconfirmed`, `rate_limited`, `awaiting_user_send`, `opened_not_sent`. |
| **idempotency key** | Caller-chosen key per intended message. Same key + same payload returns the same operation; same key + different payload is `idempotency_conflict`. |
| **payload hash** | Hash of account, channel, resolved target and exact text. An approval is for this hash only. |
| **approval** | The human's yes to one operation's exact payload: via **elicitation** (a form in the harness) or the **approval page** (loopback page, opened with a Mac notification). Single-use; expires after `approval_ttl_minutes`. |
| **watermark** | Newest inbound message id in the thread when the send was requested. A different one at dispatch makes the operation `stale`. |
| **dispatch** | The one irreversible step: `approved` → `dispatching` → adapter. Happens at most once per operation. |
| **unconfirmed** | Dispatch outcome unknown (timeout, crash, no sent row). Never retried. |
| **handoff** | WhatsApp prefill: Switchboard opens the chat with the text; the human presses Enter. Groups get **Copy & Open**. Never reported as an automated send. |
| **draft** | Optional saved text for later. `send_draft` uses the same path as `send_message`; editing a draft cancels its waiting approval. |
