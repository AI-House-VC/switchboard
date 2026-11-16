/**
 * Read queries behind the MCP tools. Every message body leaves here wrapped as
 * { untrusted_text } (docs/DESIGN.md): it was written by a third party and is data, not instructions.
 */
import type { Database } from "bun:sqlite";
import { linkedinSlugFromUrl } from "../adapters/contacts/reader.ts";
import { normHandle } from "../adapters/shared.ts";
import type { Channel } from "./db.ts";

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export interface ThreadOut {
  thread_id: string;
  channel: Channel;
  title: string | null;
  is_group: boolean;
  participants: Array<{ handle: string | null; name: string | null }>;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unread: number;
}

interface ThreadDb {
  id: string;
  channel: Channel;
  title: string | null;
  is_group: number;
  participants_json: string;
  last_message_at: number | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  unread: number;
}

function nameFor(db: Database, channel: string, handle: string | null): string | null {
  if (!handle) return null;
  const r = db.query("select display_name from handles where channel = ? and handle = ?").get(channel, handle) as {
    display_name: string | null;
  } | null;
  return r?.display_name ?? null;
}

function threadOut(db: Database, t: ThreadDb): ThreadOut {
  const participants = (JSON.parse(t.participants_json) as Array<{ handle: string | null; name: string | null }>).map(
    (p) => ({ handle: p.handle, name: p.name ?? nameFor(db, t.channel, p.handle) }),
  );
  let title = t.title;
  if (!title && !t.is_group) title = participants[0]?.name ?? participants[0]?.handle ?? null;
  if (!title && t.is_group) title = participants.map((p) => p.name ?? p.handle).join(", ") || null;
  return {
    thread_id: t.id,
    channel: t.channel,
    title,
    is_group: Boolean(t.is_group),
    participants,
    last_message_at: iso(t.last_message_at),
    last_inbound_at: iso(t.last_inbound_at),
    last_outbound_at: iso(t.last_outbound_at),
    unread: t.unread,
  };
}

export function getThread(db: Database, id: string): ThreadOut | null {
  const t = db.query("select * from threads where id = ?").get(id) as ThreadDb | null;
  return t ? threadOut(db, t) : null;
}

/** Newest inbound message id in a thread: the freshness watermark a send approval is bound to. */
export function newestInboundId(db: Database, threadId: string): string | null {
  const r = db
    .query("select id from messages where thread_id = ? and is_from_me = 0 order by ts desc, rowid desc limit 1")
    .get(threadId) as { id: string } | null;
  return r?.id ?? null;
}

export function listThreads(
  db: Database,
  o: { channel?: Channel; since?: number; unread_only?: boolean; limit?: number },
): ThreadOut[] {
  const rows = db
    .query(
      `select * from threads where last_message_at is not null
         and (?1 is null or channel = ?1) and (?2 is null or last_message_at >= ?2)
         and (?3 = 0 or unread > 0)
       order by last_message_at desc limit ?4`,
    )
    .all(o.channel ?? null, o.since ?? null, o.unread_only ? 1 : 0, o.limit ?? 25) as ThreadDb[];
  return rows.map((t) => threadOut(db, t));
}

export interface MessageOut {
  message_id: string;
  ts: string;
  from: string | null;
  from_handle: string | null;
  is_from_me: boolean;
  kind: string;
  body: { untrusted_text: string };
}

interface MessageDb {
  id: string;
  channel: string;
  ts: number;
  from_handle: string | null;
  from_name: string | null;
  is_from_me: number;
  kind: string;
  body: string;
  thread_id: string;
}

const MAX_BODY = 4000;

function messageOut(db: Database, m: MessageDb): MessageOut {
  const body = m.body.length > MAX_BODY ? `${m.body.slice(0, MAX_BODY)}… [truncated]` : m.body;
  return {
    message_id: m.id,
    ts: new Date(m.ts).toISOString(),
    from: m.is_from_me ? "me" : (m.from_name ?? nameFor(db, m.channel, m.from_handle) ?? m.from_handle),
    from_handle: m.is_from_me ? null : m.from_handle,
    is_from_me: Boolean(m.is_from_me),
    kind: m.kind,
    body: { untrusted_text: body },
  };
}

