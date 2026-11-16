/**
 * The one send path (docs/DESIGN.md). send_message and send_draft both come through `send`; approval from
 * elicitation or the local page both come through `approve`; every dispatch goes through `dispatch`,
 * which re-checks policy, payload, freshness and caps, then moves the operation to `dispatching`
 * exactly once before any adapter runs. Nothing here retries a send.
 *
 * Known gap (docs/DESIGN.md): approval can come from MCP elicitation or the loopback page, and
 * neither is proven to be a human: a local process running as the user can reach both.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditLog } from "../audit.ts";
import type { Config, SendPolicy } from "../config.ts";
import type { Channel } from "../index/db.ts";
import { getThread, newestInboundId, readThread } from "../index/queries.ts";
import { type Draft, type Operation, type OpStatus, type Outbox, type Target, TERMINAL } from "../outbox/db.ts";
import type { Dispatcher, DispatchResult, LinkedInDispatcher, WhatsAppDispatcher } from "./dispatch.ts";
import { resolveTarget, SendError, type SendRequest } from "./resolve.ts";

export { SendError };

export const MAX_BODY = 8000;
const WHATSAPP_WATCH_MS = 10 * 60_000;

export type ElicitFn = (message: string) => Promise<"approve" | "decline" | "unavailable">;

export interface SendDeps {
  index: Database;
  outbox: Outbox;
  config: Config;
  audit: AuditLog;
  dispatchers: Record<Channel, Dispatcher>;
  whatsapp?: WhatsAppDispatcher;
  /** Bring the index up to date for a channel before a freshness check. */
  refresh: (channel: Channel) => void;
  /** Tell the human an approval is waiting (Mac notification + open the page). */
  notify: (op: Operation, url: string | null) => void;
  approvalUrl: (op: Operation) => string | null;
  /** Poll interval and window for the WhatsApp handoff watcher. */
  watchPollMs?: number;
  watchWindowMs?: number;
  /** Max time to wait for per-minute caps / minimum spacing before giving up. */
  maxCapWaitMs?: number;
}

