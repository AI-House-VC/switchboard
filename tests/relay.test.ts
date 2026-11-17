/**
 * switchboard relay: an always-on stand-in on the bot host. It always answers the MCP handshake and the tool
 * list, passes calls through to the Mac when the Mac answers, and says "offline" (never stalling) when it doesn't.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Config, DEFAULT_CONFIG, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import { buildServer, type Service } from "../src/mcp/tools.ts";
import { type Relay, startRelay } from "../src/relay/relay.ts";
import snapshot from "../src/relay/snapshot.json" with { type: "json" };
import { buildWorld } from "./fixtures/world.ts";

const ROOT = join(import.meta.dir, "..");
const TOKEN = "sbt_test_openmausbot_0123456789abcdef";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

let daemon: Daemon;
let config: Config;
let upstream: ReturnType<Daemon["listenHttp"]>;
let upstreamPort: number;
const relays: Relay[] = [];

beforeAll(() => {
  const w = buildWorld();
  const env = { ...w.env, SWITCHBOARD_ALLMAN: join(ROOT, "scripts/fake-allman.sh") };
  process.env.FAKE_ALLMAN_LOG = join(w.root, "allman.log");
  config = {
    ...DEFAULT_CONFIG,
    http: { port: 0, tokens: [{ client: "openmausbot", sha256: sha(TOKEN) }], public_hosts: [] },
  };
  daemon = new Daemon(paths(env), config, () => {}, { notify: () => {} });
  upstream = daemon.listenHttp();
  upstreamPort = upstream?.port as number;
  config.http.port = upstreamPort; // so a restart comes back on the same port
  daemon.start();
});

afterAll(async () => {
  for (const r of relays) await r.close();
  upstream?.stop(true);
  daemon?.stop();
});

const stateDir = () => mkdtempSync(join(tmpdir(), "sb-relay-"));

async function relayTo(url: string, dir = stateDir()) {
  const r = await startRelay({ upstream: url, port: 0, stateDir: dir, connectTimeoutMs: 1500, offlineHoldMs: 0 });
  relays.push(r);
  return r;
}

async function connect(r: Relay, token = TOKEN) {
  const c = new Client({ name: "omb-test", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${r.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const DEAD = "http://127.0.0.1:9/mcp"; // discard port: nothing listens

describe("switchboard relay", () => {
  test("the bundled tool list matches this version's tools", async () => {
    const server = buildServer({} as Service, { label: "snapshot", elicitation: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "snap", version: "0" });
    await c.connect(b);
    const { tools } = await c.listTools();
    expect(snapshot.tools).toEqual(JSON.parse(JSON.stringify(tools)));
    expect(snapshot.instructions).toBe(c.getInstructions() ?? "");
    await c.close();
  });

  test("Mac unreachable: the handshake and tool list still answer, quickly", async () => {
    const r = await relayTo(DEAD);
    const started = Date.now();
    const c = await connect(r);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("needs_reply");
    expect(c.getInstructions()).toContain("offline");
    expect(Date.now() - started).toBeLessThan(5000);
    await c.close();
  });

  test("Mac unreachable: a call says offline and that nothing happened", async () => {
    const r = await relayTo(DEAD);
    const c = await connect(r);
    const res = await c.callTool({ name: "needs_reply", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("offline");
    expect(text(res)).toContain("Nothing was sent");
    await c.close();
  });

  test("Mac up: calls pass through with the caller's token", async () => {
    const r = await relayTo(`http://127.0.0.1:${upstreamPort}/mcp`);
    const c = await connect(r);
    const res = await c.callTool({ name: "channel_status", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).client).toBe("openmausbot");
    await c.close();
  });

  test("Mac up but the token is wrong: the Mac's refusal comes back, not a fake offline", async () => {
    const r = await relayTo(`http://127.0.0.1:${upstreamPort}/mcp`);
    const c = await connect(r, "sbt_wrong_token_0123456789abcdef");
    const res = await c.callTool({ name: "channel_status", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("refused");
    await c.close();
  });

  test("the Mac's tool list is remembered for when it's offline", async () => {
    const dir = stateDir();
    const up = await relayTo(`http://127.0.0.1:${upstreamPort}/mcp`, dir);
    const c = await connect(up);
    await c.listTools();
    await c.close();
    const cached = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8"));
    expect(cached.tools.map((t: { name: string }) => t.name)).toContain("send_message");
  });

  test("the Mac restarted (session gone): the relay reconnects and the call runs once", async () => {
    const r = await relayTo(`http://127.0.0.1:${upstreamPort}/mcp`);
    const c = await connect(r);
    expect((await c.callTool({ name: "channel_status", arguments: {} })).isError).toBeFalsy();
    upstream?.stop(true);
    upstream = daemon.listenHttp();
    const res = await c.callTool({ name: "channel_status", arguments: {} });
    expect(res.isError).toBeFalsy();
    await c.close();
  });

  test("callers need a bearer token; browsers and foreign hosts are refused", async () => {
    const r = await relayTo(DEAD);
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${r.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}`, origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${TOKEN}`, host: "evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  test("binds loopback only", async () => {
    const r = await relayTo(DEAD);
    expect(r.host).toBe("127.0.0.1");
  });
});
