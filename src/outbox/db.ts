/**
 * outbox.db: durable send state (operations and drafts). Separate from index.db, which is a rebuildable
 * cache, so an index rebuild never loses an approval, an in-flight send or duplicate-send protection.
 * File mode 0600. Message bodies are kept only here (never in logs) and purged after the retention window.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Channel } from "../index/db.ts";

export type OpStatus =
  | "awaiting_approval"
  | "approved"
  | "dispatching"
  | "sent"
  | "stale"
  | "failed"
  | "cancelled"
  | "expired"
  | "unconfirmed"
  | "rate_limited"
  | "awaiting_user_send"
  | "opened_not_sent";

/** States an operation never leaves. */
export const TERMINAL: ReadonlySet<OpStatus> = new Set([
  "sent",
  "stale",
  "failed",
  "cancelled",
  "expired",
  "unconfirmed",
  "rate_limited",
  "opened_not_sent",
]);

/** Where a message goes, fully resolved before anyone approves it. */
export interface Target {
  channel: Channel;
  /** Index thread id, or null for a new 1:1 conversation. */
  thread_id: string | null;
  /** What the adapter is given: LinkedIn conv id or slug; iMessage handle or chat guid; WhatsApp digits or group jid. */
  native: string;
  /** iMessage service for 1:1 sends. */
  service?: "iMessage" | "SMS";
  is_group: boolean;
  /** For people reading an approval: name and handle(s). Never used for routing. */
  display: string;
  handles: string[];
}

export interface Operation {
  id: string;
  account: string;
  client: string;
  idem_hash: string;
  payload_hash: string;
  policy: string;
  channel: Channel;
  target: Target;
  body: string | null;
  /** Newest inbound message id in the thread when the operation was created (null: none / new thread). */
  watermark: string | null;
  status: OpStatus;
  approval_token: string | null;
  approved_via: string | null;
  expires_at: number | null;
  draft_id: string | null;
  native_id: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
}

