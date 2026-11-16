/**
 * Channel dispatchers. Each gets one already-approved, already-reserved operation and reports what
 * happened; none of them retries. Message text and recipients are always passed as argv elements,
 * never interpolated into a shell, AppleScript source or allman option.
 *
 * Output from allman and osascript can contain message text (allman's pre-send abort prints the new
 * inbound messages), so it is only pattern-matched here and never stored or logged.
 */
import type { Database } from "bun:sqlite";
import type { AllmanOpts } from "../adapters/linkedin/allman.ts";
import { decodeAttributedBody, normHandle, withTempCopies } from "../adapters/shared.ts";
import { handleForJid, lidMap, whatsappFiles } from "../adapters/whatsapp/reader.ts";
import type { Operation, OpStatus } from "../outbox/db.ts";

export interface DispatchResult {
  status: OpStatus;
  native_id?: string | null;
  /** Short, content-free reason (shown to the agent and audited). */
  detail?: string | null;
  /** Set when the channel must stop sending until the owner looks (auth challenge, restriction). */
  stop_channel?: string;
}

export interface Dispatcher {
  dispatch(op: Operation): Promise<DispatchResult>;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function run(cmd: string[], timeoutMs: number): Promise<Spawned> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A grandchild can keep the pipes open after the kill, so the timeout doesn't wait for EOF.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs);
  });
  const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const r = await Promise.race([done, timeout]);
  clearTimeout(timer);
  if (!r) return { code: null, stdout: "", stderr: "", timedOut: true };
  const [stdout, stderr, code] = r;
  return { code, stdout, stderr, timedOut: false };
}

// ---------------------------------------------------------------------------------------- LinkedIn

const LI_STOP = /log ?in|authenticat|challenge|captcha|checkpoint|restrict|suspend|banned|\b40[13]\b|\b429\b|too many/i;

/** `allman send <convId|slug> <text> --json`, options first and `--` before the positionals. */
export function allmanSendArgv(o: AllmanOpts, to: string, text: string): string[] {
  const out = [o.bin, "send", "--json", "--store", o.store];
  if (o.account) out.push("--account", o.account);
  out.push("--", to, text);
  return out;
}

export class LinkedInDispatcher implements Dispatcher {
  constructor(
    private allman: () => AllmanOpts | null,
    private timeoutMs = 90_000,
  ) {}

  async dispatch(op: Operation): Promise<DispatchResult> {
    const o = this.allman();
    if (!o) return { status: "failed", detail: "Pinned allman binary not found." };
    const r = await run(allmanSendArgv(o, op.target.native, op.body ?? ""), this.timeoutMs);
    if (r.timedOut)
      return {
        status: "unconfirmed",
        detail: "allman send timed out; the message may or may not have gone. Not retried.",
      };
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { messageUrn?: string };
        return {
          status: "sent",
          native_id: j.messageUrn ?? null,
          detail: "accepted by LinkedIn (not proof of delivery)",
        };
      } catch {
        return { status: "unconfirmed", detail: "allman exited 0 without JSON output." };
      }
    }
    if (/received before send/i.test(r.stderr))
      return {
        status: "stale",
        detail:
          "New LinkedIn message(s) arrived before sending (allman pre-send check). Read the thread and decide again.",
      };
    if (LI_STOP.test(r.stderr))
      return {
        status: "failed",
        detail: `LinkedIn refused the send (auth, challenge or rate signal, exit ${r.code}). LinkedIn sending is stopped until the daemon restarts; run \`switchboard doctor\`.`,
        stop_channel: "linkedin",
      };
    return { status: "failed", detail: `allman send failed (exit ${r.code}).` };
  }

  /**
   * Ask allman (dry run: nothing sent) whether LinkedIn already has a 1:1 conversation with `slug`.
   * allman's own pre-send check compares against its local copy of that conversation, so an existing
   * conversation it never synced makes every send "stale" after approval. Found live, 2026-11-07.
   * Returns null if allman can't answer (offline, auth); the pre-send check still guards the send.
   */
  async probe(slug: string): Promise<{ conv_id: string | null; is_new: boolean } | null> {
    const o = this.allman();
    if (!o) return null;
    const argv = allmanSendArgv(o, slug, "(dry run)");
    argv.splice(2, 0, "--dry-run");
    const r = await run(argv, 30_000);
    if (r.timedOut || r.code !== 0) return null;
    try {
      const j = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
        convId?: string | null;
        isNewConversation?: boolean;
      };
      return { conv_id: j.convId ?? null, is_new: j.isNewConversation === true };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------------------- iMessage

/** Text and target arrive as argv (`on run argv`), so message text can never become AppleScript. */
export const IMESSAGE_SCRIPT = `on run argv
  set theText to item 1 of argv
  set theTarget to item 2 of argv
  set theKind to item 3 of argv
  tell application "Messages"
    if theKind is "chat" then
      send theText to chat id theTarget
    else
      if theKind is "SMS" then
        set svc to 1st account whose service type = SMS
      else
        set svc to 1st account whose service type = iMessage
      end if
      send theText to participant theTarget of svc
    end if
  end tell
end run`;

interface OutRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  error: number;
  chat_guid: string | null;
  handle: string | null;
}

