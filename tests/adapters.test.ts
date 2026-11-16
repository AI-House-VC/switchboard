import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ingestContacts, linkedinSlugFromUrl } from "../src/adapters/contacts/reader.ts";
import { ingestIMessage } from "../src/adapters/imessage/reader.ts";
import { accountDir, ingestLinkedIn } from "../src/adapters/linkedin/store.ts";
import { appleToUnixMs, decodeAttributedBody, normHandle, unixMsToApple } from "../src/adapters/shared.ts";
import { handleForJid, ingestWhatsApp } from "../src/adapters/whatsapp/reader.ts";
import { openIndex } from "../src/index/db.ts";
import { appendChatDb, appendWhatsApp, attributedBody, H, NOW, writeConversation } from "./fixtures/build.ts";
import { buildWorld } from "./fixtures/world.ts";

const opts = { backfillDays: 365, now: NOW };

describe("shared helpers", () => {
  test("normHandle matches the earlier reader's rule", () => {
    expect(normHandle("(206) 555-0123")).toBe("+12065550123");
    expect(normHandle("+44 20 7946 0000")).toBe("+442079460000");
    expect(normHandle("Ada@Example.COM")).toBe("ada@example.com");
    expect(normHandle("")).toBe("");
  });
  test("apple timestamps in seconds and nanoseconds", () => {
    expect(appleToUnixMs(unixMsToApple(NOW, false))).toBe(NOW);
    expect(appleToUnixMs(unixMsToApple(NOW, true))).toBe(NOW);
    expect(appleToUnixMs(0)).toBe(0);
  });
  test("attributedBody decode, short and 0x81-length strings", () => {
    expect(decodeAttributedBody(attributedBody("hello there"))).toBe("hello there");
    const long = "x".repeat(300);
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(null)).toBe("");
    expect(decodeAttributedBody(new Uint8Array([1, 2, 3]))).toBe("");
  });
  test("linkedin slug from URL", () => {
    expect(linkedinSlugFromUrl("https://www.linkedin.com/in/Ada-Example/?x=1")).toBe("ada-example");
    expect(linkedinSlugFromUrl("https://example.com/in/nope")).toBeNull();
  });
});

describe("iMessage", () => {
  test("ingests text and attributedBody, skips tapbacks/system/old, records groups", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    const r = ingestIMessage(db, w.chatDb, opts);
    // 2 Ada (tapback skipped) + 3 group + 2 answered + 2 automated + 1 unknown; old + system skipped
    expect(r.messages).toBe(10);
    const ada = db
      .query("select body from messages where thread_id = 'im:iMessage;-;+15550100' order by ts")
      .all() as Array<{ body: string }>;
    expect(ada.map((m) => m.body)).toEqual(["Are you free Thursday?", "Yes, Thursday at 3 works for the founder sync"]);
    const g = db
      .query("select is_group, participants_json from threads where id = 'im:iMessage;+;chat-group-1'")
      .get() as {
      is_group: number;
      participants_json: string;
    };
    expect(g.is_group).toBe(1);
    expect(JSON.parse(g.participants_json).map((p: { handle: string }) => p.handle)).toEqual([
      "+15550100",
      "+15550102",
      "dee@example.com",
    ]);
    expect(db.query("select count(*) as n from messages where body = 'ancient history'").get()).toEqual({ n: 0 });
  });

  test("checkpoint makes the next ingest incremental", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    ingestIMessage(db, w.chatDb, opts);
    expect(ingestIMessage(db, w.chatDb, opts).messages).toBe(0);
    appendChatDb(w.chatDb, [{ chat: "iMessage;-;+15550100", from: "+15550100", text: "one more", at: NOW - H }]);
    expect(ingestIMessage(db, w.chatDb, opts).messages).toBe(1);
    const t = db.query("select last_inbound_at from threads where id = 'im:iMessage;-;+15550100'").get() as {
      last_inbound_at: number;
    };
    expect(t.last_inbound_at).toBe(NOW - H);
  });
});

describe("WhatsApp", () => {
  test("resolves @lid, labels media, skips system/broadcast, never stores large groups", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    const r = ingestWhatsApp(db, w.whatsappDir, { ...opts, groupMax: 8 });
    expect(r.skippedLargeGroups).toBe(1);
    expect(db.query("select count(*) as n from messages where body like '%community%'").get()).toEqual({ n: 0 });
    expect(db.query("select count(*) as n from threads where id like 'wa:status%'").get()).toEqual({ n: 0 });
    const ben = db
      .query("select body, kind from messages where thread_id = 'wa:15550101@s.whatsapp.net' order by ts")
      .all();
    expect(ben).toEqual([
      { body: "Can we move our call?", kind: "text" },
      { body: "[voice note]", kind: "media" },
    ]);
    const dessert = db
      .query("select from_handle, from_name from messages where body = 'Who is bringing dessert?'")
      .get();
    expect(dessert).toEqual({ from_handle: "+15550105", from_name: "Lid Person" });
  });

  test("a small group that grows past group_max is purged", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    ingestWhatsApp(db, w.whatsappDir, { ...opts, groupMax: 8 });
    expect(db.query("select count(*) as n from threads where title = 'Dinner crew'").get()).toEqual({ n: 1 });
    appendWhatsApp(w.whatsappDir, [{ session: 3, text: "hi", at: NOW - H }]);
    ingestWhatsApp(db, w.whatsappDir, { ...opts, groupMax: 1 });
    expect(db.query("select count(*) as n from messages where thread_id = 'wa:120363000000000002@g.us'").get()).toEqual(
      { n: 0 },
    );
  });

  test("jid handles", () => {
    const lids = new Map([["42", "+1 555 0142"]]);
    expect(handleForJid("15550101@s.whatsapp.net", lids)).toBe("+15550101");
    expect(handleForJid("42@lid", lids)).toBe("+15550142");
    expect(handleForJid("43@lid", lids)).toBeNull();
    expect(handleForJid("123@g.us", lids)).toBeNull();
  });
});

