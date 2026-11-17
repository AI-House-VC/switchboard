/**
 * `switchboard relay`: an always-on stand-in for Switchboard on a bot host (OpenMausBot on a server or a Mac
 * Mini), for when Switchboard itself runs on a laptop that sleeps (docs/DESIGN.md, "Relay").
 *
 * Some bot hosts start every turn by connecting to every MCP server a bot has; one that doesn't answer stops
 * the turn, even when the bot never needed it. The relay always answers the handshake and the tool list (the
 * Mac's list when it answers, else the last one it gave, else the list bundled with this version), passes each
 * call through to the Mac, and when the Mac doesn't answer returns "Switchboard is offline" at once.
 *
 * It holds no secret: it forwards the caller's own Authorization header, and the Mac decides who gets in.
 * Calls are never repeated, except when the Mac said it doesn't know the session (it restarted), which it
 * says before running anything. Logs hold tool names and outcomes only, never arguments or results.
 * Plain Node (no Bun APIs), so it runs on the Node a bot host already ships.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  isInitializeRequest,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import snapshot from "./snapshot.json" with { type: "json" };

export const OFFLINE_NOTE =
  "This connection goes through a relay on the bot host. When the Mac running Switchboard is asleep or closed, " +
  "tools return 'Switchboard is offline' and nothing is sent: carry on with other work and try again later " +
  "(don't retry in a loop).";

const OFFLINE =
  "Switchboard is offline: the Mac it runs on isn't answering (probably asleep or closed). Nothing was sent or " +
  "changed. Carry on without it and try again later; don't retry in a loop.";
const REFUSED =
  "Switchboard on the Mac refused this connection (its token is wrong or was revoked). Nothing was sent. " +
  "Tell the person who set it up; retrying won't help.";
const UNKNOWN =
  "Switchboard stopped answering partway through this call, so it may or may not have happened. Don't repeat it " +
  "now: once Switchboard is back, check first (get_send_status or list_drafts for a send).";

/** The Mac's own sessions expire after 30 idle minutes; reconnect a little before that. */
const UPSTREAM_STALE_MS = 25 * 60_000;
const IDLE_MS = 30 * 60_000;
/** Errors that mean the request never reached the Mac. */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ConnectionRefused",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface RelayOptions {
  /** The Mac's Switchboard endpoint, e.g. https://mac.tailnet.ts.net/mcp */
  upstream: string;
  port: number;
  host?: string;
  /** Where the last tool list the Mac gave is kept. */
  stateDir: string;
  /** How long to wait for the Mac before saying offline. */
  connectTimeoutMs?: number;
  /** How long a call may run (a send waits for the human's approval on the Mac). */
  callTimeoutMs?: number;
  /** After the Mac fails to answer, say offline at once for this long instead of waiting again. */
  offlineHoldMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface Relay {
  port: number;
  host: string;
  close(): Promise<void>;
}

interface ToolList {
  tools: Tool[];
  instructions: string;
}

const errorCode = (e: unknown): string | undefined => {
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" ? code : undefined;
};

/** Did the Mac say no (401/403), rather than not answer? */
const refused = (e: unknown) => e instanceof StreamableHTTPError && (e.code === 401 || e.code === 403);

const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** One connection to the Mac, made with one caller's token. */
class Upstream {
  private client: Client | null = null;
  private lastAt = 0;

  constructor(
    private readonly url: URL,
    private readonly authorization: string,
    private readonly timeoutMs: number,
  ) {}