export interface Draft {
  id: string;
  account: string;
  client: string;
  channel: Channel;
  target: Target;
  body: string | null;
  note: string | null;
  status: "pending" | "sent" | "discarded" | "in_flight" | "failed";
  operation_id: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
create table if not exists operations (
  id text primary key,
  account text not null,
  client text not null,
  idem_hash text not null,
  payload_hash text not null,
  policy text not null,
  channel text not null,
  target_json text not null,
  body text,
  watermark text,
  status text not null,
  approval_token text,
  approved_via text,
  expires_at integer,
  draft_id text,
  native_id text,
  detail text,
  created_at integer not null,
  updated_at integer not null,
  dispatched_at integer,
  unique (account, client, idem_hash)
);
create index if not exists operations_dispatched on operations(channel, dispatched_at);
create table if not exists drafts (
  id text primary key,
  account text not null,
  client text not null,
  channel text not null,
  target_json text not null,
  body text,
  note text,
  status text not null,
  operation_id text,
  created_at integer not null,
  updated_at integer not null
);
`;

export function openOutbox(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const isNew = !existsSync(path);
  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
  db.exec(SCHEMA);
  if (isNew) chmodSync(path, 0o600);
  for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) chmodSync(path + side, 0o600);
  return db;
}

type OpRow = Omit<Operation, "target"> & { target_json: string };
type DraftRow = Omit<Draft, "target"> & { target_json: string };

function toOp(r: OpRow | null): Operation | null {
  if (!r) return null;
  const { target_json, ...rest } = r;
  return { ...rest, target: JSON.parse(target_json) };
}

function toDraft(r: DraftRow | null): Draft | null {
  if (!r) return null;
  const { target_json, ...rest } = r;
  return { ...rest, target: JSON.parse(target_json) };
}

export class Outbox {
  constructor(readonly db: Database) {}

  get(id: string): Operation | null {
    return toOp(this.db.query("select * from operations where id = ?").get(id) as OpRow | null);
  }

  byIdempotency(account: string, client: string, idemHash: string): Operation | null {
    return toOp(
      this.db
        .query("select * from operations where account = ? and client = ? and idem_hash = ?")
        .get(account, client, idemHash) as OpRow | null,
    );
  }

  /** Insert a new operation. Throws on a duplicate (account, client, idem_hash). */
  insert(op: Operation): void {
    this.db
      .query(
        `insert into operations(id, account, client, idem_hash, payload_hash, policy, channel, target_json, body,
           watermark, status, approval_token, approved_via, expires_at, draft_id, native_id, detail, created_at,
           updated_at, dispatched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.id,
        op.account,
        op.client,
        op.idem_hash,
        op.payload_hash,
        op.policy,
        op.channel,
        JSON.stringify(op.target),
        op.body,
        op.watermark,
        op.status,
        op.approval_token,
        op.approved_via,
        op.expires_at,
        op.draft_id,
        op.native_id,
        op.detail,
        op.created_at,
        op.updated_at,
        op.dispatched_at,
      );
  }

  /**
   * Compare-and-set the status. Returns false (and changes nothing) if the operation isn't in `from`,
   * which is how approvals are single-use and dispatch happens at most once.
   */
  transition(
    id: string,
    from: OpStatus | OpStatus[],
    to: OpStatus,
    fields: Partial<Pick<Operation, "approved_via" | "native_id" | "detail" | "dispatched_at" | "approval_token">> = {},
  ): boolean {
    const froms = Array.isArray(from) ? from : [from];
    const sets = ["status = ?", "updated_at = ?"];
    const vals: Array<string | number | null> = [to, Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v as string | number | null);
    }
    const r = this.db
      .query(`update operations set ${sets.join(", ")} where id = ? and status in (${froms.map(() => "?").join(",")})`)
      .run(...vals, id, ...froms);
    return r.changes === 1;
  }

  inStatus(status: OpStatus): Operation[] {
    return (this.db.query("select * from operations where status = ?").all(status) as OpRow[]).map(
      (r) => toOp(r) as Operation,
    );
  }

  /** Dispatch attempts on a channel since `sinceMs` (counted conservatively, whatever the outcome). */
  dispatchCount(channel: Channel, sinceMs: number): number {
    return (
      this.db
        .query("select count(*) as n from operations where channel = ? and dispatched_at >= ?")
        .get(channel, sinceMs) as { n: number }
    ).n;
  }

  lastDispatchAt(channel: Channel): number | null {
    return (
      this.db.query("select max(dispatched_at) as t from operations where channel = ?").get(channel) as {
        t: number | null;
      }
    ).t;
  }

  /** Purge bodies of finished operations and drafts older than the retention window. */
  purgeBodies(olderThanMs: number): number {
    const terminal = [...TERMINAL];
    const a = this.db
      .query(
        `update operations set body = null where body is not null and updated_at < ? and status in (${terminal.map(() => "?").join(",")})`,
      )
      .run(olderThanMs, ...terminal).changes;
    const b = this.db
      .query(
        "update drafts set body = null where body is not null and updated_at < ? and status in ('sent','discarded','failed')",
      )
      .run(olderThanMs).changes;
    return a + b;
  }

  // ------------------------------------------------------------- drafts

  insertDraft(d: Draft): void {
    this.db
      .query(
        `insert into drafts(id, account, client, channel, target_json, body, note, status, operation_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.account,
        d.client,
        d.channel,
        JSON.stringify(d.target),
        d.body,
        d.note,
        d.status,
        d.operation_id,
        d.created_at,
        d.updated_at,
      );
  }

  getDraft(id: string): Draft | null {
    return toDraft(this.db.query("select * from drafts where id = ?").get(id) as DraftRow | null);
  }

  listDrafts(account: string, status?: string): Draft[] {
    const rows = status
      ? this.db
          .query("select * from drafts where account = ? and status = ? order by updated_at desc")
          .all(account, status)
      : this.db.query("select * from drafts where account = ? order by updated_at desc").all(account);
    return (rows as DraftRow[]).map((r) => toDraft(r) as Draft);
  }

  updateDraft(id: string, fields: Partial<Pick<Draft, "body" | "status" | "operation_id">>): void {
    const sets = ["updated_at = ?"];
    const vals: Array<string | number | null> = [Date.now()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v as string | null);
    }
    this.db.query(`update drafts set ${sets.join(", ")} where id = ?`).run(...vals, id);
  }
}
