/**
 * Commands Switchboard.app runs (the app is a thin SwiftUI front end; the logic lives here, tested):
 *   switchboard set-channel <linkedin|imessage|whatsapp> <off|read|read_write>
 *   switchboard app-setup
 * The app restarts the background service after set-channel; the daemon applies modes at start (off channels are
 * purged then). Tools can never call these: they're CLI-only, run by the user's own app.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ChannelMode, FRESH_INSTALL_CONFIG, type MessagingChannel, type Paths } from "../config.ts";

const CHANNELS: MessagingChannel[] = ["linkedin", "imessage", "whatsapp"];
const MODES: ChannelMode[] = ["off", "read", "read_write"];

/** The older terminal install's LaunchAgent label (Switchboard.app runs the daemon as its own child instead). */
export const OLD_AGENT_LABEL = "vc.aihouse.switchboard";

function readRaw(p: Paths): Record<string, unknown> | null {
  if (!existsSync(p.configFile)) return null;
  return JSON.parse(readFileSync(p.configFile, "utf8")) as Record<string, unknown>;
}

function writeRaw(p: Paths, c: Record<string, unknown>): void {
  mkdirSync(p.appSupport, { recursive: true, mode: 0o700 });
  const tmp = `${p.configFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p.configFile);
}

export function setChannel(p: Paths, channel: string, mode: string): Record<MessagingChannel, ChannelMode> {
  if (!CHANNELS.includes(channel as MessagingChannel)) throw new Error(`unknown channel '${channel}'`);
  if (!MODES.includes(mode as ChannelMode)) throw new Error(`unknown mode '${mode}' (off, read, read_write)`);
  const raw = readRaw(p) ?? (structuredClone(FRESH_INSTALL_CONFIG) as unknown as Record<string, unknown>);
  // An older config without `channels` meant every channel read_write; keep that for the channels not touched.
  const current = (raw.channels as Record<MessagingChannel, ChannelMode> | undefined) ?? {
    linkedin: "read_write",
    imessage: "read_write",
    whatsapp: "read_write",
  };
  const next = { ...current, [channel]: mode } as Record<MessagingChannel, ChannelMode>;
  writeRaw(p, { ...raw, channels: next });
  return next;
}

export interface AppSetupDeps {
  home?: string;
  /** Runs launchctl/claude; returns the exit code. */
  run?: (cmd: string[]) => number;
  /** The switchboard binary inside the app (Contents/Helpers/switchboard). */
  bin: string;
  /** Filesystem root for /Applications and system bin folders (tests point it at a temp dir). */
  root?: string;
}

export interface AppSetupResult {
  config_created: boolean;
  old_agent_removed: boolean;
  claude_code: "registered" | "not_installed" | "failed";
  /** The Claude app (Claude Desktop). "updated": written just now, so Claude needs a restart to load it. */
  claude_desktop: "registered" | "updated" | "not_installed" | "failed";
}

/**
 * The `claude` CLI. Switchboard.app is started by launchd with a minimal PATH, so `which` misses the usual install
 * places; look there too.
 */
export function findClaudeCli(home: string, root: string, run: (cmd: string[]) => number): string | null {
  if (run(["/usr/bin/env", "which", "claude"]) === 0) return "claude";
  for (const c of [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    join(root, "opt/homebrew/bin/claude"),
    join(root, "usr/local/bin/claude"),
  ])
    if (existsSync(c)) return c;
  return null;
}

/**
 * Add Switchboard to the Claude app's local MCP servers (claude_desktop_config.json), keeping everything else in
 * that file. Never overwrites a file it can't parse; keeps one backup of the file as it was before the first change.
 */
export function registerClaudeDesktop(home: string, root: string, bin: string): AppSetupResult["claude_desktop"] {
  const installed = [join(root, "Applications/Claude.app"), join(home, "Applications/Claude.app")].some(existsSync);
  if (!installed) return "not_installed";
  const file = join(home, "Library/Application Support/Claude/claude_desktop_config.json");
  const entry = { command: bin, args: ["mcp", "--client", "claude-desktop"] };
  let c: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "failed";
      c = parsed as Record<string, unknown>;
    } catch {
      return "failed";
    }
  }
  const servers = (c.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) return "failed";
  if (JSON.stringify(servers.switchboard) === JSON.stringify(entry)) return "registered";
  const backup = `${file}.before-switchboard`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.switchboard-tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...c, mcpServers: { ...servers, switchboard: entry } }, null, 2)}\n`, {
    mode,
  });
  renameSync(tmp, file);
  return "updated";
}

/** First launch and every launch of Switchboard.app: config, retire the old CLI install's agent, point Claude Code and the Claude app here. */
export function appSetup(p: Paths, deps: AppSetupDeps): AppSetupResult {
  const run = deps.run ?? ((cmd) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).exitCode);
  const home = deps.home ?? homedir();
  mkdirSync(p.appSupport, { recursive: true, mode: 0o700 });
  mkdirSync(p.logsDir, { recursive: true, mode: 0o700 });
  let created = false;
  if (!existsSync(p.configFile)) {
    writeRaw(p, structuredClone(FRESH_INSTALL_CONFIG) as unknown as Record<string, unknown>);
    created = true;
  }
  // The terminal install (switchboard install) ran the daemon from ~/Library/LaunchAgents; the app's own agent
  // replaces it. Only our own plist is removed.
  const oldPlist = join(home, "Library/LaunchAgents", `${OLD_AGENT_LABEL}.plist`);
  let removed = false;
  if (existsSync(oldPlist)) {
    run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${OLD_AGENT_LABEL}`]);
    rmSync(oldPlist, { force: true });
    removed = true;
  }
  const root = deps.root ?? "/";
  let claude: AppSetupResult["claude_code"] = "not_installed";
  const cli = findClaudeCli(home, root, run);
  if (cli) {
    run([cli, "mcp", "remove", "switchboard", "-s", "user"]);
    claude =
      run([cli, "mcp", "add", "--scope", "user", "switchboard", "--", deps.bin, "mcp", "--client", "claude-code"]) === 0
        ? "registered"
        : "failed";
  }
  return {
    config_created: created,
    old_agent_removed: removed,
    claude_code: claude,
    claude_desktop: registerClaudeDesktop(home, root, deps.bin),
  };
}