export interface SendArgs {
  body: string;
  idempotency_key?: string;
  dry_run?: boolean;
  expected_last_inbound_id?: string;
  draft_id?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export function payloadHash(account: string, t: Target, body: string): string {
  return sha(JSON.stringify([account, t.channel, t.thread_id, t.native, t.service ?? null, t.is_group, body]));
}

function tokensEqual(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const CHANNEL_NAME: Record<Channel, string> = { linkedin: "LinkedIn", imessage: "iMessage", whatsapp: "WhatsApp" };

export class SendService {
  private chains = new Map<string, Promise<unknown>>();
  private stopped = new Map<Channel, string>();
  private watchers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private d: SendDeps) {}

  get account(): string {
    return this.d.config.account_id;
  }

  get approvalTtlMs(): number {
    return this.d.config.approval_ttl_minutes * 60_000;
  }

  // ------------------------------------------------------------------------------------------ policy

  /** Effective policy for a client label. Unknown clients fail closed. */
  policyFor(client: string): SendPolicy {
    const c = this.d.config.clients[client];
    if (!c) throw new SendError("unknown_client", `Client '${client}' is not on this install's allowlist.`);
    if (c.send_policy === "autonomous" && this.d.config.profile !== "allow-autonomous")
      throw new SendError(
        "policy_unavailable",
        "autonomous sending is off in this install (every send needs your approval). " +
          "Set this client's send_policy to confirm, or set profile to allow-autonomous in config.json.",
      );
    return c.send_policy;
  }

  private inAutonomousScope(t: Target): boolean {
    const a = this.d.config.autonomous;
    if (!t.thread_id || !a.thread_ids.includes(t.thread_id)) return false;
    if (!a.expires_at || Date.parse(a.expires_at) <= Date.now()) return false;
    const today = this.d.outbox.db
      .query("select count(*) as n from operations where approved_via = 'autonomous' and dispatched_at >= ?")
      .get(Date.now() - 86400_000) as { n: number };
    return today.n < a.max_per_day;
  }

  /** May this client approve through its harness's elicitation form? `mac_page` clients never do. */
  harnessApproval(client: string): boolean {
    return (this.d.config.clients[client]?.approval ?? "harness") === "harness";
  }

  /** Per-channel capability and policy summary for channel_status. */
  sendStatus(client: string): Record<string, unknown> {
    let policy: string;
    try {
      policy = this.policyFor(client);
    } catch (e) {
      policy = e instanceof SendError ? e.code : "error";
    }
    const day = Date.now() - 86400_000;
    return {
      policy,
      approval:
        (this.harnessApproval(client)
          ? "elicitation in the harness when offered, else a Mac notification + local approval page. "
          : "a Mac notification + local approval page only (this client never approves in the harness). ") +
        "Known gap: neither is proven to be a human (any local process can reach the page).",
      linkedin: {
        sends_last_24h: this.d.outbox.dispatchCount("linkedin", day),
        max_per_day: this.d.config.linkedin.max_sends_per_day,
        stopped: this.stopped.get("linkedin") ?? null,
      },
      imessage: {
        sends_last_24h: this.d.outbox.dispatchCount("imessage", day),
        max_per_day: this.d.config.imessage.max_sends_per_day,
        group_send: this.d.config.imessage.group_send,
      },
      whatsapp: { mode: "prefill handoff: you press Enter in WhatsApp" },
    };
  }

  // ------------------------------------------------------------------------------------------ preview

  private context(t: Target, n = 3): Array<{ from: string; at: string; text: string }> {
    if (!t.thread_id) return [];
    const r = readThread(this.d.index, { thread_id: t.thread_id, limit: n });
    return (r?.messages ?? []).map((m) => ({
      from: m.is_from_me ? "me" : (m.from ?? "them"),
      at: m.ts,
      text: m.body.untrusted_text.slice(0, 300),
    }));
  }

  preview(t: Target, body: string, policy: string) {
    return {
      account: this.account,
      channel: t.channel,
      to: t.display,
      handles: t.handles,
      thread_id: t.thread_id,
      new_conversation: t.thread_id === null,
      is_group: t.is_group,
      body,
      policy,
      delivery:
        t.channel === "whatsapp"
          ? t.is_group
            ? "copy_and_open: you paste and press Enter in WhatsApp"
            : "prefill: WhatsApp opens with the text typed in; you press Enter"
          : "dispatched by Switchboard after approval",
    };
  }

  /** What a human reads before approving: exact account, channel, recipients, full text, recent context. */
  approvalText(op: Operation): string {
    const t = op.target;
    const ctx = this.context(t)
      .map((m) => `  [${m.at.slice(0, 16).replace("T", " ")}] ${m.from}: ${m.text}`)
      .join("\n");
    return [
      `Send this ${CHANNEL_NAME[t.channel]} message?`,
      `Account: ${this.account}  ·  Requested by: ${op.client}`,
      `To: ${t.display}${t.handles.length ? ` (${t.handles.join(", ")})` : ""}${t.is_group ? " [group]" : ""}`,
      t.thread_id ? `Thread: ${t.thread_id}` : "New conversation",
      ctx ? `Recent messages (third-party text):\n${ctx}` : "",
      "Message (exact text):",
      "────────",
      op.body ?? "",
      "────────",
      t.channel === "whatsapp" ? "Approving opens WhatsApp with this text; you still press Enter there." : "",
      `Approval expires ${op.expires_at ? new Date(op.expires_at).toLocaleTimeString() : ""}. Operation ${op.id}.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  statusOut(op: Operation) {
    return {
      operation_id: op.id,
      status: op.status,
      channel: op.channel,
      to: op.target.display,
      thread_id: op.target.thread_id,
      policy: op.policy,
      native_message_id: op.native_id,
      detail: op.detail,
      approved_via: op.approved_via,
      approval_url: op.status === "awaiting_approval" ? this.d.approvalUrl(op) : undefined,
      expires_at:
        op.status === "awaiting_approval" && op.expires_at ? new Date(op.expires_at).toISOString() : undefined,
      draft_id: op.draft_id,
      created_at: new Date(op.created_at).toISOString(),
      dispatched_at: op.dispatched_at ? new Date(op.dispatched_at).toISOString() : null,
    };
  }

  private auditOp(event: string, op: Operation, extra: Record<string, unknown> = {}): void {
    this.d.audit.write({
      event,
      client: op.client,
      operation_id: op.id,
      channel: op.channel,
      policy: op.policy,
      status: op.status,
      payload_hash: op.payload_hash.slice(0, 16),
      idem_hash: op.idem_hash.slice(0, 16),
      approved_via: op.approved_via,
      native_id: op.native_id,
      body_chars: op.body?.length ?? 0,
      ...extra,
    });
  }

  // ------------------------------------------------------------------------------------------ send

  async send(client: string, req: SendRequest, a: SendArgs, elicit?: ElicitFn) {
    const policy = this.policyFor(client);
    const body = a.body;
    if (!body.trim()) throw new SendError("bad_body", "Message text is empty.");
    if (body.length > MAX_BODY) throw new SendError("bad_body", `Message text is over ${MAX_BODY} characters.`);
    const target = resolveTarget(this.d.index, this.d.config, req);
    const mode = this.d.config.channels[target.channel];
    if (mode === "off")
      throw new SendError("channel_off", `${target.channel} is switched off in Switchboard settings.`);
    if (mode === "read")
      throw new SendError(
        "channel_read_only",
        `${target.channel} is read-only in Switchboard settings: the user can switch it to read & write in Switchboard.app.`,
      );
    if (this.stopped.has(target.channel) && !a.dry_run)
      throw new SendError("channel_stopped", this.stopped.get(target.channel) as string);

    const watermark = target.thread_id ? newestInboundId(this.d.index, target.thread_id) : null;
    if (a.expected_last_inbound_id !== undefined && a.expected_last_inbound_id !== watermark)
      return {
        status: "stale" as const,
        detail: "The thread has newer inbound messages than expected_last_inbound_id. Read it and decide again.",
        current_last_inbound_id: watermark,
      };

    const preview = this.preview(target, body, policy);
    if (policy === "draft-only")
      return { status: "draft_only" as const, preview, detail: "This client may compose but not send." };
    if (a.dry_run)
      return {
        status: "dry_run" as const,
        preview,
        would: policy === "autonomous" && this.inAutonomousScope(target) ? "dispatch" : "ask for approval",
        last_inbound_id: watermark,
        note: "Nothing sent, opened or reserved. LinkedIn recipients aren't verified with LinkedIn in a dry run.",
      };

    const key = a.idempotency_key ?? "";
    if (key.length < 8 || key.length > 200)
      throw new SendError(
        "bad_idempotency_key",
        "idempotency_key is required (8–200 chars), unique per intended message.",
      );
    const idemHash = sha(`${this.account}\u0000${client}\u0000${key}`);
    const pHash = payloadHash(this.account, target, body);
    const existing = this.d.outbox.byIdempotency(this.account, client, idemHash);
    if (existing) {
      if (existing.payload_hash !== pHash)
        throw new SendError(
          "idempotency_conflict",
          `idempotency_key was already used for a different message (operation ${existing.id}).`,
        );
      return { ...this.statusOut(this.expireIfDue(existing)), replayed: true };
    }

    if (target.channel === "linkedin" && !target.thread_id) await this.checkNewLinkedIn(target.native);

    const now = Date.now();
    const autonomous = policy === "autonomous" && this.inAutonomousScope(target);
    const op: Operation = {
      id: newId("op"),
      account: this.account,
      client,
      idem_hash: idemHash,
      payload_hash: pHash,
      policy,
      channel: target.channel,
      target,
      body,
      watermark,
      status: autonomous ? "approved" : "awaiting_approval",
      approval_token: autonomous ? null : randomBytes(24).toString("base64url"),
      approved_via: autonomous ? "autonomous" : null,
      expires_at: autonomous ? null : now + this.d.config.approval_ttl_minutes * 60_000,
      draft_id: a.draft_id ?? null,
      native_id: null,
      detail: autonomous ? `autonomous scope ${this.d.config.autonomous.config_ref ?? "(unnamed)"}` : null,
      created_at: now,
      updated_at: now,
      dispatched_at: null,
    };
    // Synchronous with the lookup above (no await in between), so concurrent calls can't both insert.
    this.d.outbox.insert(op);
    if (op.draft_id) this.d.outbox.updateDraft(op.draft_id, { status: "in_flight", operation_id: op.id });
    this.auditOp("send_requested", op);

    if (autonomous) return this.statusOut(await this.dispatch(op.id));

    if (elicit && !this.harnessApproval(client)) elicit = undefined;
    if (elicit) {
      let answer: Awaited<ReturnType<ElicitFn>> = "unavailable";
      try {
        answer = await elicit(this.approvalText(op));
      } catch {
        answer = "unavailable";
      }
      if (answer === "approve")
        return this.statusOut(await this.approve(op.id, op.approval_token as string, "elicitation"));
      if (answer === "decline") return this.statusOut(this.decline(op.id, op.approval_token as string, "elicitation"));
    }
    this.d.notify(op, this.d.approvalUrl(op));
    return {
      ...this.statusOut(op),
      note:
        "Waiting for the human to approve on this Mac (notification + approval page). Call get_send_status later; " +
        "don't re-send with a new idempotency_key.",
    };
  }

  private expireIfDue(op: Operation): Operation {
    if (op.status === "awaiting_approval" && op.expires_at && op.expires_at <= Date.now()) {
      if (
        this.d.outbox.transition(op.id, "awaiting_approval", "expired", {
          approval_token: null,
          detail: "approval window passed",
        })
      )
        this.auditOp("send_expired", this.d.outbox.get(op.id) as Operation);
      this.finishDraft(op.id);
      return this.d.outbox.get(op.id) as Operation;
    }
    return op;
  }

  getStatus(id: string) {
    const op = this.d.outbox.get(id);
    if (!op || op.account !== this.account) throw new SendError("not_found", `No operation ${id}.`);
    return this.statusOut(this.expireIfDue(op));
  }

  getStatusSafe(id: string): ReturnType<SendService["statusOut"]> | null {
    try {
      return this.getStatus(id);
    } catch {
      return null;
    }
  }

  /**
   * A "new" LinkedIn conversation may already exist on LinkedIn without being synced. allman's pre-send
   * check would then abort every send as stale after the human approved, and the approval page couldn't
   * show the thread. Refuse before asking for approval instead.
   */
  private async checkNewLinkedIn(slug: string): Promise<void> {
    const li = this.d.dispatchers.linkedin as Partial<LinkedInDispatcher>;
    const p = li.probe ? await li.probe.call(li, slug) : null;
    if (!p || p.is_new || !p.conv_id) return;
    const tid = `li:${p.conv_id}`;
    if (getThread(this.d.index, tid))
      throw new SendError(
        "existing_thread",
        `There is already a LinkedIn conversation with this person (${tid}). Read it, then send with thread_id ${tid}.`,
      );
    throw new SendError(
      "not_synced",
      "There is already a LinkedIn conversation with this person that Switchboard hasn't synced, so it can't " +
        "check for replies you haven't read. Sync older LinkedIn history (`allman sync --from <date>`), then try again.",
    );
  }

  /** For the approval page: the operation, if the token matches. */
  forApproval(id: string, token: string): Operation | null {
    const op = this.d.outbox.get(id);
    if (!op || !tokensEqual(op.approval_token, token)) return null;
    return this.expireIfDue(op);
  }

  // ------------------------------------------------------------------------------------------ approval

  async approve(id: string, token: string, via: string): Promise<Operation> {
    const op = this.forApproval(id, token);
    if (!op) throw new SendError("bad_approval", "Unknown operation or wrong approval token.");
    if (op.status !== "awaiting_approval")
      throw new SendError("not_awaiting", `Operation is ${op.status}; an approval can be used once.`);
    // Single use: the token is cleared in the same compare-and-set that moves the op on.
    if (!this.d.outbox.transition(id, "awaiting_approval", "approved", { approved_via: via, approval_token: null }))
      throw new SendError("not_awaiting", "Operation is no longer awaiting approval.");
    this.auditOp("send_approved", this.d.outbox.get(id) as Operation);
    return this.dispatch(id);
  }

  decline(id: string, token: string, via: string): Operation {
    const op = this.forApproval(id, token);
    if (!op) throw new SendError("bad_approval", "Unknown operation or wrong approval token.");
    this.d.outbox.transition(id, "awaiting_approval", "cancelled", {
      approval_token: null,
      approved_via: via,
      detail: "declined by the approver",
    });
    const out = this.d.outbox.get(id) as Operation;
    this.auditOp("send_declined", out);
    this.finishDraft(id);
    return out;
  }

  /** Cancel a pending approval (draft edited or discarded). */
  private cancelPending(id: string, why: string): void {
    if (this.d.outbox.transition(id, "awaiting_approval", "cancelled", { approval_token: null, detail: why }))
      this.auditOp("send_cancelled", this.d.outbox.get(id) as Operation);
  }

  // ------------------------------------------------------------------------------------------ dispatch

  /** Serialize per account so caps, freshness checks and dispatch never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(this.account) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      this.account,
      next.catch(() => {}),
    );
    return next;
  }

  private finish(
    id: string,
    to: OpStatus,
    fields: Parameters<Outbox["transition"]>[3],
    from: OpStatus[] = ["approved"],
  ) {
    this.d.outbox.transition(id, from, to, fields);
    const op = this.d.outbox.get(id) as Operation;
    this.auditOp("send_result", op);
    this.finishDraft(id);
    return op;
  }

  private async capWait(channel: Channel): Promise<string | null> {
    const day = Date.now() - 86400_000;
    if (channel === "linkedin") {
      const c = this.d.config.linkedin;
      if (this.d.outbox.dispatchCount("linkedin", day) >= c.max_sends_per_day)
        return `LinkedIn daily cap reached (${c.max_sends_per_day}/24h).`;
      const deadline = Date.now() + (this.d.maxCapWaitMs ?? 90_000);
      while (true) {
        const last = this.d.outbox.lastDispatchAt("linkedin") ?? 0;
        const spacing = last + c.min_interval_seconds * 1000 - Date.now();
        const minuteFull = this.d.outbox.dispatchCount("linkedin", Date.now() - 60_000) >= c.max_sends_per_minute;
        if (spacing <= 0 && !minuteFull) return null;
        if (Date.now() >= deadline) return "LinkedIn per-minute cap or spacing; try again shortly.";
        await Bun.sleep(Math.max(250, Math.min(spacing > 0 ? spacing : 1000, 5000)));
      }
    }
    if (channel === "imessage") {
      const max = this.d.config.imessage.max_sends_per_day;
      if (this.d.outbox.dispatchCount("imessage", day) >= max) return `iMessage daily cap reached (${max}/24h).`;
    }
    return null;
  }

  dispatch(id: string): Promise<Operation> {
    return this.serial(async () => {
      const op = this.d.outbox.get(id) as Operation;
      if (op.status !== "approved") return op;

      // Policy may have changed since the request.
      try {
        if (this.policyFor(op.client) === "draft-only")
          return this.finish(id, "cancelled", { detail: "client policy is now draft-only" });
      } catch (e) {
        return this.finish(id, "cancelled", { detail: e instanceof Error ? e.message : "policy check failed" });
      }
      if (op.body === null || payloadHash(op.account, op.target, op.body) !== op.payload_hash)
        return this.finish(id, "failed", { detail: "payload changed after approval; not sent" });
      const stop = this.stopped.get(op.channel);
      if (stop) return this.finish(id, "failed", { detail: stop });

      // Freshness: newest inbound now vs. when the human saw it.
      try {
        this.d.refresh(op.channel);
      } catch {}
      if (op.target.thread_id) {
        const now = newestInboundId(this.d.index, op.target.thread_id);
        if (now !== op.watermark)
          return this.finish(id, "stale", {
            detail: "New inbound message(s) since this was approved. Read the thread and decide again.",
          });
      }

      const capped = await this.capWait(op.channel);
      if (capped) return this.finish(id, "rate_limited", { detail: capped });

      // The single point of no return: approved → dispatching, once.
      if (!this.d.outbox.transition(id, "approved", "dispatching", { dispatched_at: Date.now() }))
        return this.d.outbox.get(id) as Operation;
      this.auditOp("send_dispatching", this.d.outbox.get(id) as Operation);

      let r: DispatchResult;
      try {
        r = await this.d.dispatchers[op.channel].dispatch(op);
      } catch {
        r = { status: "unconfirmed", detail: "Adapter error during dispatch; outcome unknown. Not retried." };
      }
      if (r.stop_channel) this.stopped.set(op.channel, r.detail ?? "stopped");
      const out = this.finish(id, r.status, { native_id: r.native_id ?? null, detail: r.detail ?? null }, [
        "dispatching",
      ]);
      if (out.status === "awaiting_user_send") this.watchWhatsApp(out);
      return out;
    });
  }

  // ------------------------------------------------------------------------------------------ WhatsApp watch

  watchWhatsApp(op: Operation): void {
    const wa = this.d.whatsapp;
    if (!wa || this.watchers.has(op.id)) return;
    const afterPk = Number(/watch_after_pk=(\d+)/.exec(op.detail ?? "")?.[1] ?? 0);
    const deadline = (op.dispatched_at ?? Date.now()) + (this.d.watchWindowMs ?? WHATSAPP_WATCH_MS);
    const tick = () => {
      let r: DispatchResult | null = null;
      try {
        r = wa.check(op, afterPk);
      } catch {}
      if (!r && Date.now() < deadline) return;
      clearInterval(timer);
      this.watchers.delete(op.id);
      const final = r ?? {
        status: "opened_not_sent" as const,
        detail: "WhatsApp was opened with the text, but no matching sent message appeared within 10 minutes.",
      };
      this.finish(op.id, final.status, { native_id: final.native_id ?? null, detail: final.detail ?? null }, [
        "awaiting_user_send",
      ]);
    };
    const timer = setInterval(tick, this.d.watchPollMs ?? 3000);
    this.watchers.set(op.id, timer);
  }

  // ------------------------------------------------------------------------------------------ restart

  /**
   * After a restart: an approval that never reached dispatch is cancelled (never sent on reconnect);
   * an operation caught mid-dispatch is reconciled against the index, else marked unconfirmed;
   * WhatsApp handoffs resume watching.
   */
  recover(): { cancelled: number; reconciled: number; unconfirmed: number } {
    let cancelled = 0;
    let reconciled = 0;
    let unconfirmed = 0;
    for (const op of this.d.outbox.inStatus("approved")) {
      this.finish(op.id, "cancelled", {
        detail: "daemon restarted before dispatch; not sent. Send again if still wanted.",
      });
      cancelled++;
    }
    for (const op of this.d.outbox.inStatus("dispatching")) {
      try {
        this.d.refresh(op.channel);
      } catch {}
      const hit = this.findSentInIndex(op);
      if (hit) {
        this.finish(op.id, "sent", { native_id: hit, detail: "reconciled after restart from the local store" }, [
          "dispatching",
        ]);
        reconciled++;
      } else {
        this.finish(
          op.id,
          "unconfirmed",
          { detail: "daemon stopped during dispatch; no sent copy found. Not retried." },
          ["dispatching"],
        );
        unconfirmed++;
      }
    }
    for (const op of this.d.outbox.inStatus("awaiting_user_send")) this.watchWhatsApp(op);
    for (const op of this.d.outbox.inStatus("awaiting_approval")) this.expireIfDue(op);
    return { cancelled, reconciled, unconfirmed };
  }

  private findSentInIndex(op: Operation): string | null {
    const since = (op.dispatched_at ?? op.created_at) - 60_000;
    const rows = this.d.index
      .query(
        `select m.native_id as id, m.thread_id as thread_id from messages m
         where m.channel = ? and m.is_from_me = 1 and m.ts >= ? and m.body = ?`,
      )
      .all(op.channel, since, op.body ?? "") as Array<{ id: string; thread_id: string }>;
    const hit = rows.find((r) => !op.target.thread_id || r.thread_id === op.target.thread_id);
    return hit?.id ?? null;
  }

  /** Expire stale approvals and purge old bodies. Called on a timer. */
  housekeeping(): void {
    for (const op of this.d.outbox.inStatus("awaiting_approval")) this.expireIfDue(op);
    this.d.outbox.purgeBodies(Date.now() - this.d.config.outbox_body_retention_days * 86400_000);
  }

  stop(): void {
    for (const t of this.watchers.values()) clearInterval(t);
    this.watchers.clear();
  }

  // ------------------------------------------------------------------------------------------ drafts

  draft(client: string, req: SendRequest, body: string, note?: string) {
    this.policyFor(client);
    if (!body.trim()) throw new SendError("bad_body", "Message text is empty.");
    if (body.length > MAX_BODY) throw new SendError("bad_body", `Message text is over ${MAX_BODY} characters.`);
    const target = resolveTarget(this.d.index, this.d.config, req);
    const now = Date.now();
    const d: Draft = {
      id: newId("dr"),
      account: this.account,
      client,
      channel: target.channel,
      target,
      body,
      note: note ?? null,
      status: "pending",
      operation_id: null,
      created_at: now,
      updated_at: now,
    };
    this.d.outbox.insertDraft(d);
    this.d.audit.write({ event: "draft_saved", client, draft_id: d.id, channel: d.channel, body_chars: body.length });
    return this.draftOut(d);
  }

  draftOut(d: Draft) {
    return {
      draft_id: d.id,
      status: d.status,
      channel: d.channel,
      to: d.target.display,
      thread_id: d.target.thread_id,
      body: d.body,
      note: d.note,
      operation_id: d.operation_id,
      updated_at: new Date(d.updated_at).toISOString(),
    };
  }

  private ownDraft(id: string): Draft {
    const d = this.d.outbox.getDraft(id);
    if (!d || d.account !== this.account) throw new SendError("not_found", `No draft ${id}.`);
    return d;
  }

  listDrafts(status?: string) {
    return this.d.outbox.listDrafts(this.account, status).map((d) => this.draftOut(d));
  }

  updateDraft(id: string, body: string) {
    const d = this.ownDraft(id);
    if (d.status === "sent" || d.status === "discarded") throw new SendError("not_editable", `Draft is ${d.status}.`);
    if (!body.trim() || body.length > MAX_BODY) throw new SendError("bad_body", "Message text is empty or too long.");
    if (d.operation_id) this.cancelPending(d.operation_id, "draft edited after the send was requested");
    this.d.outbox.updateDraft(id, { body, status: "pending", operation_id: null });
    return this.draftOut(this.ownDraft(id));
  }

  discardDraft(id: string) {
    const d = this.ownDraft(id);
    if (d.operation_id) this.cancelPending(d.operation_id, "draft discarded");
    this.d.outbox.updateDraft(id, { status: "discarded" });
    return this.draftOut(this.ownDraft(id));
  }

  async sendDraft(client: string, id: string, a: { idempotency_key?: string; dry_run?: boolean }, elicit?: ElicitFn) {
    const d = this.ownDraft(id);
    if (d.status !== "pending")
      throw new SendError(
        "not_pending",
        `Draft is ${d.status}${d.operation_id ? ` (operation ${d.operation_id})` : ""}.`,
      );
    const t = d.target;
    const req: SendRequest = t.thread_id
      ? { thread_id: t.thread_id }
      : { channel: t.channel, to: t.channel === "linkedin" ? t.native : (t.handles[0] ?? t.native) };
    return this.send(client, req, { body: d.body ?? "", ...a, draft_id: a.dry_run ? undefined : d.id }, elicit);
  }

  private finishDraft(opId: string): void {
    const op = this.d.outbox.get(opId);
    if (!op?.draft_id || !TERMINAL.has(op.status)) return;
    const d = this.d.outbox.getDraft(op.draft_id);
    if (!d || d.operation_id !== opId) return;
    this.d.outbox.updateDraft(d.id, { status: op.status === "sent" ? "sent" : "pending" });
  }

  /** Thread title for notifications (no content). */
  threadLabel(t: Target): string {
    return t.thread_id ? (getThread(this.d.index, t.thread_id)?.title ?? t.display) : t.display;
  }
}