describe("Contacts", () => {
  test("cards become people; phones, emails and LinkedIn URLs link handles", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    const r = ingestContacts(db, w.addressBookDir);
    expect(r.people).toBe(3);
    const ada = db
      .query("select linkedin_slug, phones_json, emails_json from people where display_name = 'Ada Example'")
      .get();
    expect(ada).toEqual({
      linkedin_slug: "ada-example",
      phones_json: '["+15550100"]',
      emails_json: '["ada@example.com"]',
    });
    const other = db.query("select linkedin_slug from people where display_name = 'Ada Other'").get();
    expect(other).toEqual({ linkedin_slug: "ada-other" });
    const linked = db
      .query("select count(*) as n from handles where handle = 'ada-example' and person_id is not null")
      .get();
    expect(linked).toEqual({ n: 1 });
  });
});

describe("LinkedIn store", () => {
  test("reads conversations, skips alias symlinks and non-conversation dirs, maps group senders", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    const dir = accountDir(w.allmanStore, null);
    expect(dir).toBe(w.allmanAccount);
    expect(accountDir(w.allmanStore, "test-owner")).not.toBeNull(); // slug alias
    const r = ingestLinkedIn(db, dir as string, opts);
    expect(r).toEqual({ messages: 4, threads: 3 });
    const grp = db.query("select from_handle, from_name from messages where thread_id = 'li:2-grp'").get();
    expect(grp).toEqual({ from_handle: "cy-placeholder", from_name: "Cy Placeholder" });
    const t = db.query("select title, is_group, unread from threads where id = 'li:2-cy'").get();
    expect(t).toEqual({ title: "Cy Placeholder", is_group: 0, unread: 1 });
  });

  test("incremental: only changed conversations are re-read", () => {
    const w = buildWorld();
    const db = openIndex(join(w.root, "i.db"));
    ingestLinkedIn(db, w.allmanAccount, opts);
    expect(ingestLinkedIn(db, w.allmanAccount, opts).threads).toBe(0);
    writeConversation(w.allmanAccount, {
      convId: "2-new",
      profileId: "ACoNEW",
      slug: null,
      name: "New Person",
      messages: [{ urn: "urn:li:msg:9", at: NOW - H, body: "hello" }],
    });
    expect(ingestLinkedIn(db, w.allmanAccount, opts)).toEqual({ messages: 1, threads: 1 });
  });
});

describe("allman listener detection", () => {
  test("only a listener on the same store (or with no --store) counts", async () => {
    const { otherListenerRunning } = await import("../src/adapters/linkedin/allman.ts");
    const store = `/tmp/sb-listen-${process.pid}`;
    const proc = Bun.spawn([join(import.meta.dir, "../scripts/fake-allman.sh"), "listen", "--store", store], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(200);
    try {
      expect(otherListenerRunning(store)).toBe(true);
      expect(otherListenerRunning(`${store}-other`)).toBe(false);
      // a command that only mentions it (e.g. a grep) doesn't count
      const store2 = `${store}-mention`;
      const grep = Bun.spawn(["/bin/sh", "-c", `sleep 2 # allman listen --store ${store2}`], { stdout: "ignore" });
      await Bun.sleep(200);
      expect(otherListenerRunning(store2)).toBe(false);
      grep.kill();
    } finally {
      proc.kill();
    }
  });

  test("defers to another listener, then takes over once it exits (found live, 2026-11-09)", async () => {
    const { ListenerKeeper } = await import("../src/adapters/linkedin/allman.ts");
    let other = true;
    let made = 0;
    const logs: string[] = [];
    const k = new ListenerKeeper(
      () => other,
      () => {
        made++;
        let up = false;
        return {
          start: () => {
            up = true;
          },
          stop: () => {
            up = false;
          },
          get running() {
            return up;
          },
        };
      },
      (m) => logs.push(m),
    );
    k.check();
    k.check();
    expect(made).toBe(0);
    expect(k.running).toBe(false);
    expect(logs.filter((l) => l.includes("watching the store only"))).toHaveLength(1);
    other = false;
    k.check();
    expect(made).toBe(1);
    expect(k.running).toBe(true);
    other = true; // ours now counts as "another" from ps; it must not stop or duplicate
    k.check();
    expect(made).toBe(1);
    k.stop();
    expect(k.running).toBe(false);
  });
});

test("doctor spots git object folders allman can't open", async () => {
  const { mkdtempSync, mkdirSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { unopenableGitDirs } = await import("../src/cli/doctor.ts");
  const store = mkdtempSync(join(tmpdir(), "sb-gitperm-"));
  for (const d of ["ab", "cd", "pack"]) mkdirSync(join(store, ".git/objects", d), { recursive: true });
  expect(unopenableGitDirs(store)).toEqual([]);
  chmodSync(join(store, ".git/objects/ab"), 0o600);
  expect(unopenableGitDirs(store).map((d) => d.slice(-2))).toEqual(["ab"]);
  chmodSync(join(store, ".git/objects/ab"), 0o755);
  expect(unopenableGitDirs(join(store, "missing"))).toEqual([]);
});
