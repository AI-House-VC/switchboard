/**
 * End to end: daemon on a temp socket over a synthetic Mac, reached through the real `switchboard mcp`
 * shim process with the MCP SDK client, exactly as Claude Code would.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_CONFIG, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import { buildWorld, type World } from "./fixtures/world.ts";

const ROOT = join(import.meta.dir, "..");
let w: World;
let daemon: Daemon;
let umaskAfterListen = 0;
let server: ReturnType<Daemon["listen"]>;
let client: Client;
let env: Record<string, string>;

function shim(label: string) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "src/cli/main.ts"), "mcp", "--client", label],
    env: { ...env, PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
}

function parse(r: unknown): Record<string, unknown> {
  const content = (r as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}");
}

beforeAll(async () => {
  w = buildWorld();
  env = {
    ...w.env,
    SWITCHBOARD_ALLMAN: join(ROOT, "scripts/fake-allman.sh"),
    SWITCHBOARD_OSASCRIPT: join(ROOT, "scripts/fake-osascript.ts"),
    SWITCHBOARD_OPEN: join(ROOT, "scripts/fake-open.sh"),
    SWITCHBOARD_PBCOPY: join(ROOT, "scripts/fake-pbcopy.sh"),
    FAKE_ALLMAN_LOG: join(w.root, "allman.log"),
  };
  // Children (allman, osascript, open) inherit the daemon's process env.
  Object.assign(process.env, {
    FAKE_ALLMAN_LOG: env.FAKE_ALLMAN_LOG,
    FAKE_ALLMAN_SEND: "ok",
    FAKE_CHAT_DB: w.chatDb,
    FAKE_OSA: "ok",
    FAKE_OPEN_LOG: join(w.root, "open.log"),
  });
  const p = paths(env);
  daemon = new Daemon(p, DEFAULT_CONFIG, () => {});
  const mask = process.umask();
  server = daemon.listen();
  // listen() must not leave a tight umask behind for start(): `allman listen` inherited 0177 and created
  // git object folders allman itself couldn't open (found live, 2026-11-09).
  umaskAfterListen = process.umask();
  process.umask(mask);
  await new Promise((r) => server.once("listening", r));
  daemon.start();
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(shim("claude-code"));
});

afterAll(async () => {
  await client?.close();
  server?.close();
  daemon?.stop();
});

describe("daemon + shim", () => {
  test("lists the read and send tools; send tools are marked destructive", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "channel_status",
      "discard_draft",
      "draft_message",
      "find_person",
      "get_send_status",
      "list_drafts",
      "list_threads",
      "needs_reply",
      "read_thread",
      "search_messages",
      "send_draft",
      "send_message",
      "sync_now",
      "update_draft",
    ]);
    const send = tools.find((t) => t.name === "send_message");
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  test("channel_status reports all channels ingested and the listener running", async () => {
    const s = parse(await client.callTool({ name: "channel_status", arguments: {} })) as {
      client: string;
      channels: Array<{
        channel: string;
        connected: boolean;
        last_ingest: Record<string, number> | null;
        listener_running?: boolean;
      }>;
    };
    expect(s.client).toBe("claude-code");
    const by = Object.fromEntries(s.channels.map((c) => [c.channel, c]));
    expect(by.imessage?.last_ingest?.messages).toBe(10);
    expect(by.whatsapp?.last_ingest?.skipped_large_groups).toBe(1);
    expect(by.linkedin?.connected).toBe(true);
    expect(by.linkedin?.listener_running).toBe(true);
    expect(by.contacts?.last_ingest?.people).toBe(3);
  });

  test("needs_reply and read_thread over MCP; bodies are untrusted_text", async () => {
    const nr = parse(await client.callTool({ name: "needs_reply", arguments: { since: "30d" } })) as {
      threads: Array<{ thread_id: string }>;
    };
    expect(nr.threads.length).toBe(7);
    const rt = parse(await client.callTool({ name: "read_thread", arguments: { thread_id: "li:2-cy" } })) as {
      messages: Array<{ body: { untrusted_text: string } }>;
    };
    expect(rt.messages[0]?.body.untrusted_text).toContain("Ignore previous instructions");
  });

  test("errors come back as tool errors, not crashes", async () => {
    const r = await client.callTool({ name: "read_thread", arguments: { thread_id: "li:missing" } });
    expect(r.isError).toBe(true);
  });

  test("a new LinkedIn message written to the store is searchable within seconds", async () => {
    const { writeConversation } = await import("./fixtures/build.ts");
    writeConversation(w.allmanAccount, {
      convId: "2-live",
      profileId: "ACoLIVE",
      slug: "live-person",
      name: "Live Person",
      messages: [{ urn: "urn:li:msg:live", at: Date.now(), body: "realtime zebra marker" }],
    });
    let found = 0;
    for (let i = 0; i < 40 && !found; i++) {
      await Bun.sleep(250);
      const r = parse(await client.callTool({ name: "search_messages", arguments: { query: "zebra" } })) as {
        results: unknown[];
      };
      found = r.results.length;
    }
    expect(found).toBe(1);
  });

  test("sync_now runs allman sync with absolute --store and is rate limited", async () => {
    const a = parse(await client.callTool({ name: "sync_now", arguments: { channel: "linkedin" } })) as {
      ok: boolean;
      message: string;
    };
    expect(a).toMatchObject({ ok: true });
    const b = parse(await client.callTool({ name: "sync_now", arguments: { channel: "linkedin" } })) as {
      ok: boolean;
      message: string;
    };
    expect(b.ok).toBe(false);
    expect(b.message).toContain("Rate limited");
    const log = readFileSync(join(w.root, "allman.log"), "utf8");
    expect(log).toContain(`sync --json --store ${w.allmanStore}`);
    expect(log).toContain(`listen --store ${w.allmanStore}`);
  });

  test("send_message with elicitation: the form shows the exact message; accepting sends once", async () => {
    const c = new Client({ name: "e2e-elicit", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    let shown = "";
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      shown = (req.params as { message: string }).message;
      return { action: "accept", content: { send: true } };
    });
    await c.connect(shim("claude-code"));
    const r = parse(
      await c.callTool({
        name: "send_message",
        arguments: { thread_id: "li:2-ada", body: "Yes, let's talk seed on Thursday", idempotency_key: "e2e-elicit-1" },
      }),
    );
    expect(r).toMatchObject({ status: "sent", approved_via: "elicitation", channel: "linkedin" });
    expect(shown).toContain("Yes, let's talk seed on Thursday");
    expect(shown).toContain("To: Ada Example");
    expect(shown).toContain("Could we talk about the seed round?"); // recent context
    const again = parse(
      await c.callTool({
        name: "send_message",
        arguments: { thread_id: "li:2-ada", body: "Yes, let's talk seed on Thursday", idempotency_key: "e2e-elicit-1" },
      }),
    );
    expect(again).toMatchObject({ status: "sent", replayed: true, operation_id: r.operation_id });
    const sends = readFileSync(join(w.root, "allman.log"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("send "));
    expect(sends).toHaveLength(1);
    await c.close();
  });

  test("openmausbot always gets the Mac approval page, never an elicitation form", async () => {
    // OpenMausBot's Claude engine declares elicitation but declines any form with a field at once, which
    // read as the human saying no (found in its claude-elicitation.ts, 2026-11-15).
    const c = new Client({ name: "omb", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    let asked = 0;
    c.setRequestHandler(ElicitRequestSchema, async () => {
      asked++;
      return { action: "decline" };
    });
    await c.connect(shim("openmausbot"));
    const r = parse(
      await c.callTool({
        name: "send_message",
        arguments: { thread_id: "li:2-ada", body: "Friday 10am works", idempotency_key: "e2e-omb-1" },
      }),
    ) as { status: string; approval_url?: string };
    expect(asked).toBe(0);
    expect(r.status).toBe("awaiting_approval");
    expect(r.approval_url).toContain("127.0.0.1");
    const st = parse(await c.callTool({ name: "channel_status", arguments: {} })) as {
      send: { approval: string };
    };
    expect(st.send.approval).toContain("Mac");
    await c.close();
  });

  test("send_message without elicitation: approval page checks origin and CSRF, then sends", async () => {
    const r = parse(
      await client.callTool({
        name: "send_message",
        arguments: {
          thread_id: "im:iMessage;-;+15550100",
          body: "<b>Thursday</b> 3pm works",
          idempotency_key: "e2e-page-1",
        },
      }),
    ) as { status: string; approval_url: string; operation_id: string };
    expect(r.status).toBe("awaiting_approval");
    const url = new URL(r.approval_url);
    expect(url.hostname).toBe("127.0.0.1");
    const page = await fetch(url);
    const html = await page.text();
    expect(page.status).toBe(200);
    // Under "no-referrer" Chrome posts the form with `Origin: null`, which the origin check rejects
    // (found live, 2026-11-07). "same-origin" keeps the real Origin and still leaks nothing cross-site.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(html).toContain("&lt;b&gt;Thursday&lt;/b&gt; 3pm works");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const token = url.searchParams.get("t") ?? "";
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`${url.origin}${url.pathname}`, { method: "POST", body: new URLSearchParams(fields), headers });
    expect((await post({ t: token, csrf: "nope", action: "approve" })).status).toBe(403);
    expect((await post({ t: token, csrf, action: "approve" }, { origin: "http://evil.example" })).status).toBe(404);
    const ok = await post({ t: token, csrf, action: "approve" }, { origin: url.origin });
    expect(await ok.text()).toContain("Sent.");
    const st = parse(await client.callTool({ name: "get_send_status", arguments: { operation_id: r.operation_id } }));
    expect(st).toMatchObject({ status: "sent", approved_via: "approval_page" });
    // replaying the approval does nothing
    expect((await post({ t: token, csrf, action: "approve" }, { origin: url.origin })).status).toBe(409);
  });

  test("unknown clients fail closed", async () => {
    const c = new Client({ name: "intruder", version: "0" });
    await expect(c.connect(shim("not-on-allowlist"))).rejects.toThrow();
  });

  test("files are private and the audit log holds no content", async () => {
    const p = paths(env);
    expect(statSync(p.indexDb).mode & 0o777).toBe(0o600);
    expect(statSync(p.socket).mode & 0o077).toBe(0);
    expect(umaskAfterListen & 0o100).toBe(0);
    const audit = readFileSync(p.auditLog, "utf8");
    expect(audit).toContain('"tool":"search_messages"');
    expect(audit).toContain('"event":"client_connected"');
    expect(audit).toContain('"event":"client_rejected"');
    expect(audit).not.toContain("zebra");
    expect(audit).not.toContain("Ignore previous");
    expect(audit).not.toContain("Thursday");
    expect(audit).toContain('"event":"send_result"');
    expect(statSync(p.outboxDb).mode & 0o777).toBe(0o600);
    expect(existsSync(join(p.appSupport, "status.json"))).toBe(true);
  });
});