export class IMessageDispatcher implements Dispatcher {
  constructor(
    private chatDb: string,
    private osascript: string,
    private opts: { confirmWindowMs: number; pollMs: number } = { confirmWindowMs: 30_000, pollMs: 1_000 },
  ) {}

  private maxRowid(): number {
    return withTempCopies([this.chatDb], (c) => {
      const db = c.get(this.chatDb) as Database;
      return (db.query("select coalesce(max(ROWID), 0) as m from message").get() as { m: number }).m;
    });
  }

  private findOutbound(op: Operation, after: number): OutRow | null {
    return withTempCopies([this.chatDb], (c) => {
      const db = c.get(this.chatDb) as Database;
      const rows = db
        .query(
          `select m.ROWID as rowid, m.guid as guid, m.text as text, m.attributedBody as attributedBody,
                  coalesce(m.error, 0) as error, c.guid as chat_guid, h.id as handle
           from message m
           left join chat_message_join cmj on cmj.message_id = m.ROWID
           left join chat c on c.ROWID = cmj.chat_id
           left join handle h on h.ROWID = m.handle_id
           where m.ROWID > ? and m.is_from_me = 1 order by m.ROWID`,
        )
        .all(after) as OutRow[];
      const want = (op.body ?? "").trim();
      for (const r of rows) {
        const text = (r.text ?? decodeAttributedBody(r.attributedBody)).trim();
        if (text !== want) continue;
        if (op.target.is_group) {
          if (r.chat_guid === op.target.native) return r;
        } else {
          const peer = r.chat_guid?.split(";")[2] ?? r.handle ?? "";
          if (normHandle(peer) === op.target.native || normHandle(r.handle) === op.target.native) return r;
        }
      }
      return null;
    });
  }

  async dispatch(op: Operation): Promise<DispatchResult> {
    let before: number;
    try {
      before = this.maxRowid();
    } catch {
      return { status: "failed", detail: "Can't read chat.db to confirm a send (Full Disk Access?). Not sent." };
    }
    const kind = op.target.is_group ? "chat" : (op.target.service ?? "iMessage");
    const r = await run([this.osascript, "-e", IMESSAGE_SCRIPT, op.body ?? "", op.target.native, kind], 30_000);
    if (r.timedOut) return this.confirm(op, before, "Messages didn't answer in 30s");
    if (r.code !== 0) {
      if (/-1743|not authori[sz]ed/i.test(r.stderr))
        return {
          status: "failed",
          detail:
            "macOS blocked Switchboard from controlling Messages. Allow it in System Settings → Privacy & Security → Automation.",
        };
      return { status: "failed", detail: `Messages refused the send (osascript exit ${r.code}).` };
    }
    return this.confirm(op, before, null);
  }

  /** Handed to Messages is not sent: wait for the is_from_me row and read its error column. */
  private async confirm(op: Operation, before: number, why: string | null): Promise<DispatchResult> {
    const deadline = Date.now() + this.opts.confirmWindowMs;
    while (Date.now() < deadline) {
      let row: OutRow | null = null;
      try {
        row = this.findOutbound(op, before);
      } catch {}
      if (row)
        return row.error
          ? { status: "failed", native_id: row.guid, detail: `Messages recorded a send error (${row.error}).` }
          : { status: "sent", native_id: row.guid, detail: "in chat.db; delivery not confirmed" };
      await Bun.sleep(this.opts.pollMs);
    }
    return {
      status: "unconfirmed",
      detail: `${why ? `${why}; ` : ""}no matching sent row in chat.db within ${Math.round(this.opts.confirmWindowMs / 1000)}s. Not retried.`,
    };
  }
}

