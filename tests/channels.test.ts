/**
 * Per-channel modes set in Switchboard.app: off (not read; its copy deleted from the index), read (no sending),
 * read_write. A fresh install starts with every channel off; an older config with no `channels` keeps working.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, DEFAULT_CONFIG, FRESH_INSTALL_CONFIG, loadConfig, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import { buildWorld, type World } from "./fixtures/world.ts";

const ROOT = join(import.meta.dir, "..");
let running: Daemon[] = [];

function daemon(w: World, channels: Config["channels"]): Daemon {
  process.env.FAKE_ALLMAN_LOG = join(w.root, "allman.log");
  const env = { ...w.env, SWITCHBOARD_ALLMAN: join(ROOT, "scripts/fake-allman.sh") };
  const d = new Daemon(paths(env), { ...DEFAULT_CONFIG, channels }, () => {}, { notify: () => {} });
  running.push(d);
  return d;
}
const count = (d: Daemon, channel: string) =>
  (d.index.query("select count(*) as n from messages where channel = ?").get(channel) as { n: number }).n;

afterEach(() => {
  for (const d of running) d.stop();
  running = [];
});

describe("channel modes", () => {
  test("switching a channel off deletes its copy and stops reading it", () => {
    const w = buildWorld();
    const all = daemon(w, { linkedin: "read_write", imessage: "read_write", whatsapp: "read_write" });
    all.start();
    expect(count(all, "imessage")).toBeGreaterThan(0);
    all.stop();
    running = [];

    const some = daemon(w, { linkedin: "read_write", imessage: "off", whatsapp: "read" });
    some.start();
    expect(count(some, "imessage")).toBe(0);
    expect(count(some, "whatsapp")).toBeGreaterThan(0);
    expect(some.index.query("select count(*) as n from threads where channel = 'imessage'").get()).toEqual({ n: 0 });
    expect(some.index.query("select count(*) as n from checkpoints where source like 'imessage.%'").get()).toEqual({
      n: 0,
    });
    const st = Object.fromEntries(some.status().map((c) => [c.channel, c]));
    expect(st.imessage?.mode).toBe("off");
    expect(st.whatsapp?.mode).toBe("read");
    expect(st.linkedin?.mode).toBe("read_write");
  });

  test("a read-only channel refuses to send", async () => {
    const w = buildWorld();
    const d = daemon(w, { linkedin: "read", imessage: "read_write", whatsapp: "read_write" });
    d.start();
    await expect(
      d.send.send("claude-code", { thread_id: "li:2-ada" }, { body: "hi", idempotency_key: "ro-test-1" }),
    ).rejects.toMatchObject({ code: "channel_read_only" });
  });

  test("LinkedIn off: no allman listener is started", () => {
    const w = buildWorld();
    const d = daemon(w, { linkedin: "off", imessage: "read", whatsapp: "read" });
    d.start();
    const log = existsSync(join(w.root, "allman.log")) ? readFileSync(join(w.root, "allman.log"), "utf8") : "";
    expect(log).not.toContain("listen");
    expect(count(d, "linkedin")).toBe(0);
  });

  test("everything off: nothing is read, contacts included", () => {
    const w = buildWorld();
    const d = daemon(w, { linkedin: "off", imessage: "off", whatsapp: "off" });
    d.start();
    expect(d.index.query("select count(*) as n from messages").get()).toEqual({ n: 0 });
    expect(d.index.query("select count(*) as n from people").get()).toEqual({ n: 0 });
  });
});

describe("config defaults", () => {
  test("a fresh install starts with every channel off", () => {
    expect(FRESH_INSTALL_CONFIG.channels).toEqual({ linkedin: "off", imessage: "off", whatsapp: "off" });
  });

  test("an older config without channels keeps every channel readable and sendable", async () => {
    const w = buildWorld();
    const p = paths(w.env);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(p.appSupport, { recursive: true });
    writeFileSync(p.configFile, JSON.stringify({ profile: "strict", clients: DEFAULT_CONFIG.clients }));
    const c = await loadConfig(p);
    expect(c.channels).toEqual({ linkedin: "read_write", imessage: "read_write", whatsapp: "read_write" });
  });
});
