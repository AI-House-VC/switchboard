/**
 * iMessage reader. Ported from an earlier Python reader (imessage_sync.py, cmd_sync):
 * temp copy of chat.db, ROWID checkpoint, attributedBody decoding, tapback/system/service rows
 * skipped, handles normalized to +<digits> or lowercased email.
 */
import type { Database } from "bun:sqlite";
import {
  getCheckpoint,
  type MessageRow,
  refreshThreadTimes,
  setCheckpoint,
  type ThreadRow,
  upsertHandle,
  upsertMessage,
  upsertThread,
} from "../../index/db.ts";
import { APPLE_EPOCH_S, appleToUnixMs, decodeAttributedBody, normHandle, withTempCopies } from "../shared.ts";

const CHECKPOINT = "imessage.rowid";
const OBJECT_REPLACEMENT = /￼/g;

export interface IngestResult {
  messages: number;
  threads: number;
  checkpoint: number;
}

interface Row {
  rowid: number;
  guid: string;
  date: number;
  is_from_me: number;
  text: string | null;
  attributedBody: Uint8Array | null;
  handle: string | null;
  chat_id: number | null;
  chat_guid: string | null;
  chat_name: string | null;
  reply_to: string | null;
}

export function ingestIMessage(
  index: Database,
  chatDbPath: string,
  opts: { backfillDays: number; now?: number },
): IngestResult {
  const last = Number(getCheckpoint(index, CHECKPOINT) ?? 0);
  const cutoffApple = Math.floor((opts.now ?? Date.now()) / 1000) - opts.backfillDays * 86400 - APPLE_EPOCH_S;

  return withTempCopies([chatDbPath], (copies) => {
    const src = copies.get(chatDbPath);
    if (!src) throw new Error(`chat.db not found at ${chatDbPath}`);

    const participants = new Map<number, string[]>();
    for (const r of src
      .query(
        "select chj.chat_id as chat_id, h.id as id from chat_handle_join chj join handle h on h.ROWID = chj.handle_id",
      )
      .all() as Array<{ chat_id: number; id: string }>) {
      const list = participants.get(r.chat_id) ?? [];
      list.push(normHandle(r.id));
      participants.set(r.chat_id, list);
    }

    const rows = src
      .query(
        `select m.ROWID as rowid, m.guid as guid, m.date as date, m.is_from_me as is_from_me,
                m.text as text, m.attributedBody as attributedBody, h.id as handle,
                cmj.chat_id as chat_id, c.guid as chat_guid, c.display_name as chat_name,
                m.thread_originator_guid as reply_to
         from message m
         left join handle h on h.ROWID = m.handle_id
         left join chat_message_join cmj on cmj.message_id = m.ROWID
         left join chat c on c.ROWID = cmj.chat_id
         where m.ROWID > ?1
           and coalesce(m.associated_message_type, 0) = 0
           and coalesce(m.item_type, 0) = 0
           and coalesce(m.is_system_message, 0) = 0
           and coalesce(m.is_service_message, 0) = 0
           and (case when m.date > 100000000000 then m.date / 1000000000 else m.date end) >= ?2
         order by m.ROWID`,
      )
      .all(last, cutoffApple) as Row[];

    const touched = new Set<string>();
    let n = 0;
    const write = index.transaction(() => {
      for (const r of rows) {
        if (!r.chat_guid || r.chat_id == null) continue;
        let text = r.text ?? "";
        if (!text) text = decodeAttributedBody(r.attributedBody);
        const hadAttachment = text.includes("￼");
        text = text.replace(OBJECT_REPLACEMENT, "[attachment]").trim();
        if (!text) continue;
        const members = [...new Set(participants.get(r.chat_id) ?? [])].sort();
        const threadId = `im:${r.chat_guid}`;
        if (!touched.has(threadId)) {
          const thread: ThreadRow = {
            id: threadId,
            channel: "imessage",
            native_id: r.chat_guid,
            title: r.chat_name || null,
            is_group: members.length > 1,
            unread: 0,
            participants: members.map((h) => ({ handle: h, name: null })),
          };
          upsertThread(index, thread);
          for (const h of members) upsertHandle(index, "imessage", h, null);
          touched.add(threadId);
        }
        const msg: MessageRow = {
          id: `im:${r.guid}`,
          thread_id: threadId,
          channel: "imessage",
          native_id: r.guid,
          ts: appleToUnixMs(r.date),
          from_handle: r.is_from_me ? null : r.handle ? normHandle(r.handle) : null,
          from_name: null,
          is_from_me: Boolean(r.is_from_me),
          body: text,
          kind: hadAttachment && text === "[attachment]" ? "media" : "text",
          reply_to_native_id: r.reply_to,
        };
        upsertMessage(index, msg);
        n++;
      }
      refreshThreadTimes(index, touched);
      // Advance past skipped rows too, so they aren't rescanned.
      const max = (src.query("select coalesce(max(ROWID), 0) as m from message").get() as { m: number }).m;
      const next = Math.max(last, max, rows.at(-1)?.rowid ?? 0);
      setCheckpoint(index, CHECKPOINT, String(next));
      return next;
    });
    const checkpoint = write();
    return { messages: n, threads: touched.size, checkpoint };
  });
}
