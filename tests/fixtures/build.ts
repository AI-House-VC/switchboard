/**
 * Synthetic source databases with the real schemas' relevant columns. All names, numbers
 * (555-01xx), emails (example.com) and text are invented.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unixMsToApple } from "../../src/adapters/shared.ts";

/** Anchored to the current hour so fixtures stay inside the 12-month window whenever tests run. */
export const NOW = Math.floor(Date.now() / 3600_000) * 3600_000;
export const H = 3600_000;
export const D = 86400_000;

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "sb-test-"));
}

/** NSAttributedString-ish typedstream blob carrying `text`, matching the decoder's byte rule. */
export function attributedBody(text: string): Uint8Array {
  const t = Buffer.from(text, "utf8");
  const head = Buffer.from(
    "\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+",
    "latin1",
  );
  let len: Buffer;
  if (t.length < 0x80) len = Buffer.from([t.length]);
  else {
    len = Buffer.alloc(3);
    len[0] = 0x81;
    len.writeUInt16LE(t.length, 1);
  }
  return new Uint8Array(Buffer.concat([head, len, t, Buffer.from("\x86\x84", "latin1")]));
}

// ---------------------------------------------------------------- iMessage

export interface IMsg {
  chat: string; // chat guid
  from?: string | null; // handle id, null = me
  me?: boolean;
  text?: string | null;
  body?: string; // goes into attributedBody with text null
  at: number; // unix ms
  tapback?: boolean;
  system?: boolean;
}

export function buildChatDb(
  path: string,
  chats: Array<{ guid: string; name?: string; members: string[] }>,
  msgs: IMsg[],
) {
  const db = new Database(path, { create: true });
  db.exec(`
    create table handle (ROWID integer primary key autoincrement, id text not null, service text not null default 'iMessage');
    create table chat (ROWID integer primary key autoincrement, guid text unique not null, style integer, chat_identifier text, display_name text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table message (ROWID integer primary key autoincrement, guid text unique not null, text text, handle_id integer default 0,
      attributedBody blob, date integer, is_from_me integer default 0, is_system_message integer default 0,
      is_service_message integer default 0, item_type integer default 0, associated_message_type integer default 0,
      thread_originator_guid text, error integer default 0, is_delivered integer default 0);
    create table chat_message_join (chat_id integer, message_id integer, message_date integer default 0);
  `);
  const handleIds = new Map<string, number>();
  const hid = (h: string) => {
    if (!handleIds.has(h)) {
      db.query("insert into handle(id) values (?)").run(h);
      handleIds.set(h, Number((db.query("select last_insert_rowid() as r").get() as { r: number }).r));
    }
    return handleIds.get(h) as number;
  };
  const chatIds = new Map<string, number>();
  for (const c of chats) {
    db.query("insert into chat(guid, style, display_name) values (?, ?, ?)").run(
      c.guid,
      c.members.length > 1 ? 43 : 45,
      c.name ?? "",
    );
    const cid = Number((db.query("select last_insert_rowid() as r").get() as { r: number }).r);
    chatIds.set(c.guid, cid);
    for (const m of c.members) db.query("insert into chat_handle_join values (?, ?)").run(cid, hid(m));
  }
  addIMessages(db, chatIds, hid, msgs);
  db.close();
  return { chatIds };
}

