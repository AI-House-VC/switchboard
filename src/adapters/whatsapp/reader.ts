/**
 * WhatsApp reader. Ported from an earlier Python reader (whatsapp_sync.py, cmd_sync):
 * temp copies of ChatStorage/LID/ContactsV2, Z_PK checkpoint, @lid ids resolved to phone numbers,
 * media as labels, system messages/broadcasts/status skipped, and groups larger than group_max
 * left out of the index entirely so large-group chatter is never stored.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  getCheckpoint,
  refreshThreadTimes,
  setCheckpoint,
  upsertHandle,
  upsertMessage,
  upsertThread,
} from "../../index/db.ts";
import { APPLE_EPOCH_S, appleToUnixMs, normHandle, safeName, withTempCopies } from "../shared.ts";

const CHECKPOINT = "whatsapp.pk";
const SYSTEM_TYPES = new Set([6, 10]); // group events (joins, renames), system/security notices
export const MEDIA_LABEL: Record<number, string> = {
  1: "[photo]",
  2: "[video]",
  3: "[voice note]",
  4: "[contact]",
  5: "[location]",
  8: "[file]",
  15: "[sticker]",
};

export function whatsappFiles(dir: string) {
  return {
    chatStorage: join(dir, "ChatStorage.sqlite"),
    lid: join(dir, "LID.sqlite"),
    contacts: join(dir, "ContactsV2.sqlite"),
  };
}

/** private '<n>@lid' id → phone number, from WhatsApp's own account and address-book tables. */
export function lidMap(lidDb: Database | undefined, contactsDb: Database | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const pull = (db: Database | undefined, sql: string) => {
    if (!db) return;
    try {
      for (const r of db.query(sql).all() as Array<{ lid: string | null; phone: string | null }>) {
        if (r.lid && r.phone) {
          const key = r.lid.split("@")[0] ?? r.lid;
          if (!out.has(key)) out.set(key, r.phone);
        }
      }
    } catch {
      // a source without the expected table: skip it, as the earlier reader did
    }
  };
  pull(lidDb, "select ZIDENTIFIER as lid, ZPHONENUMBER as phone from ZWAZACCOUNT");
  pull(contactsDb, "select ZLID as lid, ZPHONENUMBER as phone from ZWAADDRESSBOOKCONTACT");
  return out;
}

/** A WhatsApp jid → the same '+<digits>' handle iMessage uses, or null for unresolvable ids. */
export function handleForJid(jid: string | null | undefined, lids: Map<string, string>): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  const user = at < 0 ? jid : jid.slice(0, at);
  const server = at < 0 ? "" : jid.slice(at + 1);
  if (server === "s.whatsapp.net") return normHandle(user);
  if (server === "lid") {
    const phone = lids.get(user);
    return phone ? normHandle(phone) : null;
  }
  return null;
}

