/**
 * `switchboard install`: copy the signed binary and pinned allman into ~/Applications/Switchboard,
 * load the LaunchAgent, point the user at the Full Disk Access pane, register Claude Code, and print
 * first-ingest counts (never message text). Installing authorizes no outbound message.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALLMAN_SHA256_DARWIN_ARM64, findAllman } from "../adapters/linkedin/allman.ts";
import { accountDir } from "../adapters/linkedin/store.ts";
import { FRESH_INSTALL_CONFIG, paths } from "../config.ts";

export const LABEL = "vc.aihouse.switchboard";
export const plistPath = () => join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);

export function plist(bin: string, logFile: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(bin)}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

/**
 * A release binary carries the pinned allman (scripts/build.sh --release embeds vendor/allman). Write it beside
 * switchboard if its sha256 matches the pin; refuse it otherwise. null when none is embedded (a dev build).
 */
export async function extractEmbeddedAllman(
  dir: string,
  files: readonly Blob[] = Bun.embeddedFiles,
  pin: string = ALLMAN_SHA256_DARWIN_ARM64,
): Promise<string | null> {
  const f = files.find((b) => /^allman-[^/]*$/.test((b as Blob & { name?: string }).name ?? ""));
  if (!f) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== pin) throw new Error(`embedded allman sha256 ${got} doesn't match the pin ${pin}; not installed`);
  const dest = join(dir, "allman");
  try {
    writeFileSync(`${dest}.new`, bytes, { mode: 0o755 });
    chmodSync(`${dest}.new`, 0o755);
    renameSync(`${dest}.new`, dest);
  } catch (e) {
    rmSync(`${dest}.new`, { force: true });
    throw e;
  }
  return dest;
}

function sh(cmd: string[], quiet = false): number {
  const r = Bun.spawnSync(cmd, { stdout: quiet ? "pipe" : "inherit", stderr: quiet ? "pipe" : "inherit" });
  return r.exitCode;
}