export function readThread(
  db: Database,
  o: { thread_id: string; limit?: number; before?: number },
): { thread: ThreadOut; messages: MessageOut[] } | null {
  const t = db.query("select * from threads where id = ?").get(o.thread_id) as ThreadDb | null;
  if (!t) return null;
  const rows = db
    .query(
      `select * from (select * from messages where thread_id = ?1 and (?2 is null or ts < ?2)
         order by ts desc limit ?3) order by ts asc`,
    )
    .all(o.thread_id, o.before ?? null, o.limit ?? 50) as MessageDb[];
  return { thread: threadOut(db, t), messages: rows.map((m) => messageOut(db, m)) };
}

/** FTS5 query from free text: each term quoted, so user input can't inject FTS syntax. */
export function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" ");
}

export function searchMessages(
  db: Database,
  o: { query: string; channel?: Channel; person_handles?: string[]; since?: number; limit?: number },
): Array<MessageOut & { thread_id: string; channel: string }> {
  const fts = ftsQuery(o.query);
  if (!fts) return [];
  const handles = o.person_handles ?? null;
  const rows = db
    .query(
      `select m.* from messages_fts f join messages m on m.rowid = f.rowid
       where messages_fts match ?1 and (?2 is null or m.channel = ?2) and (?3 is null or m.ts >= ?3)
         and (?4 is null or m.thread_id in (
           select t.id from threads t, json_each(t.participants_json) j
           where json_extract(j.value, '$.handle') in (select value from json_each(?4))))
       order by m.ts desc limit ?5`,
    )
    .all(
      fts,
      o.channel ?? null,
      o.since ?? null,
      handles ? JSON.stringify(handles) : null,
      o.limit ?? 25,
    ) as MessageDb[];
  return rows.map((m) => ({ ...messageOut(db, m), thread_id: m.thread_id, channel: m.channel }));
}

export type NeedsReplyBucket = "one_to_one" | "group" | "unknown_sender";

export interface NeedsReplyOut extends ThreadOut {
  bucket: NeedsReplyBucket;
  /** contact: on a Contacts card · known: you've replied in this thread before · unknown: neither. Groups: null. */
  sender_kind: "contact" | "known" | "unknown" | null;
  waiting_hours: number;
  /** Inbound messages since your last outbound message in this thread. */
  inbound_since_my_last: number;
  last_inbound_from: string | null;
}

export interface NeedsReplyResult {
  threads: NeedsReplyOut[];
  /** Totals before the per-bucket limit. */
  counts: { one_to_one: number; groups: number; unknown_senders: number; automated_excluded: number };
  truncated: boolean;
}

/** Short codes (fewer than 8 digits) and alphanumeric sender ids: automated, can't be meaningfully answered. */
export function isAutomatedHandle(h: string | null | undefined): boolean {
  if (!h || h.includes("@")) return false;
  if (!h.startsWith("+")) return true;
  return h.replace(/\D/g, "").length < 8;
}

const PHONE_CHANNELS = new Set<Channel>(["imessage", "whatsapp"]);

/**
 * Threads whose last message is inbound and unanswered, in three buckets, each longest-waiting first:
 *   one_to_one      1:1 threads (all LinkedIn 1:1s; phone 1:1s from contacts or people you've replied to)
 *   group           groups, with the inbound count since your last post so the agent can judge
 *   unknown_sender  phone 1:1s from senders not in Contacts whom you've never replied to (mostly
 *                   automated texts, but a new founder on an unsaved number lands here, so it's kept)
 * Short-code and alphanumeric senders are dropped. `limit` applies per bucket.
 */
