#!/usr/bin/env bun
/**
 * Test double for /usr/bin/osascript. Never controls Messages. For the send script (`on run argv` with
 * text, target, kind) it writes the outbound row Messages would write into the fixture chat.db at
 * $FAKE_CHAT_DB, according to $FAKE_OSA: ok (default) | error (row with error=22) | silent (no row) |
 * deny (Automation refused). Notification scripts just exit 0. Argv is appended to $FAKE_OSA_LOG.
 */
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

const [, , flag, script, text, target, kind] = process.argv;
if (process.env.FAKE_OSA_LOG) appendFileSync(process.env.FAKE_OSA_LOG, `${JSON.stringify(process.argv.slice(4))}\n`);
if (flag !== "-e" || !script) process.exit(2);
if (script.includes("display notification")) process.exit(0);
const mode = process.env.FAKE_OSA ?? "ok";
if (mode === "deny") {
  console.error("execution error: Not authorized to send Apple events to Messages. (-1743)");
  process.exit(1);
}
if (mode === "silent") process.exit(0);
const db = new Database(process.env.FAKE_CHAT_DB as string);
const guid = kind === "chat" ? (target as string) : `${kind};-;${target}`;
let chat = db.query("select ROWID as id from chat where guid = ?").get(guid) as { id: number } | null;
if (!chat) {
  db.query("insert into chat(guid, style, display_name) values (?, 45, '')").run(guid);
  chat = db.query("select ROWID as id from chat where guid = ?").get(guid) as { id: number };
}
const appleNs = (Math.floor(Date.now() / 1000) - 978307200) * 1e9;
db.query("insert into message(guid, text, handle_id, date, is_from_me, error) values (?, ?, 0, ?, 1, ?)").run(
  `fake-sent-${Date.now()}-${Math.random()}`,
  text ?? "",
  appleNs,
  mode === "error" ? 22 : 0,
);
const mid = (db.query("select last_insert_rowid() as r").get() as { r: number }).r;
db.query("insert into chat_message_join(chat_id, message_id) values (?, ?)").run(chat.id, mid);
db.close();
