/**
 * switchboardd: the one process that holds Full Disk Access and supervises allman. Harnesses reach it
 * through `switchboard mcp` (a stdio shim) over a 0600 unix socket. Each socket connection starts with
 * one hello line {"client": "<label>"}; the label must be on the config allowlist (unknown clients
 * fail closed). The label is an audit/policy name, not proof of identity: every local process running
 * as this user can open the socket.
 */
import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  type FSWatcher,
  mkdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ingestContacts } from "../adapters/contacts/reader.ts";
import { ingestIMessage } from "../adapters/imessage/reader.ts";
import {
  type AllmanOpts,
  findAllman,
  ListenerKeeper,
  ListenSupervisor,
  otherListenerRunning,
  runAllman,
} from "../adapters/linkedin/allman.ts";
import { accountDir, ingestLinkedIn, readAuth } from "../adapters/linkedin/store.ts";
import { ingestWhatsApp, whatsappFiles } from "../adapters/whatsapp/reader.ts";
import { AuditLog } from "../audit.ts";
import {
  type ChannelMode,
  type Config,
  paths as getPaths,
  loadConfig,
  type MessagingChannel,
  type Paths,
} from "../config.ts";
import { type Channel, openIndex } from "../index/db.ts";
import { buildServer, type ChannelStatus, type Service } from "../mcp/tools.ts";
import { type Operation, Outbox, openOutbox } from "../outbox/db.ts";
import { ApprovalPage } from "../send/approval-page.ts";
import { IMessageDispatcher, LinkedInDispatcher, WhatsAppDispatcher } from "../send/dispatch.ts";
import { SendService } from "../send/service.ts";
import { startHttp } from "./http.ts";

type Source = Channel | "contacts";

interface SourceState {
  lastAt: number | null;
  last: Record<string, number> | null;
  problem: string | null;
  running: boolean;
}

function describeError(e: unknown, what: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Error text from SQLite/fs carries paths and codes, never message content.
  const raw = msg.slice(0, 200);
  if (/EPERM|EACCES|authorization denied|unable to open/i.test(msg))
    return `Can't read ${what} (${raw}): check Full Disk Access for the switchboard binary, then restart the daemon (\`switchboard doctor\`).`;
  return raw;
}

export interface DaemonOptions {
  /** Replace the Mac notification + browser open (tests). */
  notify?: (op: Operation, url: string | null) => void;
  /** iMessage send confirmation window (tests shorten it). */
  imessageConfirm?: { confirmWindowMs: number; pollMs: number };
  watchPollMs?: number;
  maxCapWaitMs?: number;
}

export class Daemon implements Service {
  index: Database;
  audit: AuditLog;
  outbox: Outbox;
  send: SendService;
  approvals: ApprovalPage;
  private state = new Map<Source, SourceState>();
  private lastManualSync = new Map<Channel, number>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private watcher: FSWatcher | null = null;
  private listener: ListenerKeeper | null = null;
  private allman: AllmanOpts | null = null;

  constructor(
    readonly p: Paths,
    readonly config: Config,
    private log: (m: string) => void = (m) => console.error(`[switchboardd] ${m}`),
    opts: DaemonOptions = {},
  ) {
    this.index = openIndex(p.indexDb);
    this.audit = new AuditLog(p.auditLog);
    this.outbox = new Outbox(openOutbox(p.outboxDb));
    this.approvals = new ApprovalPage(() => this.send);
    const whatsapp = new WhatsAppDispatcher({ open: p.open, pbcopy: p.pbcopy }, p.whatsappDir);
    this.send = new SendService({
      index: this.index,
      outbox: this.outbox,
      config,
      audit: this.audit,
      dispatchers: {
        linkedin: new LinkedInDispatcher(() => this.allman),
        imessage: new IMessageDispatcher(p.chatDb, p.osascript, opts.imessageConfirm),
        whatsapp,
      },
      whatsapp,
      refresh: (channel) => {
        this.ingest(channel);
      },
      notify: opts.notify ?? ((op, url) => this.notifyMac(op, url)),
      approvalUrl: (op) => this.approvals.url(op),
      watchPollMs: opts.watchPollMs,
      maxCapWaitMs: opts.maxCapWaitMs,
    });
    for (const s of ["linkedin", "imessage", "whatsapp", "contacts"] as Source[])
      this.state.set(s, { lastAt: null, last: null, problem: null, running: false });
    const bin = findAllman(p);
    if (bin) this.allman = { bin, store: p.allmanStore, account: config.linkedin.account };
  }

