/**
 * The read index: a rebuildable cache of threads and messages from every channel, with FTS5 on bodies.
 * Durable send state (drafts, outbox, approvals) is NOT here; it lives in outbox.db from M3 on, so
 * deleting index.db is always safe.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Channel = "linkedin" | "imessage" | "whatsapp";

const SCHEMA = `
create table if not exists threads (
  id text primary key,                 -- li:<convId> | im:<chat guid> | wa:<chat jid>
  channel text not null,
  native_id text not null,
  title text,
  is_group integer not null default 0,
  last_message_at integer,             -- unix ms
  last_inbound_at integer,
  last_outbound_at integer,
  unread integer not null default 0,
  participants_json text not null default '[]'
);
create index if not exists threads_last on threads(last_message_at desc);

create table if not exists messages (
  id text primary key,                 -- <channel prefix>:<native message id>
  thread_id text not null references threads(id),
  channel text not null,
  native_id text not null,
  ts integer not null,                 -- unix ms
  from_handle text,
  from_name text,
  is_from_me integer not null,
  body text not null,
  kind text not null default 'text',   -- text | media | other
  reply_to_native_id text
);
create index if not exists messages_thread_ts on messages(thread_id, ts);

create virtual table if not exists messages_fts using fts5(
  body, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
create trigger if not exists messages_ai after insert on messages begin
  insert into messages_fts(rowid, body) values (new.rowid, new.body);
end;
create trigger if not exists messages_ad after delete on messages begin
  insert into messages_fts(messages_fts, rowid, body) values ('delete', old.rowid, old.body);
end;
create trigger if not exists messages_au after update of body on messages begin
  insert into messages_fts(messages_fts, rowid, body) values ('delete', old.rowid, old.body);
  insert into messages_fts(rowid, body) values (new.rowid, new.body);
end;

create table if not exists handles (
  channel text not null,
  handle text not null,                -- slug | +phone | email (normalized)
  display_name text,
  person_id text,
  primary key (channel, handle)
);

create table if not exists people (
  id text primary key,                 -- ab:<contacts record id> | li:<slug or profile id>
  display_name text,
  contacts_card_id text,
  linkedin_slug text,
  phones_json text not null default '[]',
  emails_json text not null default '[]'
);

create table if not exists checkpoints (
  source text primary key,
  value text not null,
  updated_at integer not null
);
`;

export function openIndex(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const isNew = !existsSync(path);
  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec(SCHEMA);
  if (isNew) chmodSync(path, 0o600);
  for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) chmodSync(path + side, 0o600);
  return db;
}

export function getCheckpoint(db: Database, source: string): string | null {
  const row = db.query("select value from checkpoints where source = ?").get(source) as { value: string } | null;
  return row?.value ?? null;
}

export function setCheckpoint(db: Database, source: string, value: string): void {
  db.query(
    "insert into checkpoints(source, value, updated_at) values (?, ?, ?) " +
      "on conflict(source) do update set value = excluded.value, updated_at = excluded.updated_at",
  ).run(source, value, Date.now());
}

export interface ThreadRow {
  id: string;
  channel: Channel;
  native_id: string;
  title: string | null;
  is_group: boolean;
  unread: number;
  participants: Array<{ handle: string | null; name: string | null }>;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  channel: Channel;
  native_id: string;
  ts: number;
  from_handle: string | null;
  from_name: string | null;
  is_from_me: boolean;
  body: string;
  kind: "text" | "media" | "other";
  reply_to_native_id: string | null;
}

/** Insert-or-update a thread's descriptive fields; timestamps are recomputed from messages. */
export function upsertThread(db: Database, t: ThreadRow): void {
  db.query(
    `insert into threads(id, channel, native_id, title, is_group, unread, participants_json)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set title = excluded.title, is_group = excluded.is_group,
       unread = excluded.unread, participants_json = excluded.participants_json`,
  ).run(t.id, t.channel, t.native_id, t.title, t.is_group ? 1 : 0, t.unread, JSON.stringify(t.participants));
}

export function upsertMessage(db: Database, m: MessageRow): void {
  db.query(
    `insert into messages(id, thread_id, channel, native_id, ts, from_handle, from_name, is_from_me,
       body, kind, reply_to_native_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set body = excluded.body, from_name = excluded.from_name,
       kind = excluded.kind`,
  ).run(
    m.id,
    m.thread_id,
    m.channel,
    m.native_id,
    m.ts,
    m.from_handle,
    m.from_name,
    m.is_from_me ? 1 : 0,
    m.body,
    m.kind,
    m.reply_to_native_id,
  );
}

/** Recompute a thread's last_* timestamps from its messages. */
export function refreshThreadTimes(db: Database, threadIds: Iterable<string>): void {
  const q = db.query(
    `update threads set
       last_message_at = (select max(ts) from messages where thread_id = ?1),
       last_inbound_at = (select max(ts) from messages where thread_id = ?1 and is_from_me = 0),
       last_outbound_at = (select max(ts) from messages where thread_id = ?1 and is_from_me = 1)
     where id = ?1`,
  );
  for (const id of threadIds) q.run(id);
}

export function upsertHandle(db: Database, channel: Channel, handle: string, displayName: string | null): void {
  db.query(
    `insert into handles(channel, handle, display_name) values (?, ?, ?)
     on conflict(channel, handle) do update set
       display_name = coalesce(excluded.display_name, handles.display_name)`,
  ).run(channel, handle, displayName);
}
