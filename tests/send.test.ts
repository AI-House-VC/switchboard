/**
 * M3 acceptance tests (docs/DESIGN.md) against synthetic adapters only: the fake allman, a fake osascript that
 * writes the row Messages would write into the fixture chat.db, and fake open/pbcopy. Nothing here can
 * reach LinkedIn, Messages or WhatsApp.
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestContacts } from "../src/adapters/contacts/reader.ts";
import { ingestIMessage } from "../src/adapters/imessage/reader.ts";
import { ingestLinkedIn } from "../src/adapters/linkedin/store.ts";
import { ingestWhatsApp } from "../src/adapters/whatsapp/reader.ts";
import { AuditLog } from "../src/audit.ts";
import { type Config, DEFAULT_CONFIG } from "../src/config.ts";
import { type Channel, openIndex } from "../src/index/db.ts";
import { type Operation, Outbox, openOutbox } from "../src/outbox/db.ts";
import { allmanSendArgv, IMessageDispatcher, LinkedInDispatcher, WhatsAppDispatcher } from "../src/send/dispatch.ts";
import { type ElicitFn, SendService } from "../src/send/service.ts";
import { appendChatDb, appendWhatsApp, NOW } from "./fixtures/build.ts";
import { buildWorld, type World } from "./fixtures/world.ts";

const ROOT = join(import.meta.dir, "..");
const FAKE_ALLMAN = join(ROOT, "scripts/fake-allman.sh");

interface Env {
  w: World;
  index: Database;
  outbox: Outbox;
  svc: SendService;
  notified: Operation[];
  allmanLog: string;
  osaLog: string;
  openLog: string;
  clip: string;
  auditPath: string;
  make: (over?: Partial<Config>, extra?: { liTimeoutMs?: number }) => SendService;
}

const approve: ElicitFn = async () => "approve";
const decline: ElicitFn = async () => "decline";

function setup(over: Partial<Config> = {}): Env {
  const w = buildWorld();
  const index = openIndex(join(w.root, "i.db"));
  const o = { backfillDays: 365, now: NOW };
  const ingest = (c: Channel | "contacts") => {
    if (c === "imessage") ingestIMessage(index, w.chatDb, o);
    if (c === "whatsapp") ingestWhatsApp(index, w.whatsappDir, { ...o, groupMax: 8 });
    if (c === "linkedin") ingestLinkedIn(index, w.allmanAccount, o);
    if (c === "contacts") ingestContacts(index, w.addressBookDir);
  };
  for (const c of ["imessage", "whatsapp", "linkedin", "contacts"] as const) ingest(c);
  const outbox = new Outbox(openOutbox(join(w.root, "outbox.db")));
  const env = {
    allmanLog: join(w.root, "allman.log"),
    osaLog: join(w.root, "osa.log"),
    openLog: join(w.root, "open.log"),
    clip: join(w.root, "clip.txt"),
    auditPath: join(w.root, "audit.jsonl"),
  };
  Object.assign(process.env, {
    FAKE_ALLMAN_LOG: env.allmanLog,
    FAKE_ALLMAN_SEND: "ok",
    FAKE_CHAT_DB: w.chatDb,
    FAKE_OSA: "ok",
    FAKE_OSA_LOG: env.osaLog,
    FAKE_OPEN_LOG: env.openLog,
    FAKE_PBCOPY_OUT: env.clip,
  });
  const audit = new AuditLog(env.auditPath);
  const notified: Operation[] = [];
  const make = (o2: Partial<Config> = {}, extra: { liTimeoutMs?: number } = {}) => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      clients: {
        "claude-code": { send_policy: "confirm" },
        "read-only": { send_policy: "draft-only" },
        robot: { send_policy: "autonomous" },
      },
      linkedin: { ...DEFAULT_CONFIG.linkedin, min_interval_seconds: 0, max_sends_per_minute: 100 },
      ...over,
      ...o2,
    };
    const whatsapp = new WhatsAppDispatcher(
      { open: join(ROOT, "scripts/fake-open.sh"), pbcopy: join(ROOT, "scripts/fake-pbcopy.sh") },
      w.whatsappDir,
    );
    return new SendService({
      index,
      outbox,
      config,
      audit,
      dispatchers: {
        linkedin: new LinkedInDispatcher(
          () => ({ bin: FAKE_ALLMAN, store: w.allmanStore, account: null }),
          extra.liTimeoutMs ?? 10_000,
        ),
        imessage: new IMessageDispatcher(w.chatDb, join(ROOT, "scripts/fake-osascript.ts"), {
          confirmWindowMs: 1500,
          pollMs: 50,
        }),
        whatsapp,
      },
      whatsapp,
      refresh: (c) => ingest(c),
      notify: (op) => notified.push(op),
      approvalUrl: (op) => (op.approval_token ? `http://127.0.0.1:1/op/${op.id}?t=${op.approval_token}` : null),
      watchPollMs: 50,
      watchWindowMs: 1500,
      maxCapWaitMs: 2000,
    });
  };
  return { w, index, outbox, svc: make(), notified, make, ...env };
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const sendLines = (e: Env) =>
  read(e.allmanLog)
    .split("\n")
    .filter((l) => l.startsWith("send ") && !l.startsWith("send --dry-run"));
const osaSends = (e: Env) =>
  read(e.osaLog)
    .split("\n")
    .filter((l) => l.startsWith("[") && !l.includes("Approve"));
const opCount = (e: Env) => (e.outbox.db.query("select count(*) as n from operations").get() as { n: number }).n;
const tokenOf = (e: Env, id: string) => e.outbox.get(id)?.approval_token as string;

let e: Env;
beforeEach(() => {
  e = setup();
});

describe("(i) direct send_message, no draft needed", () => {
  test("LinkedIn reply: confirm via the approval token dispatches one allman send, argv only", async () => {
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "--Happy to, Thursday?", idempotency_key: "k-li-1-long" },
    );
    expect(r.status).toBe("awaiting_approval");
    expect(e.notified).toHaveLength(1);
    expect(sendLines(e)).toHaveLength(0);
    const id = (r as { operation_id: string }).operation_id;
    const op = await e.svc.approve(id, tokenOf(e, id) ?? (e.notified[0]?.approval_token as string), "approval_page");
    expect(op.status).toBe("sent");
    expect(op.native_id).toStartWith("urn:li:msg:fake-");
    expect(sendLines(e)).toEqual([`send --json --store ${e.w.allmanStore} -- 2-ada --Happy to, Thursday?`]);
  });

  test("iMessage reply via elicitation: handed to Messages, then confirmed from chat.db", async () => {
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "im:iMessage;-;+15550100" },
      { body: "See you Thursday", idempotency_key: "k-im-1-long" },
      approve,
    );
    expect(r.status).toBe("sent");
    expect((r as { approved_via: string }).approved_via).toBe("elicitation");
    expect((r as { native_message_id: string }).native_message_id).toStartWith("fake-sent-");
    expect(osaSends(e)).toEqual([JSON.stringify(["See you Thursday", "+15550100", "iMessage"])]);
  });

  test("new 1:1 conversations: LinkedIn slug, iMessage contact; never a new group", async () => {
    const li = await e.svc.send(
      "claude-code",
      { channel: "linkedin", to: "https://www.linkedin.com/in/new-person/" },
      {
        body: "Hello",
        dry_run: true,
      },
    );
    expect(li).toMatchObject({ status: "dry_run", preview: { new_conversation: true, handles: ["new-person"] } });
    const known = await e.svc.send(
      "claude-code",
      { channel: "linkedin", to: "ada-example" },
      { body: "Hi", dry_run: true },
    );
    expect(known).toMatchObject({ preview: { thread_id: "li:2-ada" } });
    const im = await e.svc.send(
      "claude-code",
      { channel: "imessage", to: "+1 (555) 0109" },
      { body: "Hi Ada", idempotency_key: "k-new-im" },
      approve,
    );
    expect(im.status).toBe("sent");
    await expect(
      e.svc.send(
        "claude-code",
        { channel: "linkedin", to: "ada-example,cy-placeholder" },
        { body: "hi both", dry_run: true },
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("new LinkedIn 1:1 that already exists on LinkedIn: refused before approval, nothing sent", async () => {
    const k = (n: string) => ({ body: "Hello", idempotency_key: `k-li-probe-${n}` });
    process.env.FAKE_ALLMAN_PROBE = "existing:2-unsynced";
    await expect(
      e.svc.send("claude-code", { channel: "linkedin", to: "new-person" }, k("1"), approve),
    ).rejects.toMatchObject({ code: "not_synced" });
    // the conversation is in the index under a different slug: point at the thread instead
    process.env.FAKE_ALLMAN_PROBE = "existing:2-ada";
    await expect(
      e.svc.send("claude-code", { channel: "linkedin", to: "ada-renamed" }, k("2"), approve),
    ).rejects.toMatchObject({ code: "existing_thread" });
    expect(opCount(e)).toBe(0);
    // allman can't answer: fall through to the normal path (its pre-send check still guards)
    process.env.FAKE_ALLMAN_PROBE = "fail";
    const r = await e.svc.send("claude-code", { channel: "linkedin", to: "new-person" }, k("3"), approve);
    expect(r.status).toBe("sent");
    process.env.FAKE_ALLMAN_PROBE = "new";
    const r2 = await e.svc.send("claude-code", { channel: "linkedin", to: "other-person" }, k("4"), approve);
    expect(r2.status).toBe("sent");
    expect(sendLines(e)).toHaveLength(2);
    expect(read(e.allmanLog)).toContain("send --dry-run --json --store");
    delete process.env.FAKE_ALLMAN_PROBE;
  });

  test("iMessage only to Contacts; groups stay off until the spike", async () => {
    await expect(
      e.svc.send("claude-code", { thread_id: "im:iMessage;-;+15550150" }, { body: "hi", dry_run: true }),
    ).rejects.toMatchObject({ code: "recipient_not_in_contacts" });
    await expect(
      e.svc.send("claude-code", { thread_id: "im:iMessage;+;chat-group-1" }, { body: "hi", dry_run: true }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("(ii) policy and exact, single-use approval", () => {
  test("draft-only never dispatches or stores an operation", async () => {
    const r = await e.svc.send(
      "read-only",
      { thread_id: "li:2-ada" },
      { body: "x", idempotency_key: "k-ro-0001" },
      approve,
    );
    expect(r.status).toBe("draft_only");
    expect(opCount(e)).toBe(0);
    expect(sendLines(e)).toHaveLength(0);
  });

  test("unknown clients fail closed", async () => {
    await expect(e.svc.send("stranger", { thread_id: "li:2-ada" }, { body: "x", dry_run: true })).rejects.toMatchObject(
      {
        code: "unknown_client",
      },
    );
  });

  test("an approval works once; a wrong token never; a decline cancels", async () => {
    const r = (await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "one", idempotency_key: "k-once-1" },
    )) as {
      operation_id: string;
    };
    const token = tokenOf(e, r.operation_id);
    await expect(e.svc.approve(r.operation_id, "x".repeat(token.length), "page")).rejects.toMatchObject({
      code: "bad_approval",
    });
    expect((await e.svc.approve(r.operation_id, token, "page")).status).toBe("sent");
    await expect(e.svc.approve(r.operation_id, token, "page")).rejects.toMatchObject({ code: "bad_approval" });
    const d = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-cy" },
      { body: "no", idempotency_key: "k-dec-01" },
      decline,
    );
    expect(d.status).toBe("cancelled");
    expect(sendLines(e)).toHaveLength(1);
  });

  test("approval expires", async () => {
    const svc = e.make({ approval_ttl_minutes: 0.0005 }); // 30ms
    const r = (await svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "late", idempotency_key: "k-exp-01" },
    )) as {
      operation_id: string;
    };
    const token = tokenOf(e, r.operation_id);
    await Bun.sleep(60);
    await expect(svc.approve(r.operation_id, token, "page")).rejects.toMatchObject({ code: "not_awaiting" });
    expect(svc.getStatus(r.operation_id).status).toBe("expired");
    expect(sendLines(e)).toHaveLength(0);
  });
});

describe("(iii) autonomous", () => {
  test("rejected in the default (strict) profile", async () => {
    await expect(
      e.svc.send("robot", { thread_id: "li:2-ada" }, { body: "x", idempotency_key: "k-auto-1" }),
    ).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  test("allow-autonomous profile: dispatches only inside its scope", async () => {
    const svc = e.make({
      profile: "allow-autonomous",
      autonomous: {
        thread_ids: ["li:2-ada"],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        max_per_day: 5,
        config_ref: "test-scope",
      },
    });
    const inScope = await svc.send("robot", { thread_id: "li:2-ada" }, { body: "auto", idempotency_key: "k-auto-2" });
    expect(inScope).toMatchObject({ status: "sent", approved_via: "autonomous" });
    const outOfScope = await svc.send("robot", { thread_id: "li:2-cy" }, { body: "auto", idempotency_key: "k-auto-3" });
    expect(outOfScope.status).toBe("awaiting_approval");
  });
});

describe("(iv) edits and new inbound expire approval", () => {
  test("new inbound after the request → stale, nothing sent", async () => {
    const r = (await e.svc.send(
      "claude-code",
      { thread_id: "im:iMessage;-;+15550100" },
      { body: "Thursday works", idempotency_key: "k-stale-1" },
    )) as { operation_id: string };
    appendChatDb(e.w.chatDb, [
      { chat: "iMessage;-;+15550100", from: "+15550100", text: "Actually, Friday?", at: Date.now() },
    ]);
    const op = await e.svc.approve(r.operation_id, tokenOf(e, r.operation_id), "page");
    expect(op.status).toBe("stale");
    expect(osaSends(e)).toHaveLength(0);
  });

  test("expected_last_inbound_id mismatch → stale before anything is reserved", async () => {
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "x", idempotency_key: "k-stale-2", expected_last_inbound_id: "li:old" },
    );
    expect(r).toMatchObject({ status: "stale", current_last_inbound_id: "li:urn:li:msg:2" });
    expect(opCount(e)).toBe(0);
  });

  test("allman's own pre-send check → stale", async () => {
    process.env.FAKE_ALLMAN_SEND = "stale";
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "x", idempotency_key: "k-stale-3" },
      approve,
    );
    expect(r.status).toBe("stale");
  });

  test("editing a draft cancels the approval waiting for its old text", async () => {
    const d = e.svc.draft("claude-code", { thread_id: "li:2-ada" }, "first text");
    const r = (await e.svc.sendDraft("claude-code", d.draft_id, { idempotency_key: "k-draft-1" })) as {
      operation_id: string;
    };
    const token = tokenOf(e, r.operation_id);
    expect(e.svc.listDrafts("in_flight")).toHaveLength(1);
    e.svc.updateDraft(d.draft_id, "second text");
    await expect(e.svc.approve(r.operation_id, token, "page")).rejects.toMatchObject({ code: "bad_approval" });
    expect(e.svc.getStatus(r.operation_id).status).toBe("cancelled");
    const again = await e.svc.sendDraft("claude-code", d.draft_id, { idempotency_key: "k-draft-2" }, approve);
    expect(again.status).toBe("sent");
    expect(e.svc.listDrafts("sent")[0]?.draft_id).toBe(d.draft_id);
    expect(sendLines(e)).toEqual([`send --json --store ${e.w.allmanStore} -- 2-ada second text`]);
  });
});

describe("(v) duplicates, concurrency, restarts", () => {
  test("same key + same payload → same operation; different payload → conflict", async () => {
    const a = (await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "hi", idempotency_key: "k-dup-001" },
      approve,
    )) as {
      operation_id: string;
    };
    const b = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "hi", idempotency_key: "k-dup-001" },
      approve,
    );
    expect(b).toMatchObject({ operation_id: a.operation_id, replayed: true, status: "sent" });
    await expect(
      e.svc.send("claude-code", { thread_id: "li:2-ada" }, { body: "different", idempotency_key: "k-dup-001" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(sendLines(e)).toHaveLength(1);
  });

  test("concurrent identical calls reserve one operation and dispatch once", async () => {
    const calls = Array.from({ length: 5 }, () =>
      e.svc.send("claude-code", { thread_id: "li:2-ada" }, { body: "race", idempotency_key: "k-race-01" }, approve),
    );
    const out = (await Promise.all(calls)) as Array<{ operation_id: string }>;
    expect(new Set(out.map((o) => o.operation_id)).size).toBe(1);
    expect(opCount(e)).toBe(1);
    expect(sendLines(e)).toHaveLength(1);
  });

  test("restart: approved-not-dispatched is cancelled; mid-dispatch is reconciled or unconfirmed; nothing resent", async () => {
    const mk = async (key: string, body: string) => {
      const r = (await e.svc.send("claude-code", { thread_id: "li:2-ada" }, { body, idempotency_key: key })) as {
        operation_id: string;
      };
      return r.operation_id;
    };
    const approvedId = await mk("k-rst-001", "approved only");
    e.outbox.transition(approvedId, "awaiting_approval", "approved", { approved_via: "page", approval_token: null });
    const lostId = await mk("k-rst-002", "lost in flight");
    e.outbox.transition(lostId, "awaiting_approval", "dispatching", {
      dispatched_at: Date.now(),
      approval_token: null,
    });
    const landedId = await mk("k-rst-003", "landed before crash");
    e.outbox.transition(landedId, "awaiting_approval", "dispatching", {
      dispatched_at: Date.now(),
      approval_token: null,
    });
    // allman wrote the sent message to its store before the crash
    const { writeConversation } = await import("./fixtures/build.ts");
    writeConversation(e.w.allmanAccount, {
      convId: "2-ada",
      profileId: "ACoADA",
      slug: "ada-example",
      name: "Ada Example",
      messages: [
        { urn: "urn:li:msg:1", at: NOW - 3 * 86400_000, me: true, body: "Great meeting you at the demo day" },
        { urn: "urn:li:msg:2", at: NOW - 2 * 86400_000, body: "Likewise! Could we talk about the seed round?" },
        { urn: "urn:li:msg:landed", at: Date.now(), me: true, body: "landed before crash" },
      ],
    });
    const restarted = e.make();
    expect(restarted.recover()).toEqual({ cancelled: 1, reconciled: 1, unconfirmed: 1 });
    expect(restarted.getStatus(approvedId).status).toBe("cancelled");
    expect(restarted.getStatus(lostId).status).toBe("unconfirmed");
    expect(restarted.getStatus(landedId)).toMatchObject({ status: "sent", native_message_id: "urn:li:msg:landed" });
    expect(sendLines(e)).toHaveLength(0);
  });
});

describe("(vi) dry_run", () => {
  test("no dispatch, no handoff, no reservation, no approval prompt", async () => {
    for (const thread_id of ["li:2-ada", "im:iMessage;-;+15550100", "wa:15550101@s.whatsapp.net"]) {
      const r = await e.svc.send(
        "claude-code",
        { thread_id },
        { body: "preview me", dry_run: true, idempotency_key: "k-dry-001" },
        approve,
      );
      expect(r).toMatchObject({ status: "dry_run", preview: { body: "preview me" } });
    }
    expect(opCount(e)).toBe(0);
    expect(e.notified).toHaveLength(0);
    expect(sendLines(e).length + osaSends(e).length + read(e.openLog).length).toBe(0);
    // the key wasn't consumed
    expect(
      (
        await e.svc.send(
          "claude-code",
          { thread_id: "li:2-ada" },
          { body: "real", idempotency_key: "k-dry-001" },
          approve,
        )
      ).status,
    ).toBe("sent");
  });
});

describe("(vii) caps and account restrictions stop safely", () => {
  test("LinkedIn daily cap → rate_limited, not sent", async () => {
    const svc = e.make({ linkedin: { ...DEFAULT_CONFIG.linkedin, max_sends_per_day: 1, min_interval_seconds: 0 } });
    expect(
      (await svc.send("claude-code", { thread_id: "li:2-ada" }, { body: "a", idempotency_key: "k-cap-001" }, approve))
        .status,
    ).toBe("sent");
    const r = await svc.send(
      "claude-code",
      { thread_id: "li:2-cy" },
      { body: "b", idempotency_key: "k-cap-002" },
      approve,
    );
    expect(r).toMatchObject({ status: "rate_limited" });
    expect(sendLines(e)).toHaveLength(1);
  });

  test("minimum spacing waits instead of bursting", async () => {
    const svc = e.make({ linkedin: { ...DEFAULT_CONFIG.linkedin, min_interval_seconds: 1 } });
    await svc.send("claude-code", { thread_id: "li:2-ada" }, { body: "a", idempotency_key: "k-gap-001" }, approve);
    const t0 = Date.now();
    await svc.send("claude-code", { thread_id: "li:2-cy" }, { body: "b", idempotency_key: "k-gap-002" }, approve);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
  });

  test("an auth/restriction signal stops LinkedIn sending", async () => {
    process.env.FAKE_ALLMAN_SEND = "auth";
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "a", idempotency_key: "k-auth-01" },
      approve,
    );
    expect(r.status).toBe("failed");
    process.env.FAKE_ALLMAN_SEND = "ok";
    await expect(
      e.svc.send("claude-code", { thread_id: "li:2-cy" }, { body: "b", idempotency_key: "k-auth-02" }, approve),
    ).rejects.toMatchObject({ code: "channel_stopped" });
    expect(sendLines(e)).toHaveLength(1);
  });

  test("iMessage: Automation denied or a send error → failed", async () => {
    process.env.FAKE_OSA = "deny";
    const a = await e.svc.send(
      "claude-code",
      { thread_id: "im:iMessage;-;+15550100" },
      { body: "a", idempotency_key: "k-osa-001" },
      approve,
    );
    expect(a).toMatchObject({ status: "failed" });
    expect((a as { detail: string }).detail).toContain("Automation");
    process.env.FAKE_OSA = "error";
    const b = await e.svc.send(
      "claude-code",
      { thread_id: "im:iMessage;-;+15550100" },
      { body: "b", idempotency_key: "k-osa-002" },
      approve,
    );
    expect(b.status).toBe("failed");
  });
});

describe("(viii) WhatsApp is a handoff, never an automated send", () => {
  test("1:1 prefill: awaiting_user_send until the human's send appears", async () => {
    const r = (await e.svc.send(
      "claude-code",
      { thread_id: "wa:15550101@s.whatsapp.net" },
      { body: "Sure, 4pm & coffee?", idempotency_key: "k-wa-0001" },
      approve,
    )) as { operation_id: string; status: string };
    expect(r.status).toBe("awaiting_user_send");
    expect(read(e.openLog).trim()).toBe("whatsapp://send?phone=15550101&text=Sure%2C%204pm%20%26%20coffee%3F");
    expect(e.svc.getStatus(r.operation_id).status).toBe("awaiting_user_send");
    appendWhatsApp(e.w.whatsappDir, [{ session: 1, me: true, text: "Sure, 4pm & coffee?", at: Date.now() }]);
    await Bun.sleep(300);
    expect(e.svc.getStatus(r.operation_id).status).toBe("sent");
  });

  test("no send within the window → opened_not_sent", async () => {
    const r = (await e.svc.send(
      "claude-code",
      { thread_id: "wa:15550101@s.whatsapp.net" },
      { body: "x", idempotency_key: "k-wa-0002" },
      approve,
    )) as {
      operation_id: string;
    };
    await Bun.sleep(1800);
    expect(e.svc.getStatus(r.operation_id).status).toBe("opened_not_sent");
  });

  test("group: Copy & Open, labelled as a handoff", async () => {
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "wa:120363000000000002@g.us" },
      { body: "I'll bring dessert", idempotency_key: "k-wa-0003" },
      approve,
    );
    expect(r.status).toBe("awaiting_user_send");
    expect((r as { detail: string }).detail).toStartWith("copy_and_open");
    expect(read(e.clip)).toBe("I'll bring dessert");
    expect(read(e.openLog).trim()).toBe("-a WhatsApp");
  });
});

describe("(ix) timeouts reconcile to unconfirmed, never retried", () => {
  test("allman hangs → unconfirmed", async () => {
    process.env.FAKE_ALLMAN_SEND = "hang";
    const svc = e.make({}, { liTimeoutMs: 300 });
    const r = await svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "x", idempotency_key: "k-hang-01" },
      approve,
    );
    expect(r.status).toBe("unconfirmed");
    expect(sendLines(e)).toHaveLength(1);
  });

  test("Messages accepts but no row appears → unconfirmed", async () => {
    process.env.FAKE_OSA = "silent";
    const r = await e.svc.send(
      "claude-code",
      { thread_id: "im:iMessage;-;+15550100" },
      { body: "x", idempotency_key: "k-sil-001" },
      approve,
    );
    expect(r.status).toBe("unconfirmed");
  });
});

describe("privacy", () => {
  test("audit log records hashes and sizes, never message text", async () => {
    await e.svc.send(
      "claude-code",
      { thread_id: "li:2-ada" },
      { body: "secret zebra plan", idempotency_key: "k-aud-001" },
      approve,
    );
    const log = read(e.auditPath);
    expect(log).toContain('"event":"send_result"');
    expect(log).not.toContain("zebra");
    expect(log).not.toContain("k-aud-001");
  });

  test("bodies of finished operations are purged after the retention window", async () => {
    await e.svc.send("claude-code", { thread_id: "li:2-ada" }, { body: "old", idempotency_key: "k-old-001" }, approve);
    e.outbox.db.query("update operations set updated_at = ?").run(Date.now() - 31 * 86400_000);
    e.svc.housekeeping();
    expect((e.outbox.db.query("select body from operations").get() as { body: string | null }).body).toBeNull();
  });

  test("allman send argv puts text after --, so it can't become an option", () => {
    expect(allmanSendArgv({ bin: "a", store: "/s", account: "me" }, "2-x", "--help")).toEqual([
      "a",
      "send",
      "--json",
      "--store",
      "/s",
      "--account",
      "me",
      "--",
      "2-x",
      "--help",
    ]);
  });
});