  async get(): Promise<Client> {
    if (this.client && Date.now() - this.lastAt < UPSTREAM_STALE_MS) {
      this.lastAt = Date.now();
      return this.client;
    }
    await this.drop();
    const client = new Client({ name: "switchboard-relay", version: snapshot.version });
    const transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: { headers: { authorization: this.authorization } },
    });
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), this.timeoutMs);
    try {
      await client.connect(transport, { timeout: this.timeoutMs, signal: timer.signal });
    } catch (e) {
      void client.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(t);
    }
    this.client = client;
    this.lastAt = Date.now();
    return client;
  }

  async drop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => {});
  }
}

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const host = opts.host ?? "127.0.0.1";
  const url = new URL(opts.upstream);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 4000;
  const callTimeoutMs = opts.callTimeoutMs ?? 20 * 60_000;
  const offlineHoldMs = opts.offlineHoldMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const cacheFile = join(opts.stateDir, "tools.json");
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });

  let offlineUntil = 0;
  const bundled: ToolList = { tools: snapshot.tools as unknown as Tool[], instructions: snapshot.instructions };
  const cached = (): ToolList => {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8")) as ToolList;
      if (Array.isArray(c.tools) && c.tools.length) return c;
    } catch {}
    return bundled;
  };
  const remember = (list: ToolList) => {
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ saved_at: new Date().toISOString(), ...list }), { mode: 0o600 });
      renameSync(tmp, cacheFile);
    } catch {}
  };

  /** The Mac's client, or why there isn't one. */
  const reach = async (up: Upstream): Promise<Client | CallToolResult> => {
    if (Date.now() < offlineUntil) return fail(OFFLINE);
    try {
      return await up.get();
    } catch (e) {
      if (refused(e)) return fail(REFUSED);
      offlineUntil = Date.now() + offlineHoldMs;
      return fail(OFFLINE);
    }
  };
  const isClient = (x: Client | CallToolResult): x is Client => x instanceof Client;

  const listTools = async (up: Upstream): Promise<Tool[]> => {
    const c = await reach(up);
    if (isClient(c)) {
      try {
        const { tools } = await c.listTools(undefined, { timeout: connectTimeoutMs });
        remember({ tools, instructions: c.getInstructions() ?? bundled.instructions });
        return tools;
      } catch {
        await up.drop();
      }
    }
    return cached().tools;
  };

  const callTool = async (up: Upstream, name: string, args: Record<string, unknown> | undefined) => {
    const options = { timeout: callTimeoutMs, resetTimeoutOnProgress: true };
    const first = await reach(up);
    if (!isClient(first)) return first;
    try {
      return (await first.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
    } catch (e) {
      if (e instanceof StreamableHTTPError && e.code === 404) {
        // The Mac doesn't know this session (it restarted). It refused before running anything, so one fresh try.
        await up.drop();
        const again = await reach(up);
        if (!isClient(again)) return again;
        try {
          return (await again.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
        } catch {
          await up.drop();
          return fail(UNKNOWN);
        }
      }
      await up.drop();
      if (refused(e)) return fail(REFUSED);
      if (NOT_SENT.has(errorCode(e) ?? "")) {
        offlineUntil = Date.now() + offlineHoldMs;
        return fail(OFFLINE);
      }
      return fail(UNKNOWN);
    }
  };

  const openSession = (authorization: string) => {
    const up = new Upstream(url, authorization, connectTimeoutMs);
    const server = new Server(
      { name: "switchboard", version: snapshot.version },
      { capabilities: { tools: {} }, instructions: `${cached().instructions} ${OFFLINE_NOTE}` },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(up) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const result = await callTool(up, req.params.name, req.params.arguments);
      const text = result.isError ? (result.content?.[0] as { text?: string } | undefined)?.text : undefined;
      log({
        event: "call",
        tool: req.params.name,
        outcome: text === OFFLINE ? "offline" : text === REFUSED ? "refused" : text === UNKNOWN ? "unknown" : "passed",
      });
      return result;
    });
    return { up, server };
  };

  interface Session {
    authHash: string;
    transport: StreamableHTTPServerTransport;
    server: Server;
    up: Upstream;
    lastAt: number;
  }
  const sessions = new Map<string, Session>();
  const end = (s: Session) => {
    void s.server.close().catch(() => {});
    void s.up.drop();
  };
  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of sessions)
      if (s.lastAt < cutoff) {
        sessions.delete(id);
        end(s);
      }
  }, 60_000);
  sweep.unref?.();

  const reply = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }));
  };
  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 4 * 1024 * 1024) throw new Error("too large");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };

  const http = createServer(async (req, res) => {
    try {
      const port = (http.address() as AddressInfo).port;
      const hostHeader = req.headers.host ?? "";
      const loopback = hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
      if (req.headers.origin !== undefined || !loopback) return reply(res, 403, "Forbidden.");
      if (new URL(req.url ?? "/", "http://relay").pathname !== "/mcp") return reply(res, 404, "Not found.");
      const authorization = req.headers.authorization ?? "";
      if (!/^Bearer [\x21-\x7e]{16,512}$/.test(authorization)) return reply(res, 401, "A bearer token is required.");
      const authHash = createHash("sha256").update(authorization).digest("hex");

      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const s = sessions.get(sid);
        if (!s || s.authHash !== authHash) return reply(res, 404, "Session not found.");
        s.lastAt = Date.now();
        return await s.transport.handleRequest(req, res);
      }
      if (req.method !== "POST") return reply(res, 400, "Initialize first.");
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return reply(res, 400, "Invalid JSON.");
      }
      if (!isInitializeRequest(body)) return reply(res, 400, "Initialize first.");

      const { up, server } = openSession(authorization);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { authHash, transport, server, up, lastAt: Date.now() });
        },
        onsessionclosed: (id) => {
          const s = sessions.get(id);
          sessions.delete(id);
          if (s) end(s);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reply(res, 500, "Relay error.");
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  log({ event: "listening", host, port, upstream_host: url.host });

  return {
    port,
    host,
    async close() {
      clearInterval(sweep);
      for (const s of sessions.values()) end(s);
      sessions.clear();
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