// ---------------------------------------------------------------------------------------- WhatsApp

export function whatsappUrl(digits: string, text: string): string {
  return `whatsapp://send?phone=${encodeURIComponent(digits)}&text=${encodeURIComponent(text)}`;
}

/**
 * Prefill, never automation: open the chat with the text typed in; the human presses Enter in WhatsApp.
 * Groups can't be opened by URL, so they get Copy & Open (text on the clipboard, WhatsApp brought forward).
 */
export class WhatsAppDispatcher implements Dispatcher {
  constructor(
    private bins: { open: string; pbcopy: string },
    private dir: string,
  ) {}

  /** Highest ZWAMESSAGE pk now, so the watcher only considers rows written after the handoff. */
  maxPk(): number {
    const f = whatsappFiles(this.dir);
    return withTempCopies([f.chatStorage], (c) => {
      const db = c.get(f.chatStorage);
      if (!db) return 0;
      return (db.query("select coalesce(max(Z_PK), 0) as m from ZWAMESSAGE").get() as { m: number }).m;
    });
  }

  async dispatch(op: Operation): Promise<DispatchResult> {
    let pk = 0;
    try {
      pk = this.maxPk();
    } catch {}
    if (op.target.is_group) {
      const copy = Bun.spawn([this.bins.pbcopy], {
        stdin: new TextEncoder().encode(op.body ?? ""),
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env },
      });
      await copy.exited;
      const r = await run([this.bins.open, "-a", "WhatsApp"], 15_000);
      if (r.code !== 0) return { status: "failed", detail: "Couldn't open WhatsApp." };
      return {
        status: "awaiting_user_send",
        native_id: null,
        detail: `copy_and_open: text is on the clipboard; open the group in WhatsApp, paste and press Enter yourself. watch_after_pk=${pk}`,
      };
    }
    const r = await run([this.bins.open, whatsappUrl(op.target.native, op.body ?? "")], 15_000);
    if (r.code !== 0) return { status: "failed", detail: "Couldn't open WhatsApp (is the desktop app installed?)." };
    return {
      status: "awaiting_user_send",
      detail: `prefilled: WhatsApp is open with the text typed in; press Enter in WhatsApp to send. watch_after_pk=${pk}`,
    };
  }

  /**
   * Look for the human's send: an outbound row in this chat after the handoff. Exact text → sent;
   * a different outbound text → unconfirmed (edited, or another message); nothing → null (keep waiting).
   */
  check(op: Operation, afterPk: number): DispatchResult | null {
    const f = whatsappFiles(this.dir);
    return withTempCopies([f.chatStorage, f.lid, f.contacts], (c) => {
      const cs = c.get(f.chatStorage);
      if (!cs) return null;
      const rows = cs
        .query(
          `select m.Z_PK as pk, m.ZTEXT as text, m.ZSTANZAID as stanza, s.ZCONTACTJID as jid
           from ZWAMESSAGE m join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION
           where m.Z_PK > ? and m.ZISFROMME = 1 order by m.Z_PK`,
        )
        .all(afterPk) as Array<{ pk: number; text: string | null; stanza: string | null; jid: string }>;
      const lids = lidMap(c.get(f.lid), c.get(f.contacts));
      const mine = rows.filter((r) =>
        op.target.is_group ? r.jid === op.target.native : handleForJid(r.jid, lids) === `+${op.target.native}`,
      );
      if (mine.length === 0) return null;
      const exact = mine.find((r) => (r.text ?? "").trim() === (op.body ?? "").trim());
      if (exact)
        return { status: "sent", native_id: exact.stanza ?? String(exact.pk), detail: "sent by you in WhatsApp" };
      return {
        status: "unconfirmed",
        detail:
          "An outbound WhatsApp message appeared in this chat, but its text differs (edited or a different message).",
      };
    });
  }
}