export function needsReply(
  db: Database,
  o: { since?: number; channels?: Channel[]; min_age_hours?: number; limit?: number; now?: number },
): NeedsReplyResult {
  const now = o.now ?? Date.now();
  const since = o.since ?? now - 14 * 86400_000;
  const maxInbound = now - (o.min_age_hours ?? 0) * 3600_000;
  const limit = o.limit ?? 50;
  const rows = db
    .query(
      `select * from threads
       where last_inbound_at is not null and last_inbound_at = last_message_at
         and last_inbound_at > coalesce(last_outbound_at, 0)
         and last_inbound_at >= ?1 and last_inbound_at <= ?2
         and (?3 is null or channel in (select value from json_each(?3)))
       order by last_inbound_at asc`,
    )
    .all(since, maxInbound, o.channels ? JSON.stringify(o.channels) : null) as ThreadDb[];

  const linked = db.query("select 1 from handles where channel = ? and handle = ? and person_id is not null");
  const buckets: Record<NeedsReplyBucket, ThreadDb[]> = { one_to_one: [], group: [], unknown_sender: [] };
  const kinds = new Map<string, NeedsReplyOut["sender_kind"]>();
  let automated = 0;
  for (const t of rows) {
    if (t.is_group) {
      buckets.group.push(t);
      kinds.set(t.id, null);
      continue;
    }
    const h = (JSON.parse(t.participants_json) as Array<{ handle: string | null }>)[0]?.handle ?? null;
    if (PHONE_CHANNELS.has(t.channel) && isAutomatedHandle(h)) {
      automated++;
      continue;
    }
    const kind = h && linked.get(t.channel, h) ? "contact" : t.last_outbound_at ? "known" : "unknown";
    kinds.set(t.id, kind);
    buckets[kind === "unknown" && PHONE_CHANNELS.has(t.channel) ? "unknown_sender" : "one_to_one"].push(t);
  }

  const out = (t: ThreadDb, bucket: NeedsReplyBucket): NeedsReplyOut => {
    const c = db
      .query("select count(*) as n from messages where thread_id = ? and is_from_me = 0 and ts > ?")
      .get(t.id, t.last_outbound_at ?? 0) as { n: number };
    const last = db
      .query("select * from messages where thread_id = ? and is_from_me = 0 order by ts desc limit 1")
      .get(t.id) as MessageDb | null;
    return {
      ...threadOut(db, t),
      bucket,
      sender_kind: kinds.get(t.id) ?? null,
      waiting_hours: Math.round(((now - (t.last_inbound_at ?? now)) / 3600_000) * 10) / 10,
      inbound_since_my_last: c.n,
      last_inbound_from: last ? messageOut(db, last).from : null,
    };
  };
  const order: NeedsReplyBucket[] = ["one_to_one", "group", "unknown_sender"];
  return {
    threads: order.flatMap((b) => buckets[b].slice(0, limit).map((t) => out(t, b))),
    counts: {
      one_to_one: buckets.one_to_one.length,
      groups: buckets.group.length,
      unknown_senders: buckets.unknown_sender.length,
      automated_excluded: automated,
    },
    truncated: order.some((b) => buckets[b].length > limit),
  };
}

// ---------------------------------------------------------------------------------------------
// find_person
// ---------------------------------------------------------------------------------------------

export interface HandleHint {
  email?: string;
  phone?: string;
  linkedin?: string; // slug or profile URL
}

export interface PersonOut {
  person_id: string | null;
  display_name: string | null;
  /** How the handles were joined: contacts card, caller-supplied handles, or a single channel handle. */
  linked_by: "contacts" | "caller_handles" | "single_handle";
  handles: Array<{ channel: Channel; handle: string }>;
  threads: Array<{ thread_id: string; channel: Channel; title: string | null; last_message_at: string | null }>;
}

function classify(q: string): { kind: "email" | "phone" | "linkedin" | "name"; value: string } {
  const s = q.trim();
  const slug = linkedinSlugFromUrl(s);
  if (slug) return { kind: "linkedin", value: slug };
  if (s.includes("@")) return { kind: "email", value: normHandle(s) };
  if (/^[+\d][\d\s().-]{6,}$/.test(s)) return { kind: "phone", value: normHandle(s) };
  return { kind: "name", value: s };
}

function threadsFor(db: Database, handles: Array<{ channel: Channel; handle: string }>): PersonOut["threads"] {
  if (handles.length === 0) return [];
  const rows = db
    .query(
      `select distinct t.id, t.channel, t.title, t.is_group, t.participants_json, t.last_message_at
       from threads t, json_each(t.participants_json) j
       where t.channel || '|' || json_extract(j.value, '$.handle') in (select value from json_each(?1))
       order by t.last_message_at desc limit 20`,
    )
    .all(JSON.stringify(handles.map((h) => `${h.channel}|${h.handle}`))) as ThreadDb[];
  return rows.map((t) => ({
    thread_id: t.id,
    channel: t.channel,
    title: threadOut(db, t).title,
    last_message_at: iso(t.last_message_at),
  }));
}