let imSeq = 0;
function addIMessages(db: Database, chatIds: Map<string, number>, hid: (h: string) => number, msgs: IMsg[]) {
  for (const m of msgs) {
    const guid = `msg-${++imSeq}`;
    db.query(
      `insert into message(guid, text, handle_id, attributedBody, date, is_from_me, is_system_message, associated_message_type)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guid,
      m.body !== undefined ? null : (m.text ?? null),
      m.me || !m.from ? 0 : hid(m.from),
      m.body !== undefined ? attributedBody(m.body) : null,
      unixMsToApple(m.at, true),
      m.me ? 1 : 0,
      m.system ? 1 : 0,
      m.tapback ? 2000 : 0,
    );
    const mid = Number((db.query("select last_insert_rowid() as r").get() as { r: number }).r);
    db.query("insert into chat_message_join(chat_id, message_id) values (?, ?)").run(chatIds.get(m.chat) ?? null, mid);
  }
}

export function appendChatDb(path: string, msgs: IMsg[]) {
  const db = new Database(path);
  const chatIds = new Map<string, number>();
  for (const r of db.query("select ROWID as id, guid from chat").all() as Array<{ id: number; guid: string }>)
    chatIds.set(r.guid, r.id);
  const hid = (h: string) => {
    const r = db.query("select ROWID as id from handle where id = ?").get(h) as { id: number } | null;
    if (r) return r.id;
    db.query("insert into handle(id) values (?)").run(h);
    return Number((db.query("select last_insert_rowid() as r").get() as { r: number }).r);
  };
  addIMessages(db, chatIds, hid, msgs);
  db.close();
}

// ---------------------------------------------------------------- WhatsApp

export interface WaSession {
  pk: number;
  jid: string;
  type: 0 | 1 | 2 | 3; // 0 = 1:1, 1 = group, others = broadcast/status
  name: string;
  members?: Array<{ pk: number; jid: string; name?: string }>;
}

export interface WaMsg {
  session: number;
  me?: boolean;
  text?: string | null;
  type?: number;
  at: number;
  gm?: number;
  push?: string;
}

export function buildWhatsApp(dir: string, sessions: WaSession[], msgs: WaMsg[], lid: Array<[string, string]> = []) {
  mkdirSync(dir, { recursive: true });
  const cs = new Database(join(dir, "ChatStorage.sqlite"), { create: true });
  cs.exec(`
    create table ZWACHATSESSION (Z_PK integer primary key, ZCONTACTJID text, ZSESSIONTYPE integer, ZPARTNERNAME text, ZUNREADCOUNT integer);
    create table ZWAGROUPMEMBER (Z_PK integer primary key, ZCHATSESSION integer, ZMEMBERJID text, ZCONTACTNAME text, ZISACTIVE integer);
    create table ZWAMESSAGE (Z_PK integer primary key autoincrement, ZCHATSESSION integer, ZMESSAGEDATE real, ZISFROMME integer,
      ZMESSAGETYPE integer, ZTEXT text, ZGROUPMEMBER integer, ZPUSHNAME text, ZSTANZAID text);
  `);
  for (const s of sessions) {
    cs.query("insert into ZWACHATSESSION values (?, ?, ?, ?, 0)").run(s.pk, s.jid, s.type, s.name);
    for (const m of s.members ?? [])
      cs.query("insert into ZWAGROUPMEMBER values (?, ?, ?, ?, 1)").run(m.pk, s.pk, m.jid, m.name ?? null);
  }
  cs.close();
  appendWhatsApp(dir, msgs);
  const l = new Database(join(dir, "LID.sqlite"), { create: true });
  l.exec("create table ZWAZACCOUNT (Z_PK integer primary key, ZIDENTIFIER text, ZPHONENUMBER text)");
  for (const [id, phone] of lid)
    l.query("insert into ZWAZACCOUNT(ZIDENTIFIER, ZPHONENUMBER) values (?, ?)").run(id, phone);
  l.close();
  const c = new Database(join(dir, "ContactsV2.sqlite"), { create: true });
  c.exec("create table ZWAADDRESSBOOKCONTACT (Z_PK integer primary key, ZLID text, ZPHONENUMBER text)");
  c.close();
}

let waSeq = 0;
export function appendWhatsApp(dir: string, msgs: WaMsg[]) {
  const cs = new Database(join(dir, "ChatStorage.sqlite"));
  for (const m of msgs) {
    cs.query(
      "insert into ZWAMESSAGE(ZCHATSESSION, ZMESSAGEDATE, ZISFROMME, ZMESSAGETYPE, ZTEXT, ZGROUPMEMBER, ZPUSHNAME, ZSTANZAID) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      m.session,
      unixMsToApple(m.at, false),
      m.me ? 1 : 0,
      m.type ?? 0,
      m.text ?? null,
      m.gm ?? null,
      m.push ?? null,
      `stanza-${++waSeq}`,
    );
  }
  cs.close();
}

// ---------------------------------------------------------------- Contacts

export interface Card {
  first: string;
  last: string;
  phones?: string[];
  emails?: string[];
  linkedinUrl?: string;
  linkedinSocialUser?: string;
}

export function buildAddressBook(dir: string, cards: Card[]) {
  const src = join(dir, "Sources", "SRC-1");
  mkdirSync(src, { recursive: true });
  const db = new Database(join(src, "AddressBook-v22.abcddb"), { create: true });
  db.exec(`
    create table ZABCDRECORD (Z_PK integer primary key, ZFIRSTNAME text, ZLASTNAME text, ZORGANIZATION text);
    create table ZABCDPHONENUMBER (Z_PK integer primary key, ZOWNER integer, ZFULLNUMBER text);
    create table ZABCDEMAILADDRESS (Z_PK integer primary key, ZOWNER integer, ZADDRESS text);
    create table ZABCDURLADDRESS (Z_PK integer primary key, ZOWNER integer, ZURL text);
    create table ZABCDSOCIALPROFILE (Z_PK integer primary key, ZOWNER integer, ZSERVICENAME text, ZURLSTRING text, ZUSERNAME text);
  `);
  cards.forEach((c, i) => {
    const pk = i + 1;
    db.query("insert into ZABCDRECORD values (?, ?, ?, null)").run(pk, c.first, c.last);
    for (const p of c.phones ?? [])
      db.query("insert into ZABCDPHONENUMBER(ZOWNER, ZFULLNUMBER) values (?, ?)").run(pk, p);
    for (const e of c.emails ?? [])
      db.query("insert into ZABCDEMAILADDRESS(ZOWNER, ZADDRESS) values (?, ?)").run(pk, e);
    if (c.linkedinUrl) db.query("insert into ZABCDURLADDRESS(ZOWNER, ZURL) values (?, ?)").run(pk, c.linkedinUrl);
    if (c.linkedinSocialUser)
      db.query("insert into ZABCDSOCIALPROFILE(ZOWNER, ZSERVICENAME, ZUSERNAME) values (?, 'LinkedIn', ?)").run(
        pk,
        c.linkedinSocialUser,
      );
  });
  db.close();
}

// ---------------------------------------------------------------- allman store

export interface LiConv {
  convId: string;
  profileId: string;
  slug: string | null;
  name: string;
  group?: Array<{ profileId: string; slug: string | null; name: string }>;
  title?: string | null;
  unread?: number;
  messages: Array<{ urn: string; at: number; me?: boolean; fromProfileId?: string; body: string }>;
}

export function buildAllmanStore(store: string, me: { profileId: string; slug: string }, convs: LiConv[]) {
  const acct = join(store, me.profileId);
  mkdirSync(acct, { recursive: true });
  writeFileSync(
    join(acct, "AUTH.json"),
    JSON.stringify({
      urn: `urn:li:fsd_profile:${me.profileId}`,
      profileSlug: me.slug,
      name: "Test Owner",
      status: "authenticated",
      lastSyncAt: null,
    }),
  );
  symlinkSync(me.profileId, join(store, me.slug));
  mkdirSync(join(acct, "connections"), { recursive: true });
  for (const c of convs) writeConversation(acct, c);
  return acct;
}

export function writeConversation(acct: string, c: LiConv) {
  const dir = join(acct, c.convId);
  mkdirSync(join(dir, "messages"), { recursive: true });
  const participants = c.group?.map((p) => ({
    profileId: p.profileId,
    profileUrn: `urn:li:fsd_profile:${p.profileId}`,
    backendUrn: null,
    slug: p.slug,
    firstName: p.name.split(" ")[0],
    lastName: p.name.split(" ")[1] ?? "",
    name: p.name,
  }));
  writeFileSync(
    join(dir, "RECORD.json"),
    JSON.stringify({
      convId: c.convId,
      profileId: c.profileId,
      slug: c.group ? null : c.slug,
      isGroup: Boolean(c.group),
      title: c.title ?? null,
      participants,
      convUrn: `urn:li:msg_conversation:${c.convId}`,
      profileUrn: `urn:li:fsd_profile:${c.profileId}`,
      name: c.name,
      unreadCount: c.unread ?? 0,
    }),
  );
  const byMonth = new Map<string, string[]>();
  for (const m of c.messages) {
    const month = new Date(m.at).toISOString().slice(0, 7);
    const from = m.me ? "urn:li:fsd_profile:ME" : `urn:li:fsd_profile:${m.fromProfileId ?? c.profileId}`;
    const line = JSON.stringify({
      urn: m.urn,
      timestamp: m.at,
      fromUrn: from,
      fromName: m.me ? "Test Owner" : (c.group?.find((p) => p.profileId === m.fromProfileId)?.name ?? c.name),
      isFromMe: Boolean(m.me),
      body: m.body,
      reactions: [],
      attachments: [],
      originToken: null,
    });
    byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
  }
  for (const [month, lines] of byMonth) writeFileSync(join(dir, "messages", `${month}.jsonl`), `${lines.join("\n")}\n`);
  if (!c.group && c.slug && !existsSync(join(acct, c.slug))) symlinkSync(c.convId, join(acct, c.slug));
}
