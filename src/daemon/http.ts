/**
 * Loopback Streamable HTTP (M4). For clients that can't start `switchboard mcp` on this Mac: a bot host on
 * another machine reaches it through a private proxy (e.g. `tailscale serve`) and sends our Authorization
 * header (docs/DESIGN.md).
 *
 * Every request needs a per-client bearer token (stored here as sha256 only) whose client is on the allowlist;
 * the token, not a label the caller picks, decides the client. A session id is bound to the token that opened
 * it. Any Origin header is refused (browsers send one; server-side MCP clients don't), and Host must be
 * this loopback address, so a web page can't reach it by DNS rebinding. Only /mcp is served here; the approval
 * page stays on its own port.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";

const IDLE_MS = 30 * 60_000;

interface Session {
  client: string;
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: McpServer;
  lastAt: number;
}

export interface HttpDeps {
  config: Config;
  audit: AuditLog;
  /** Build an MCP server for this client and record its connection (same as the socket path). */
  open: (client: string) => McpServer;
}

const json = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A description of an Authorization header that reveals nothing of its value. */
export function authShape(header: string | null): string {
  if (!header) return "missing";
  const m = /^(\S+) (.*)$/s.exec(header);
  if (!m) return `one_word:${header.length}`;
  const value = m[2] as string;
  const scheme = /^bearer$/i.test(m[1] as string) ? (m[1] === "Bearer" ? "Bearer" : "bearer_case") : "other_scheme";
  const extra = value !== value.trim() ? "+whitespace" : "";
  const prefix = value.trim().startsWith("sbt_")
    ? "sbt"
    : value.trim().startsWith("Bearer")
      ? "doubled_bearer"
      : "other";
  return `${scheme}:${prefix}:${value.length}${extra}`;
}

/** Which client does this bearer token belong to? null when it matches none. */
export function clientForToken(config: Config, header: string | null): string | null {
  const m = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header ?? "");
  if (!m) return null;
  const got = createHash("sha256")
    .update(m[1] as string)
    .digest();
  let found: string | null = null;
  for (const t of config.http.tokens) {
    const want = Buffer.from(t.sha256, "hex");
    // Compare against every entry, so timing says nothing about which (if any) matched.
    if (want.length === got.length && timingSafeEqual(want, got)) found = t.client;
  }
  return found;
}

export function startHttp(deps: HttpDeps): ReturnType<typeof Bun.serve> | null {
  const { config, audit } = deps;
  if (config.http.port === null) return null;
  const sessions = new Map<string, Session>();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of sessions)
      if (s.lastAt < cutoff) {
        sessions.delete(id);
        void s.mcp.close().catch(() => {});
      }
  }, 60_000);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.http.port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get("host") ?? "";
      const allowed =
        host === `127.0.0.1:${server.port}` ||
        host === `localhost:${server.port}` ||
        // A private name a local proxy forwards here (tailscale serve on the user's own tailnet), with or without :443.
        config.http.public_hosts.some((h) => host === h || host === `${h}:443`);
      if (req.headers.has("origin") || !allowed) return json(403, "Forbidden.");
      if (url.pathname !== "/mcp") return json(404, "Not found.");

      const client = clientForToken(config, req.headers.get("authorization"));
      if (!client) {
        audit.write({
          event: "client_rejected",
          transport: "http",
          reason: "token",
          // Shape only, never the value: tells a stale token from a malformed or missing header.
          auth: authShape(req.headers.get("authorization")),
          via: req.headers.get("x-forwarded-for") ? "proxy" : "loopback",
          user_agent: (req.headers.get("user-agent") ?? "").slice(0, 60),
        });
        return json(401, "A valid bearer token is required.");
      }
      if (!config.clients[client]) {
        audit.write({ event: "client_rejected", transport: "http", client: client.slice(0, 40) });
        return json(403, `Client '${client}' is not on this install's allowlist.`);
      }

      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const s = sessions.get(sid);
        // An unknown id, or one opened by another token: the client must initialize again.
        if (!s || s.client !== client) return json(404, "Session not found.");
        s.lastAt = Date.now();
        return s.transport.handleRequest(req);
      }

      if (req.method !== "POST") return json(400, "Initialize first.");
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, "Invalid JSON.");
      }
      if (!isInitializeRequest(body)) return json(400, "Initialize first.");

      const mcp = deps.open(client);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { client, transport, mcp, lastAt: Date.now() });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      await mcp.connect(transport);
      return transport.handleRequest(req, { parsedBody: body });
    },
  });

  const stop = server.stop.bind(server);
  server.stop = ((force?: boolean) => {
    clearInterval(sweep);
    for (const s of sessions.values()) void s.mcp.close().catch(() => {});
    sessions.clear();
    return stop(force);
  }) as typeof server.stop;
  return server;
}
