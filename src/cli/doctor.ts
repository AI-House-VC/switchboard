/**
 * `switchboard doctor`: checks the install end to end and prints fixes. Prints counts and states only,
 * never message content.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALLMAN_VERSION, allmanTrusted, findAllman } from "../adapters/linkedin/allman.ts";
import { accountDir, readAuth } from "../adapters/linkedin/store.ts";
import { whatsappFiles } from "../adapters/whatsapp/reader.ts";
import { paths } from "../config.ts";
import { LABEL, plistPath } from "./install.ts";

type Level = "ok" | "warn" | "fail";
const mark: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

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
  const byApp = Bun.spawnSync(["pgrep", "-f", "Switchboard.app/Contents/Helpers/switchboard daemon"], {
    stdout: "pipe",
  });
  const appPid = byApp.exitCode === 0 ? byApp.stdout.toString().trim().split("\n")[0] : null;
  const agent = Bun.spawnSync(["launchctl", "print", `gui/${uid}/${LABEL}`], { stdout: "pipe", stderr: "pipe" });
  if (appPid) {
    say("ok", `Background service run by Switchboard.app (pid ${appPid})`);
  } else if (agent.exitCode === 0) {
    const pid = /pid = (\d+)/.exec(agent.stdout.toString())?.[1];
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
      }>;
    };
    console.log(`  daemon status as of ${s.at}:`);
    for (const c of s.channels) {
      const counts = c.last_ingest
        ? Object.entries(c.last_ingest)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "no ingest yet";
      const level: Level = !c.enabled ? "warn" : c.problems.length ? "fail" : c.connected ? "ok" : "warn";
      say(
        level,
        `  ${c.channel}: ${c.enabled ? "enabled" : "disabled"}, auth=${c.auth}, last ingest: ${counts}${c.listener_running ? ", listener running" : ""}`,
        c.problems.join(" | ") || undefined,
      );
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
        : "Only the daemon needs access: System Settings → Privacy & Security → Full Disk Access → add ~/Applications/Switchboard/switchboard.",
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

  // Claude Code registration
  const claude = Bun.spawnSync(["claude", "mcp", "get", "switchboard"], { stdout: "pipe", stderr: "pipe" });
  say(
    claude.exitCode === 0 ? "ok" : "warn",
    `Claude Code MCP entry ${claude.exitCode === 0 ? "registered" : "not registered"}`,
    claude.exitCode === 0
      ? undefined
      : "Run `switchboard install` (or claude mcp add --scope user switchboard -- ~/Applications/Switchboard/switchboard mcp --client claude-code).",
  );

  console.log(failures ? `\n${failures} problem(s).` : "\nAll checks passed.");
  return failures ? 1 : 0;
}