export function ingestWhatsApp(
  index: Database,
  dir: string,
  opts: { backfillDays: number; groupMax: number; now?: number },
): { messages: number; threads: number; skippedLargeGroups: number; checkpoint: number } {
  const f = whatsappFiles(dir);
  const last = Number(getCheckpoint(index, CHECKPOINT) ?? 0);
  const cutoff = Math.floor((opts.now ?? Date.now()) / 1000) - opts.backfillDays * 86400 - APPLE_EPOCH_S;

  return withTempCopies([f.chatStorage, f.lid, f.contacts], (copies) => {
    const cs = copies.get(f.chatStorage);
    if (!cs) throw new Error(`WhatsApp ChatStorage.sqlite not found in ${dir}`);
    const lids = lidMap(copies.get(f.lid), copies.get(f.contacts));

    const sessions = new Map<number, { jid: string; type: number; name: string | null; unread: number }>();
    for (const s of cs
      .query(
        "select Z_PK as pk, ZCONTACTJID as jid, ZSESSIONTYPE as type, ZPARTNERNAME as name, ZUNREADCOUNT as unread from ZWACHATSESSION",
      )
      .all() as Array<{ pk: number; jid: string; type: number; name: string | null; unread: number | null }>) {
      sessions.set(s.pk, { jid: s.jid, type: s.type, name: s.name, unread: s.unread ?? 0 });
    }

    const memberCount = new Map<number, number>();
    const memberHandles = new Map<number, Set<string>>();
    const memberByPk = new Map<number, { handle: string | null; name: string | null }>();
    for (const g of cs
      .query(
        "select Z_PK as pk, ZCHATSESSION as session, ZMEMBERJID as jid, ZCONTACTNAME as name, coalesce(ZISACTIVE, 1) as active from ZWAGROUPMEMBER",
      )
      .all() as Array<{ pk: number; session: number; jid: string; name: string | null; active: number }>) {
      const h = handleForJid(g.jid, lids);
      memberByPk.set(g.pk, { handle: h, name: g.name });
      if (!g.active) continue;
      memberCount.set(g.session, (memberCount.get(g.session) ?? 0) + 1);
      if (h) {
        const set = memberHandles.get(g.session) ?? new Set<string>();
        set.add(h);
        memberHandles.set(g.session, set);
      }
    }

    const rows = cs
      .query(
        `select Z_PK as pk, ZCHATSESSION as session, ZMESSAGEDATE as date, ZISFROMME as from_me,
                ZMESSAGETYPE as type, ZTEXT as text, ZGROUPMEMBER as gm, ZPUSHNAME as push, ZSTANZAID as stanza
         from ZWAMESSAGE where Z_PK > ?1 and ZMESSAGEDATE >= ?2 order by Z_PK`,
      )
      .all(last, cutoff) as Array<{
      pk: number;
      session: number;
      date: number | null;
      from_me: number;
      type: number;
      text: string | null;
      gm: number | null;
      push: string | null;
      stanza: string | null;
    }>;

    const touched = new Set<string>();
    const largeGroups = new Set<number>();
    let n = 0;
    const write = index.transaction(() => {
      for (const r of rows) {
        const s = sessions.get(r.session);
        if (!s || SYSTEM_TYPES.has(r.type) || (s.type !== 0 && s.type !== 1) || !s.jid || !r.date) continue;
        const group = s.type === 1;
        if (group && (memberCount.get(r.session) ?? 0) > opts.groupMax) {
          largeGroups.add(r.session);
          continue; // never stored
        }
        const peer = group ? null : handleForJid(s.jid, lids);
        const members = group ? [...(memberHandles.get(r.session) ?? [])].sort() : peer ? [peer] : [];
        const body = (r.text ?? "").trim() || MEDIA_LABEL[r.type] || "";
        if (!body) continue;
        const threadId = `wa:${s.jid}`;
        if (!touched.has(threadId)) {
          upsertThread(index, {
            id: threadId,
            channel: "whatsapp",
            native_id: s.jid,
            title: safeName(s.name),
            is_group: group,
            unread: s.unread,
            participants: members.map((h) => ({ handle: h, name: group ? null : safeName(s.name) })),
          });
          for (const h of members) upsertHandle(index, "whatsapp", h, group ? null : safeName(s.name));
          touched.add(threadId);
        }
        const sender = r.from_me ? null : group ? memberByPk.get(r.gm ?? -1) : { handle: peer, name: s.name };
        upsertMessage(index, {
          id: `wa:${s.jid}:${r.stanza ?? r.pk}`,
          thread_id: threadId,
          channel: "whatsapp",
          native_id: r.stanza ?? String(r.pk),
          ts: appleToUnixMs(r.date),
          from_handle: sender?.handle ?? null,
          from_name: safeName(sender?.name ?? r.push),
          is_from_me: Boolean(r.from_me),
          body,
          kind: r.text ? "text" : "media",
          reply_to_native_id: null,
        });
        n++;
      }
      refreshThreadTimes(index, touched);
      // A small group that has since grown past group_max is purged, so the rule holds over time.
      for (const [session, count] of memberCount) {
        const s = sessions.get(session);
        if (s?.type !== 1 || count <= opts.groupMax) continue;
        index.query("delete from messages where thread_id = ?").run(`wa:${s.jid}`);
        index.query("delete from threads where id = ?").run(`wa:${s.jid}`);
      }
      const max = (cs.query("select coalesce(max(Z_PK), 0) as m from ZWAMESSAGE").get() as { m: number }).m;
      const next = Math.max(last, max);
      setCheckpoint(index, CHECKPOINT, String(next));
      return next;
    });
    const checkpoint = write();
    return { messages: n, threads: touched.size, skippedLargeGroups: largeGroups.size, checkpoint };
  });
}
