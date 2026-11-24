/**
 * `switchboard doctor`: checks the install end to end and prints fixes. Prints counts and states only,
 * never message content.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALLMAN_VERSION, allmanTrusted, findAllman } from "../adapters/linkedin/allman.ts";
import { accountDir, readAuth } from "../adapters/linkedin/store.ts";
import { whatsappFiles } from "../adapters/whatsapp/reader.ts";
import { paths } from "../config.ts";
import { findClaudeCli } from "./app.ts";
import { LABEL, plistPath } from "./install.ts";

type Level = "ok" | "warn" | "fail";
const mark: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

interface Line {
  level: Level;
  what: string;
  fix?: string;
}

/** Run a command; null when it can't be started (not installed, not on PATH). */
function tryRun(cmd: string[]): { exitCode: number; stdout: string } | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString() };
  } catch {
    return null;
  }
}

/** One channel from the daemon's status.json. `mode` (off/read/read_write) decides; `enabled` only says its data exists. */
export function channelLine(c: {
  channel: string;
  enabled: boolean;
  connected: boolean;
  auth: string;
  last_ingest: Record<string, number> | null;
  problems: string[];
  listener_running?: boolean;
  mode?: string;
}): Line {
  if (c.mode === "off") return { level: "warn", what: `  ${c.channel}: off in Switchboard settings` };
  if (!c.enabled)
    return { level: "warn", what: `  ${c.channel}: not on this Mac`, fix: c.problems.join(" | ") || undefined };
  const counts = c.last_ingest
    ? Object.entries(c.last_ingest)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "no ingest yet";
  const level: Level = c.problems.length ? "fail" : c.connected ? "ok" : "warn";
  const state = c.mode ? `on (${c.mode})` : "on";
  return {
    level,
    what: `  ${c.channel}: ${state}, auth=${c.auth}, last ingest: ${counts}${c.listener_running ? ", listener running" : ""}`,
    fix: c.problems.join(" | ") || undefined,
  };
}

/**
 * What to add under Full Disk Access. Switchboard.app runs the daemon as its child, so the app bundle holds the
 * grant; only the older terminal install's LaunchAgent needs the binary itself.
 */
export function fdaTarget(execPath: string, appRunsDaemon: boolean): string {
  const bundle = /^(.*?\.app)\/Contents\//.exec(execPath)?.[1];
  if (bundle) return bundle;
  if (appRunsDaemon) return "Switchboard.app";
  return "~/Applications/Switchboard/switchboard";
}

/** Claude Code's MCP entry. Never throws: a missing or broken `claude` is a skipped check. */
export function claudeCodeLine(cli: string | null, run: (cmd: string[]) => number): Line {
  if (!cli) return { level: "warn", what: "Claude Code CLI not found; skipped its MCP check" };
  let code: number;
  try {
    code = run([cli, "mcp", "get", "switchboard"]);
  } catch {
    return { level: "warn", what: `Claude Code CLI (${cli}) couldn't be started; skipped its MCP check` };
  }
  return code === 0
    ? { level: "ok", what: "Claude Code MCP entry registered" }
    : {
        level: "warn",
        what: "Claude Code MCP entry not registered",
        fix: "Open Switchboard.app (it registers itself), or run `switchboard install` for the terminal build.",
      };
}

/**
 * Folders in allman's git object store that can't be opened (no owner execute bit). Any one of them makes
 * every allman commit fail with "insufficient permission for adding an object", so syncs and sends can't
 * persist. Seen live 2026-11-09: all 256 fan-out folders were mode 0600; cause unknown.
 */
export function unopenableGitDirs(store: string): string[] {
  const objects = join(store, ".git/objects");
  if (!existsSync(objects)) return [];
  return readdirSync(objects)
    .map((d) => join(objects, d))
    .filter((d) => {
      const st = statSync(d);
      return st.isDirectory() && (st.mode & 0o100) === 0;
    });
}