  private run(source: Source, fn: () => Record<string, number>): Record<string, number> | null {
    const st = this.state.get(source) as SourceState;
    if (st.running) return null;
    st.running = true;
    try {
      const r = fn();
      st.last = r;
      st.lastAt = Date.now();
      st.problem = null;
      return r;
    } catch (e) {
      st.problem = describeError(e, source);
      this.log(`${source} ingest failed: ${st.problem}`);
      return null;
    } finally {
      st.running = false;
      this.writeStatusFile();
    }
  }

  /** Mac notification (recipient name only, never the text) and the approval page in the browser. */
  private notifyMac(op: Operation, url: string | null): void {
    const channel = { linkedin: "LinkedIn", imessage: "iMessage", whatsapp: "WhatsApp" }[op.channel];
    const script =
      'on run argv\n display notification (item 1 of argv) with title "Switchboard" subtitle (item 2 of argv)\nend run';
    try {
      Bun.spawn([this.p.osascript, "-e", script, `Approve ${channel} message to ${op.target.display}?`, op.client], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (url) Bun.spawn([this.p.open, url], { stdout: "ignore", stderr: "ignore" });
    } catch {}
  }

  /** status.json (counts and problems only, never content) so `switchboard doctor` can see the daemon's view. */
  private writeStatusFile(): void {
    try {
      writeFileSync(
        join(this.p.appSupport, "status.json"),
        JSON.stringify(
          {
            pid: process.pid,
            at: new Date().toISOString(),
            approval_port: this.approvals.port,
            channels: this.status(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {}
  }

  mode(c: MessagingChannel): ChannelMode {
    return this.config.channels[c];
  }

  private anyChannelOn(): boolean {
    return (["linkedin", "imessage", "whatsapp"] as const).some((c) => this.mode(c) !== "off");
  }

  /** Off channels: delete their copy (threads, messages, handles, checkpoints) so off means off (docs/DESIGN.md). */
  private purgeOffChannels(): void {
    for (const c of ["linkedin", "imessage", "whatsapp"] as const) {
      if (this.mode(c) !== "off") continue;
      const tx = this.index.transaction(() => {
        const n = this.index.query("delete from messages where channel = ?").run(c).changes;
        this.index.query("delete from threads where channel = ?").run(c);
        this.index.query("delete from handles where channel = ?").run(c);
        this.index.query("delete from checkpoints where source like ?").run(`${c}.%`);
        return n;
      });
      const n = tx();
      if (n) this.log(`${c} is off: removed ${n} messages from the index`);
    }
  }

  ingest(source: Source): Record<string, number> | null {
    const backfillDays = this.config.backfill_days;
    if (source === "contacts" ? !this.anyChannelOn() : this.mode(source) === "off")
      return this.disabled(source, "Switched off in Switchboard settings.");
    switch (source) {
      case "imessage":
        if (!existsSync(this.p.chatDb)) return this.disabled("imessage", "chat.db not found");
        return this.run("imessage", () => {
          const r = ingestIMessage(this.index, this.p.chatDb, { backfillDays });
          return { messages: r.messages, threads: r.threads };
        });
      case "whatsapp":
        if (!existsSync(whatsappFiles(this.p.whatsappDir).chatStorage))
          return this.disabled("whatsapp", "WhatsApp desktop not installed or not linked on this Mac");
        return this.run("whatsapp", () => {
          const r = ingestWhatsApp(this.index, this.p.whatsappDir, {
            backfillDays,
            groupMax: this.config.whatsapp.group_max,
          });
          return { messages: r.messages, threads: r.threads, skipped_large_groups: r.skippedLargeGroups };
        });
      case "contacts":
        return this.run("contacts", () => ingestContacts(this.index, this.p.addressBookDir));
      case "linkedin": {
        const dir = accountDir(this.p.allmanStore, this.config.linkedin.account);
        if (!dir)
          return this.disabled(
            "linkedin",
            "No allman account in the store: run `allman login` (see `switchboard doctor`).",
          );
        return this.run("linkedin", () => ingestLinkedIn(this.index, dir, { backfillDays }));
      }
    }
  }

  private disabled(source: Source, why: string): null {
    const st = this.state.get(source) as SourceState;
    st.problem = why;
    this.writeStatusFile();
    return null;
  }

  status(): ChannelStatus[] {
    const out: ChannelStatus[] = [];
    const base = (s: Source): Omit<ChannelStatus, "channel" | "enabled" | "connected" | "auth"> => {
      const st = this.state.get(s) as SourceState;
      return {
        last_ingest_at: st.lastAt ? new Date(st.lastAt).toISOString() : null,
        last_ingest: st.last,
        problems: st.problem ? [st.problem] : [],
      };
    };
    const dir = accountDir(this.p.allmanStore, this.config.linkedin.account);
    let auth = "no account";
    if (dir) {
      try {
        auth = readAuth(dir).status;
      } catch {
        auth = "unreadable";
      }
    }
    const li = base("linkedin");
    if (!this.allman) li.problems.push("Pinned allman binary not found (run scripts/fetch-allman.sh or reinstall).");
    if (auth === "expired") li.problems.push("LinkedIn session expired: run `allman login`.");
    out.push({
      channel: "linkedin",
      enabled: Boolean(dir),
      connected: auth === "authenticated",
      auth,
      ...li,
      listener_running: this.listener?.running ?? false,
      mode: this.mode("linkedin"),
    });
    const im = base("imessage");
    out.push({
      channel: "imessage",
      enabled: existsSync(this.p.chatDb),
      connected: im.problems.length === 0 && im.last_ingest_at !== null,
      auth: "local",
      ...im,
      mode: this.mode("imessage"),
    });
    const wa = base("whatsapp");
    const waOn = existsSync(whatsappFiles(this.p.whatsappDir).chatStorage);
    out.push({
      channel: "whatsapp",
      enabled: waOn,
      connected: waOn && wa.problems.length === 0 && wa.last_ingest_at !== null,
      auth: "local",
      ...wa,
      mode: this.mode("whatsapp"),
    });
    const ct = base("contacts");
    out.push({
      channel: "contacts",
      enabled: true,
      connected: ct.problems.length === 0 && ct.last_ingest_at !== null,
      auth: "local",
      ...ct,
    });
    return out;
  }

  async syncNow(channel: Channel): Promise<{ ok: boolean; message: string; counts?: Record<string, number> }> {
    const last = this.lastManualSync.get(channel) ?? 0;
    const wait = 60_000 - (Date.now() - last);
    if (wait > 0) return { ok: false, message: `Rate limited: try again in ${Math.ceil(wait / 1000)}s.` };
    this.lastManualSync.set(channel, Date.now());
    if (channel === "linkedin") {
      if (!this.allman) return { ok: false, message: "Pinned allman binary not found." };
      const r = await runAllman(this.allman, ["sync", "--json"], 10 * 60_000);
      if (r.code !== 0) return { ok: false, message: `allman sync failed (exit ${r.code}): ${r.stderr.slice(-300)}` };
    }
    const counts = this.ingest(channel);
    const problem = this.state.get(channel)?.problem;
    return counts
      ? { ok: true, message: "Ingested.", counts }
      : { ok: false, message: problem ?? "Ingest already running." };
  }

  /** Start periodic ingest, the allman store watcher and the listen supervisor. */
  start(): void {
    this.purgeOffChannels();
    this.ingest("contacts");
    for (const s of ["imessage", "whatsapp", "linkedin"] as Source[]) this.ingest(s);
    this.approvals.start();
    const r = this.send.recover();
    if (r.cancelled || r.reconciled || r.unconfirmed)
      this.log(`outbox recovery: ${r.cancelled} cancelled, ${r.reconciled} reconciled, ${r.unconfirmed} unconfirmed`);
    this.send.housekeeping();
    this.writeStatusFile();
    this.timers.push(setInterval(() => this.send.housekeeping(), 60_000));
    this.timers.push(setInterval(() => this.ingest("imessage"), 30_000));
    this.timers.push(setInterval(() => this.ingest("whatsapp"), 30_000));
    // Hourly once healthy; every 30s while failing, so a fresh permission grant is picked up quickly.
    let lastContacts = Date.now();
    this.timers.push(
      setInterval(() => {
        const failing = Boolean(this.state.get("contacts")?.problem);
        if (failing || Date.now() - lastContacts >= 60 * 60_000) {
          lastContacts = Date.now();
          this.ingest("contacts");
        }
      }, 30_000),
    );
    // Fallback in case FSEvents misses a write.
    this.timers.push(setInterval(() => this.ingest("linkedin"), 60_000));
    this.startLinkedInWatch();
  }

  private startLinkedInWatch(): void {
    if (this.mode("linkedin") === "off") return; // turning it on restarts the daemon (Switchboard.app)
    const dir = accountDir(this.p.allmanStore, this.config.linkedin.account);
    if (!dir) {
      // Not logged in yet: look again in a minute (login can happen while the daemon runs).
      setTimeout(() => this.startLinkedInWatch(), 60_000);
      return;
    }
    let pending: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        this.ingest("linkedin");
      }, 750);
    };
    this.watcher = watch(dir, { recursive: true }, (_e, file) => {
      if (file && (file.endsWith(".jsonl") || file.endsWith("RECORD.json"))) nudge();
    });
    let auth = "unknown";
    try {
      auth = readAuth(dir).status;
    } catch {}
    if (this.allman && auth === "authenticated") {
      const opts = this.allman;
      this.listener = new ListenerKeeper(
        () => otherListenerRunning(this.p.allmanStore),
        () => new ListenSupervisor(opts, nudge, this.log),
        this.log,
      );
      this.listener.check();
      this.timers.push(setInterval(() => this.listener?.check(), 60_000));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.watcher?.close();
    this.listener?.stop();
    this.send.stop();
    this.approvals.stop();
    this.outbox.db.close();
    this.index.close();
  }

  /** Accept MCP sessions on the unix socket. */
  listen(): ReturnType<typeof createServer> {
    mkdirSync(this.p.appSupport, { recursive: true, mode: 0o700 });
    if (existsSync(this.p.socket)) rmSync(this.p.socket);
    const server = createServer((conn) => this.accept(conn));
    // Not via process.umask: that is process-wide, and anything spawned before the listen callback
    // (start() runs `allman listen` right after) inherits it. With 0177 git made object folders allman
    // couldn't open (2026-11-09). The socket's 0700 parent covers the moment before the chmod.
    server.listen(this.p.socket, () => chmodSync(this.p.socket, 0o600));
    return server;
  }

  /** An MCP server for an allowlisted client, recording what the harness reports about itself once it initializes. */
  openClient(label: string, transport: "socket" | "http"): ReturnType<typeof buildServer> {
    const mcp = buildServer(this, { label, elicitation: transport === "socket" });
    mcp.server.oninitialized = () => {
      const info = mcp.server.getClientVersion();
      const caps = mcp.server.getClientCapabilities();
      // M0 spike record: what each harness reports about itself and whether it offers elicitation.
      this.audit.write({
        event: "client_connected",
        client: label,
        transport,
        client_info: info ? { name: info.name, version: info.version } : null,
        elicitation: caps?.elicitation
          ? Object.keys(caps.elicitation).length
            ? Object.keys(caps.elicitation)
            : ["form"]
          : false,
      });
    };
    return mcp;
  }

  /** Loopback Streamable HTTP for token-holding clients (M4); null while config.http.port is unset. */
  listenHttp(): ReturnType<typeof startHttp> {
    return startHttp({ config: this.config, audit: this.audit, open: (label) => this.openClient(label, "http") });
  }

  private accept(conn: Socket): void {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > 4096) conn.destroy();
        return;
      }
      conn.off("data", onData);
      let label = "";
      try {
        label = String(JSON.parse(buf.subarray(0, nl).toString("utf8")).client ?? "");
      } catch {}
      if (!this.config.clients[label]) {
        this.audit.write({ event: "client_rejected", client: label.slice(0, 40) });
        conn.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `Client '${label}' is not on this install's allowlist.` } })}\n`,
        );
        return;
      }
      const input = new PassThrough();
      input.write(buf.subarray(nl + 1));
      conn.pipe(input);
      const mcp = this.openClient(label, "socket");
      const transport = new StdioServerTransport(input, conn);
      conn.on("close", () => void mcp.close().catch(() => {}));
      conn.on("error", () => {});
      void mcp.connect(transport);
    };
    conn.on("data", onData);
  }
}

export async function runDaemon(): Promise<void> {
  process.umask(0o077);
  const p = getPaths();
  // Switchboard.app's agent plist can't name a per-user log path, so it asks the daemon to append its own log.
  if (process.env.SWITCHBOARD_LOG_TO_FILE === "1") {
    mkdirSync(p.logsDir, { recursive: true, mode: 0o700 });
    const write = (...a: unknown[]) => {
      try {
        appendFileSync(p.daemonLog, `${a.map(String).join(" ")}\n`, { mode: 0o600 });
      } catch {}
    };
    console.error = write;
    console.log = write;
  }
  const config = await loadConfig(p);
  const d = new Daemon(p, config);
  // Run by Switchboard.app as its child: exit if the app goes away (crash, force-quit), so no orphan keeps the socket.
  const parent = Number(process.env.SWITCHBOARD_PARENT_PID ?? 0);
  if (parent > 1)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        console.error("[switchboardd] Switchboard.app is gone; exiting");
        process.kill(process.pid, "SIGTERM");
      }
    }, 5_000);
  d.listen();
  const http = d.listenHttp();
  d.start();
  console.error(`[switchboardd] listening on ${p.socket}${http ? ` and http://127.0.0.1:${http.port}/mcp` : ""}`);
  const shutdown = () => {
    d.stop();
    rmSync(p.socket, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
