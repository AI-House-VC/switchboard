/**
 * Loopback Streamable HTTP (M4): for a bot host on another machine, reaching the user's Mac
 * through a private proxy. Token-guarded per client; Host and Origin checked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Config, DEFAULT_CONFIG, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import { buildWorld } from "./fixtures/world.ts";

const ROOT = join(import.meta.dir, "..");
const TOKEN = "sbt_test_openmausbot_0123456789abcdef";
const OTHER = "sbt_test_otherbot_0123456789abcdef";
const OFFLIST = "sbt_test_offlist_0123456789abcdef";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

let daemon: Daemon;
let server: ReturnType<Daemon["listenHttp"]>;
let base: string;
let auditLog: string;

beforeAll(() => {
  const w = buildWorld();
  const env = { ...w.env, SWITCHBOARD_ALLMAN: join(ROOT, "scripts/fake-allman.sh") };
  process.env.FAKE_ALLMAN_LOG = join(w.root, "allman.log");
  const p = paths(env);
  auditLog = p.auditLog;
  const config: Config = {
    ...DEFAULT_CONFIG,
    clients: { ...DEFAULT_CONFIG.clients, "other-bot": { send_policy: "confirm" } },
    http: {
      port: 0,
      tokens: [
        { client: "openmausbot", sha256: sha(TOKEN) },
        { client: "other-bot", sha256: sha(OTHER) },
        { client: "not-on-allowlist", sha256: sha(OFFLIST) },
      ],
      public_hosts: ["mac.example-tailnet.ts.net"],
    },
  };
  daemon = new Daemon(p, config, () => {}, { notify: () => {} });
  server = daemon.listenHttp();
  daemon.start();
  base = `http://127.0.0.1:${server?.port}`;
});

afterAll(() => {
  server?.stop(true);
  daemon?.stop();
});

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const post = (headers: Record<string, string>, body: unknown = init, path = "/mcp") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

async function connect(token: string) {
  const c = new Client({ name: "omb-test", version: "0" });
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await c.connect(t);
  return { c, t };
}

describe("loopback HTTP", () => {
  test("off unless a port is configured", () => {
    const w = buildWorld();
    const d = new Daemon(paths(w.env), DEFAULT_CONFIG, () => {});
    expect(d.listenHttp()).toBeNull();
    d.stop();
  });

  test("binds 127.0.0.1 only", () => {
    expect(server?.hostname).toBe("127.0.0.1");
  });

  test("no token, a wrong token, or a token for a client off the allowlist: refused", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${OFFLIST}` })).status).toBe(403);
  });

  test("a browser (any Origin) or a foreign Host is refused even with the token", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await post({ ...auth, origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ ...auth, origin: base })).status).toBe(403);
    expect((await post({ ...auth, host: "evil.example" })).status).toBe(403);
    expect((await post({ ...auth, host: "mac.example-tailnet.ts.net.evil.example" })).status).toBe(403);
  });

  test("a configured private host name (tailscale serve) is accepted with the token", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await post({ ...auth, host: "mac.example-tailnet.ts.net" })).status).toBe(200);
    expect((await post({ ...auth, host: "mac.example-tailnet.ts.net:443" })).status).toBe(200);
    expect((await post({ host: "mac.example-tailnet.ts.net" })).status).toBe(401);
  });

  test("only /mcp is served; the approval page is not reachable here", async () => {
    expect((await post({ authorization: `Bearer ${TOKEN}` }, init, "/op/x")).status).toBe(404);
  });

  test("a valid token gets the tools as its own client, approving on the Mac page", async () => {
    const { c } = await connect(TOKEN);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("needs_reply");
    const r = (await c.callTool({ name: "channel_status", arguments: {} })) as { content: Array<{ text: string }> };
    const s = JSON.parse(r.content[0]?.text ?? "{}");
    expect(s.client).toBe("openmausbot");
    expect(s.send.approval).toContain("Mac");
    await c.close();
  });

  test("send over HTTP never uses an elicitation form, even for a harness-approval client", async () => {
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const c = new Client({ name: "omb-test", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    let asked = 0;
    c.setRequestHandler(ElicitRequestSchema, async () => {
      asked++;
      return { action: "accept", content: { send: true } };
    });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${OTHER}` } },
      }),
    );
    const r = (await c.callTool({
      name: "send_message",
      arguments: { thread_id: "li:2-ada", body: "Monday works", idempotency_key: "http-send-1" },
    })) as { content: Array<{ text: string }> };
    expect(asked).toBe(0);
    expect(JSON.parse(r.content[0]?.text ?? "{}").status).toBe("awaiting_approval");
    await c.close();
  });

  test("a session belongs to the token that opened it", async () => {
    const { c, t } = await connect(TOKEN);
    const session = t.sessionId as string;
    expect(session).toBeTruthy();
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const hijack = await post(
      { authorization: `Bearer ${OTHER}`, "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" },
      list,
    );
    expect(hijack.status).toBe(404);
    await c.close();
  });

  test("a refused token is described by shape only", async () => {
    const { authShape } = await import("../src/daemon/http.ts");
    expect(authShape(null)).toBe("missing");
    expect(authShape(`Bearer ${TOKEN}`)).toBe(`Bearer:sbt:${TOKEN.length}`);
    expect(authShape(`Bearer Bearer ${TOKEN}`)).toBe(`Bearer:doubled_bearer:${TOKEN.length + 7}`);
    expect(authShape(`Bearer ${TOKEN}\n`)).toBe(`Bearer:sbt:${TOKEN.length + 1}+whitespace`);
    expect(authShape(TOKEN)).toBe(`one_word:${TOKEN.length}`);
  });

  test("the audit log names the client and never holds the token", async () => {
    const { c } = await connect(TOKEN);
    await c.callTool({ name: "channel_status", arguments: {} });
    await c.close();
    const audit = readFileSync(auditLog, "utf8");
    expect(audit).toContain('"client":"openmausbot"');
    expect(audit).toContain('"transport":"http"');
    expect(audit).not.toContain(TOKEN);
    expect(audit).not.toContain(OTHER);
  });
});
