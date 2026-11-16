/**
 * Filesystem locations. Every path can be redirected with SWITCHBOARD_HOME (tests, dev), and every
 * source database with its own env var, so fixtures never touch the real Mac's data.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

export interface Paths {
  /** ~/Library/Application Support/Switchboard */
  appSupport: string;
  indexDb: string;
  /** Durable send state (operations, drafts). Never deleted by an index rebuild. */
  outboxDb: string;
  socket: string;
  logsDir: string;
  auditLog: string;
  daemonLog: string;
  configFile: string;
  /** Where the installed binaries live (switchboard + pinned allman). */
  installDir: string;
  /** Source databases (read from temp copies only). */
  chatDb: string;
  whatsappDir: string;
  addressBookDir: string;
  /** allman store root; passed as an absolute --store on every call. */
  allmanStore: string;
  /** Explicit allman binary (tests point this at scripts/fake-allman.sh). */
  allmanBin: string | null;
  /** Executables used to hand off sends (tests point these at fakes). */
  osascript: string;
  open: string;
  pbcopy: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = env.SWITCHBOARD_HOME;
  const appSupport = root ? join(root, "app") : join(HOME, "Library/Application Support/Switchboard");
  const logsDir = root ? join(root, "logs") : join(HOME, "Library/Logs/Switchboard");
  return {
    appSupport,
    indexDb: join(appSupport, "index.db"),
    outboxDb: join(appSupport, "outbox.db"),
    // Unix socket paths are limited to ~104 bytes on macOS, so keep it short and outside long dirs.
    socket: env.SWITCHBOARD_SOCKET ?? join(appSupport, "sb.sock"),
    logsDir,
    auditLog: join(logsDir, "audit.jsonl"),
    daemonLog: join(logsDir, "daemon.log"),
    configFile: join(appSupport, "config.json"),
    installDir: env.SWITCHBOARD_INSTALL_DIR ?? join(HOME, "Applications/Switchboard"),
    chatDb: env.SWITCHBOARD_CHAT_DB ?? join(HOME, "Library/Messages/chat.db"),
    whatsappDir:
      env.SWITCHBOARD_WHATSAPP_DIR ?? join(HOME, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"),
    addressBookDir: env.SWITCHBOARD_ADDRESSBOOK_DIR ?? join(HOME, "Library/Application Support/AddressBook"),
    allmanStore: env.SWITCHBOARD_ALLMAN_STORE ?? join(HOME, ".allman"),
    allmanBin: env.SWITCHBOARD_ALLMAN ?? null,
    osascript: env.SWITCHBOARD_OSASCRIPT ?? "/usr/bin/osascript",
    open: env.SWITCHBOARD_OPEN ?? "/usr/bin/open",
    pbcopy: env.SWITCHBOARD_PBCOPY ?? "/usr/bin/pbcopy",
  };
}

/** Server configuration (trusted, local, owner-edited). */
export interface Config {
  profile: string;
  account_id: string;
  /** How far back the first ingest reaches, in days. */
  backfill_days: number;
  whatsapp: { group_max: number };
  /**
   * Client allowlist. Unknown clients fail closed. `approval: "mac_page"` never asks through the
   * harness's elicitation form, only the Mac notification + local page (default "harness": elicitation
   * when the client declares it).
   */
  clients: Record<string, ClientConfig>;
  /** Per-channel mode (Switchboard.app). Missing in an older config: every channel read_write. */
  channels: Record<MessagingChannel, ChannelMode>;
  /** LinkedIn account selector and account-wide send caps shared by every client. */
  linkedin: {
    account: string | null;
    max_sends_per_day: number;
    max_sends_per_minute: number;
    min_interval_seconds: number;
  };
  imessage: {
    max_sends_per_day: number;
    /** Sending into an existing group by chat id: off until the M3 spike shows it works. */
    group_send: boolean;
  };
  /**
   * Loopback Streamable HTTP for clients that can't start the stdio shim on this Mac (a bot host on another
   * machine, reaching this Mac through a private proxy such as `tailscale serve`). Off while port is null.
   * Tokens are stored as sha256 only; the token itself lives in 1Password and the client's own config.
   */
  http: {
    port: number | null;
    tokens: Array<{ client: string; sha256: string }>;
    /** Extra Host names accepted, for a private proxy in front of the loopback port (tailscale serve). */
    public_hosts: string[];
  };
  /** How long a `confirm` approval stays valid, in minutes. */
  approval_ttl_minutes: number;
  /** Message bodies in outbox.db are purged this many days after an operation finishes. */
  outbox_body_retention_days: number;
  /**
   * Scope for `autonomous` clients. Only honoured when `profile` is "allow-autonomous"; every other profile refuses autonomous clients.
   * Dispatch without a new prompt only for these thread ids, until expires_at, within max_per_day.
   */
  autonomous: { thread_ids: string[]; expires_at: string | null; max_per_day: number; config_ref: string | null };
}

export type SendPolicy = "draft-only" | "confirm" | "autonomous";
/** Set per channel in Switchboard.app. off: not read, its copy deleted from the index. read: no sending. */
export type ChannelMode = "off" | "read" | "read_write";
export type MessagingChannel = "linkedin" | "imessage" | "whatsapp";
export interface ClientConfig {
  send_policy: SendPolicy;
  approval?: "harness" | "mac_page";
}

export const DEFAULT_CONFIG: Config = {
  profile: "strict",
  account_id: "default",
  backfill_days: 365,
  whatsapp: { group_max: 8 },
  channels: { linkedin: "read_write", imessage: "read_write", whatsapp: "read_write" },
  clients: {
    "claude-code": { send_policy: "confirm" },
    "claude-desktop": { send_policy: "confirm" },
    // OpenMausBot declines elicitation forms itself, and its cards can be answered from a paired phone.
    openmausbot: { send_policy: "confirm", approval: "mac_page" },
  },
  linkedin: { account: null, max_sends_per_day: 30, max_sends_per_minute: 2, min_interval_seconds: 30 },
  imessage: { max_sends_per_day: 30, group_send: false },
  http: { port: null, tokens: [], public_hosts: [] },
  approval_ttl_minutes: 10,
  outbox_body_retention_days: 30,
  autonomous: { thread_ids: [], expires_at: null, max_per_day: 0, config_ref: null },
};

/** What install / Switchboard.app writes for a new user: nothing is read until they turn a channel on. */
export const FRESH_INSTALL_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  channels: { linkedin: "off", imessage: "off", whatsapp: "off" },
};

export async function loadConfig(p: Paths): Promise<Config> {
  const f = Bun.file(p.configFile);
  if (!(await f.exists())) return DEFAULT_CONFIG;
  const raw = (await f.json()) as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    whatsapp: { ...DEFAULT_CONFIG.whatsapp, ...raw.whatsapp },
    linkedin: { ...DEFAULT_CONFIG.linkedin, ...raw.linkedin },
    imessage: { ...DEFAULT_CONFIG.imessage, ...raw.imessage },
    autonomous: { ...DEFAULT_CONFIG.autonomous, ...raw.autonomous },
    http: { ...DEFAULT_CONFIG.http, ...raw.http },
    channels: { ...DEFAULT_CONFIG.channels, ...raw.channels },
    clients: raw.clients ?? DEFAULT_CONFIG.clients,
  };
}