function personFromCard(db: Database, personId: string): PersonOut | null {
  const p = db.query("select * from people where id = ?").get(personId) as {
    id: string;
    display_name: string | null;
  } | null;
  if (!p) return null;
  const handles = db
    .query("select channel, handle from handles where person_id = ? order by channel, handle")
    .all(personId) as Array<{
    channel: Channel;
    handle: string;
  }>;
  return {
    person_id: p.id,
    display_name: p.display_name,
    linked_by: "contacts",
    handles,
    threads: threadsFor(db, handles),
  };
}

function singleHandle(db: Database, channel: Channel, handle: string): PersonOut {
  const handles = [{ channel, handle }];
  return {
    person_id: null,
    display_name: nameFor(db, channel, handle),
    linked_by: "single_handle",
    handles,
    threads: threadsFor(db, handles),
  };
}

function lookupHandle(db: Database, channel: Channel | null, handle: string): PersonOut[] {
  const rows = db
    .query("select channel, handle, person_id from handles where handle = ? and (?2 is null or channel = ?2)")
    .all(handle, channel) as Array<{ channel: Channel; handle: string; person_id: string | null }>;
  const out = new Map<string, PersonOut>();
  for (const r of rows) {
    if (r.person_id) {
      const p = personFromCard(db, r.person_id);
      if (p) out.set(p.person_id as string, p);
    } else {
      out.set(`${r.channel}|${r.handle}`, singleHandle(db, r.channel, r.handle));
    }
  }
  return [...out.values()];
}

/**
 * Resolve a name, slug/URL, phone or email to people with their handles and threads.
 * Joins only on exact handles (Contacts card, or `handles` the caller got from a contacts or
 * CRM tool). Never merges on name alone: name matches come back as separate candidates.
 */
export function findPerson(
  db: Database,
  o: { query: string; handles?: HandleHint[] },
): {
  candidates: PersonOut[];
  ambiguous: boolean;
} {
  const c = classify(o.query);
  let candidates: PersonOut[];
  if (c.kind === "linkedin") candidates = lookupHandle(db, "linkedin", c.value);
  else if (c.kind === "email" || c.kind === "phone") candidates = lookupHandle(db, null, c.value);
  else {
    const like = `%${c.value.replace(/[%_]/g, "")}%`;
    const fromPeople = db
      .query("select id from people where display_name like ? collate nocase limit 10")
      .all(like) as Array<{ id: string }>;
    const fromHandles = db
      .query(
        "select channel, handle from handles where person_id is null and display_name like ? collate nocase limit 10",
      )
      .all(like) as Array<{ channel: Channel; handle: string }>;
    candidates = [
      ...fromPeople.map((p) => personFromCard(db, p.id)).filter((p): p is PersonOut => p !== null),
      ...fromHandles.map((h) => singleHandle(db, h.channel, h.handle)),
    ];
  }

  if (o.handles?.length) {
    // Caller-supplied identity (e.g. from a contacts or CRM tool): merge exact handle hits
    // into one person, plus any candidate that shares one of those handles.
    const hinted: Array<{ channel: Channel | null; handle: string }> = [];
    for (const h of o.handles) {
      if (h.email) hinted.push({ channel: null, handle: normHandle(h.email) });
      if (h.phone) hinted.push({ channel: null, handle: normHandle(h.phone) });
      const slug = h.linkedin ? (linkedinSlugFromUrl(h.linkedin) ?? h.linkedin.toLowerCase()) : null;
      if (slug) hinted.push({ channel: "linkedin", handle: slug });
    }
    const hits = hinted.flatMap((h) => lookupHandle(db, h.channel, h.handle));
    if (hits.length > 0) {
      const handles = new Map<string, { channel: Channel; handle: string }>();
      for (const p of hits) for (const h of p.handles) handles.set(`${h.channel}|${h.handle}`, h);
      const merged: PersonOut = {
        person_id: hits.find((p) => p.person_id)?.person_id ?? null,
        display_name: hits.find((p) => p.display_name)?.display_name ?? null,
        linked_by: "caller_handles",
        handles: [...handles.values()],
        threads: threadsFor(db, [...handles.values()]),
      };
      const keys = new Set(handles.keys());
      candidates = [merged, ...candidates.filter((p) => !p.handles.some((h) => keys.has(`${h.channel}|${h.handle}`)))];
    }
  }
  return { candidates, ambiguous: candidates.length > 1 };
}