export async function runInstall(opts: {
  from: string;
  noClaude?: boolean;
  noOpenSettings?: boolean;
}): Promise<number> {
  const p = paths();
  mkdirSync(p.installDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.appSupport, { recursive: true, mode: 0o700 });
  mkdirSync(p.logsDir, { recursive: true, mode: 0o700 });

  // 1. Binaries
  const bin = join(p.installDir, "switchboard");
  // Copy to a temp file and rename: overwriting a signed binary in place keeps the old inode, whose
  // cached code signature no longer matches, so macOS denies Full Disk Access to the relaunched daemon.
  if (opts.from !== bin) {
    copyFileSync(opts.from, `${bin}.new`);
    chmodSync(`${bin}.new`, 0o755);
    renameSync(`${bin}.new`, bin);
  }
  const sig = Bun.spawnSync(["codesign", "-dvv", bin], { stderr: "pipe" }).stderr.toString();
  const authority = /Authority=(.*)/.exec(sig)?.[1];
  console.log(
    `• switchboard → ${bin} (${authority ? `signed by ${authority}` : "ad-hoc signed: FDA will reset on every rebuild"})`,
  );
  // A compiled binary can't see the repo's vendor/ via import.meta, so also look beside the source
  // binary (dist/switchboard → vendor/allman) and in the current directory.
  const embedded = await extractEmbeddedAllman(p.installDir);
  const allman =
    embedded ??
    findAllman(p) ??
    [join(dirname(opts.from), "../vendor/allman"), join(process.cwd(), "vendor/allman")].find((c) => existsSync(c)) ??
    null;
  if (allman && allman !== join(p.installDir, "allman")) {
    const dest = join(p.installDir, "allman");
    copyFileSync(allman, `${dest}.new`);
    chmodSync(`${dest}.new`, 0o755);
    renameSync(`${dest}.new`, dest);
  }
  console.log(
    allman
      ? `• allman → ${join(p.installDir, "allman")}`
      : "! pinned allman not found; run scripts/fetch-allman.sh and reinstall",
  );

  if (!existsSync(p.configFile)) {
    writeFileSync(p.configFile, `${JSON.stringify(FRESH_INSTALL_CONFIG, null, 2)}\n`, { mode: 0o600 });
    console.log(`• config → ${p.configFile}`);
  }

  // 2. LaunchAgent
  const uid = process.getuid?.() ?? 0;
  const plistFile = plistPath();
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(plistFile, plist(bin, p.daemonLog));
  sh(["launchctl", "bootout", `gui/${uid}/${LABEL}`], true);
  // bootout returns before the old job is gone; bootstrapping too early fails with EIO (5).
  for (let i = 0; i < 50 && sh(["launchctl", "print", `gui/${uid}/${LABEL}`], true) === 0; i++) await Bun.sleep(100);
  if (sh(["launchctl", "bootstrap", `gui/${uid}`, plistFile]) !== 0) {
    console.error("✗ launchctl bootstrap failed");
    return 1;
  }
  console.log(`• LaunchAgent ${LABEL} loaded`);

  // 3. Permissions: the user grants FDA to the binary (needs their hands, once per signing identity).
  if (!opts.noOpenSettings) {
    console.log(
      `\nGrant Full Disk Access to:\n    ${bin}\nOpening System Settings → Privacy & Security → Full Disk Access (use + and pick the file; ⌘⇧G to paste the path).`,
    );
    sh(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], true);
  }

  // 4. LinkedIn
  if (!accountDir(p.allmanStore, null)) {
    console.log(
      `\nLinkedIn isn't logged in. Run this (opens a browser; Switchboard never sees your credentials):\n    ${join(p.installDir, "allman")} login --store ${p.allmanStore}`,
    );
  }

  // 5. Claude Code / Desktop
  if (!opts.noClaude) {
    sh(["claude", "mcp", "remove", "--scope", "user", "switchboard"], true);
    const ok =
      sh(
        ["claude", "mcp", "add", "--scope", "user", "switchboard", "--", bin, "mcp", "--client", "claude-code"],
        true,
      ) === 0;
    console.log(ok ? "• Claude Code: registered (user scope)" : "! Claude Code CLI not found; skipped");
    console.log(
      `\nClaude Desktop: add this to ~/Library/Application Support/Claude/claude_desktop_config.json under "mcpServers":\n` +
        JSON.stringify({ switchboard: { command: bin, args: ["mcp", "--client", "claude-desktop"] } }, null, 2),
    );
    console.log(
      "\nOpenMausBot on this Mac: paste this into Plugins → MCP servers → Add server, then limit it to the bots\n" +
        "that need your messages under each bot's Tools → Access → MCP servers (by default every bot gets it).\n" +
        "OpenMausBot on your own server (a Cloud/home): run scripts/http-token.sh instead, which sets up a\n" +
        "token-guarded http://127.0.0.1 URL that doesn't need its 'run commands' grant:\n" +
        JSON.stringify(
          { mcpServers: { switchboard: { command: bin, args: ["mcp", "--client", "openmausbot"] } } },
          null,
          2,
        ),
    );
  }

  // 6. First ingest: counts only.
  const statusFile = join(p.appSupport, "status.json");
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (existsSync(statusFile)) break;
  }
  if (existsSync(statusFile)) {
    const s = JSON.parse(readFileSync(statusFile, "utf8")) as {
      channels: Array<{ channel: string; last_ingest: Record<string, number> | null; problems: string[] }>;
    };
    console.log("\nFirst ingest:");
    for (const c of s.channels)
      console.log(
        `  ${c.channel}: ${c.last_ingest ? JSON.stringify(c.last_ingest) : "—"}${c.problems.length ? `  (${c.problems.join("; ")})` : ""}`,
      );
  }
  console.log("\nRun `switchboard doctor` after granting Full Disk Access.");
  return 0;
}