export async function runDoctor(): Promise<number> {
  const p = paths();
  let failures = 0;
  const say = (level: Level, what: string, fix?: string) => {
    if (level === "fail") failures++;
    console.log(`${mark[level]} ${what}${fix ? `\n    → ${fix}` : ""}`);
  };

  // Daemon
  const uid = process.getuid?.() ?? 0;
  // Run by Switchboard.app as its child process, or by the older terminal install's LaunchAgent.
  const byApp = tryRun(["pgrep", "-f", "Switchboard.app/Contents/Helpers/switchboard daemon"]);
  const appPid = byApp?.exitCode === 0 ? byApp.stdout.trim().split("\n")[0] : null;
  const agent = tryRun(["launchctl", "print", `gui/${uid}/${LABEL}`]);
  if (appPid) {
    say("ok", `Background service run by Switchboard.app (pid ${appPid})`);
  } else if (agent?.exitCode === 0) {
    const pid = /pid = (\d+)/.exec(agent.stdout)?.[1];
    say(
      pid ? "ok" : "fail",
      `LaunchAgent ${LABEL} loaded${pid ? ` (pid ${pid})` : ", but not running"}`,
      pid ? undefined : `Check ${p.daemonLog}`,
    );
  } else {
    say(
      "fail",
      "Background service not running",
      existsSync(plistPath())
        ? `launchctl bootstrap gui/${uid} ${plistPath()}`
        : "Open Switchboard.app (it runs the service).",
    );
  }
  say(
    existsSync(p.socket) ? "ok" : "fail",
    `Socket ${p.socket}`,
    existsSync(p.socket) ? undefined : "The daemon isn't listening; see the LaunchAgent line above.",
  );

  // Daemon's own view (its FDA is what matters, not this terminal's).
  const statusFile = `${p.appSupport}/status.json`;
  if (existsSync(statusFile)) {
    const s = JSON.parse(readFileSync(statusFile, "utf8")) as {
      at: string;
      channels: Array<{
        channel: string;
        enabled: boolean;
        connected: boolean;
        auth: string;
        last_ingest: Record<string, number> | null;
        problems: string[];
        listener_running?: boolean;
        mode?: string;
      }>;
    };
    console.log(`  daemon status as of ${s.at}:`);
    for (const c of s.channels) {
      const l = channelLine(c);
      say(l.level, l.what, l.fix);
    }
  } else {
    say("warn", "No daemon status yet", "Start the daemon, or wait a few seconds after it starts.");
  }

  // Full Disk Access as seen by THIS process (useful when running the installed binary directly).
  const canRead = (f: string) => {
    try {
      const fd = openSync(f, "r");
      readSync(fd, Buffer.alloc(16), 0, 16, 0);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(p.chatDb)) {
    say(
      canRead(p.chatDb) ? "ok" : "warn",
      // Doctor inherits the terminal's access, not the daemon's: the imessage/contacts lines above are the daemon's.
      `This doctor run can ${canRead(p.chatDb) ? "" : "NOT "}read chat.db (the terminal's access; the daemon's is the imessage line above)`,
      canRead(p.chatDb)
        ? undefined
        : `Only the daemon needs access: System Settings → Privacy & Security → Full Disk Access → add ${fdaTarget(process.execPath, appPid !== null)}.`,
    );
  }
  const wa = whatsappFiles(p.whatsappDir).chatStorage;
  say(
    existsSync(wa) ? "ok" : "warn",
    `WhatsApp desktop data ${existsSync(wa) ? "found" : "not found (channel disabled)"}`,
  );

  // allman
  const bin = findAllman(p);
  if (!bin) {
    say("fail", "Pinned allman binary not found", "Run scripts/fetch-allman.sh, then reinstall.");
  } else {
    const sha = createHash("sha256").update(readFileSync(bin)).digest("hex");
    const trust = allmanTrusted(bin, sha);
    say(
      trust ? "ok" : "fail",
      `allman ${ALLMAN_VERSION} at ${bin} (sha256 ${trust === "pin" ? "matches pin" : trust === "app" ? "matches the app's sealed copy" : "MISMATCH"})`,
      trust ? undefined : "Re-run scripts/fetch-allman.sh or reinstall Switchboard.app; never auto-upgrade allman.",
    );
  }
  const acct = accountDir(p.allmanStore, null);
  if (!acct) {
    say(
      "fail",
      `No LinkedIn account in ${p.allmanStore}`,
      "Sign in from Switchboard.app (Channels → LinkedIn), or run: switchboard linkedin-login",
    );
  } else {
    const a = readAuth(acct);
    say(
      a.status === "authenticated" ? "ok" : "fail",
      `LinkedIn auth: ${a.status}${a.lastSyncAt ? `, last allman sync ${a.lastSyncAt}` : ""}`,
      a.status === "authenticated"
        ? undefined
        : "Sign in from Switchboard.app (Channels → LinkedIn), or run: switchboard linkedin-login",
    );
  }

  const badGit = unopenableGitDirs(p.allmanStore);
  if (badGit.length)
    say(
      "fail",
      `allman store: ${badGit.length} git object folder(s) can't be opened, so allman can't save syncs or sends`,
      `find "${join(p.allmanStore, ".git/objects")}" -mindepth 1 -maxdepth 1 -type d ! -perm -u+x -exec chmod 755 {} +`,
    );

  // Index permissions
  if (existsSync(p.indexDb)) {
    const mode = statSync(p.indexDb).mode & 0o777;
    say(
      mode === 0o600 ? "ok" : "fail",
      `index.db mode ${mode.toString(8)}`,
      mode === 0o600 ? undefined : `chmod 600 "${p.indexDb}"`,
    );
  }

  // Sending (M3)
  if (existsSync(p.outboxDb)) {
    const mode = statSync(p.outboxDb).mode & 0o777;
    say(
      mode === 0o600 ? "ok" : "fail",
      `outbox.db mode ${mode.toString(8)}`,
      mode === 0o600 ? undefined : `chmod 600 "${p.outboxDb}"`,
    );
  }
  if (existsSync(statusFile)) {
    const port = (JSON.parse(readFileSync(statusFile, "utf8")) as { approval_port?: number | null }).approval_port;
    say(
      port ? "ok" : "warn",
      port ? `Approval page listening on 127.0.0.1:${port}` : "Approval page not running",
      port ? undefined : "Restart the daemon (switchboard install).",
    );
  }
  say(
    existsSync("/Applications/WhatsApp.app") ? "ok" : "warn",
    `WhatsApp desktop app ${existsSync("/Applications/WhatsApp.app") ? "installed (prefill handoff available)" : "not in /Applications (WhatsApp handoff unavailable)"}`,
  );
  console.log(
    "  iMessage send needs macOS Automation permission for switchboard → Messages; macOS asks on the first send.\n" +
      "  Known gap: approval via the harness form or the local page isn't proven to be a human (docs/DESIGN.md).",
  );

  // Claude Code registration. Its CLI is often off PATH (launchd's minimal PATH, or not installed at all).
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).exitCode;
  const cl = claudeCodeLine(findClaudeCli(homedir(), "/", run), run);
  say(cl.level, cl.what, cl.fix);

  console.log(failures ? `\n${failures} problem(s).` : "\nAll checks passed.");
  return failures ? 1 : 0;
}
