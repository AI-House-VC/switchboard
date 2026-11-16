/**
 * Wrapper around the pinned allman binary. All LinkedIn network I/O goes through allman; arguments
 * are always passed as an argv array (never through a shell), with an absolute --store and, when
 * configured, --account.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ALLMAN_VERSION = "0.7.1";
/** sha256 of the v0.7.1 darwin-arm64 release asset, pinned in-repo (scripts/fetch-allman.sh verifies it). */
export const ALLMAN_SHA256_DARWIN_ARM64 = "381e05ce49a5ff1ca261923b2ac8bdb91c87348a947c12859a453411e4a06a1b";

export interface AllmanOpts {
  bin: string;
  store: string;
  account: string | null;
}

/**
 * Locate the pinned allman: an explicit path (SWITCHBOARD_ALLMAN), else beside this binary (Switchboard.app's
 * Contents/Helpers), else next to the CLI install, else vendor/.
 */
export function findAllman(p: { installDir: string; allmanBin: string | null }): string | null {
  if (p.allmanBin) return existsSync(p.allmanBin) ? p.allmanBin : null;
  for (const c of [
    join(dirname(process.execPath), "allman"),
    join(p.installDir, "allman"),
    join(import.meta.dir, "../../../vendor/allman"),
  ])
    if (existsSync(c)) return c;
  return null;
}

/**
 * Is this allman the pinned one? The raw release matches the pin. Inside Switchboard.app allman is re-signed with our
 * Developer ID (notarization requires it), which changes its bytes; the build checks the pin first and records the
 * signed copy's sha256 in Contents/Resources/allman.sha256, which the app's own signature seals.
 */
export function allmanTrusted(bin: string, sha: string): "pin" | "app" | null {
  if (sha === ALLMAN_SHA256_DARWIN_ARM64) return "pin";
  const sealed = join(dirname(bin), "../Resources/allman.sha256");
  try {
    if (existsSync(sealed) && readFileSync(sealed, "utf8").trim() === sha) return "app";
  } catch {}
  return null;
}

export function argv(o: AllmanOpts, ...args: string[]): string[] {
  const out = [o.bin, ...args, "--store", o.store];
  if (o.account) out.push("--account", o.account);
  return out;
}

export async function runAllman(
  o: AllmanOpts,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv(o, ...args), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export async function allmanVersion(bin: string): Promise<string | null> {
  const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/**
 * Supervises `allman listen` (which itself appends incoming messages to the store, which we watch).
 * Restarts with exponential backoff. Event lines on stdout are only used as a nudge to re-ingest;
 * their content is not parsed into the index directly (the store is the source of truth).
 */
export class ListenSupervisor {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  private backoffMs = 2_000;
  lastEventAt: number | null = null;
  connected = false;

  constructor(
    private o: AllmanOpts,
    private onEvent: () => void,
    private log: (msg: string) => void,
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (this.stopped || this.proc) return;
    const proc = Bun.spawn(argv(this.o, "listen"), {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    });
    this.proc = proc;
    this.log(`allman listen started (pid ${proc.pid})`);
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          let ev: { event?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          this.lastEventAt = Date.now();
          if (ev.event === "connected") {
            this.connected = true;
            this.backoffMs = 2_000;
          }
          if (ev.event?.startsWith("message.") || ev.event === "read_receipt" || ev.event === "reaction")
            this.onEvent();
        }
      }
    })().catch(() => {});
    proc.exited.then((code) => {
      this.proc = null;
      this.connected = false;
      if (this.stopped) return;
      this.log(`allman listen exited (${code}); restarting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }
}

interface Listener {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Keeps one listener on the store: ours, unless another is already running (allman-mac's, or the
 * previous daemon's child left behind when launchd killed it), in which case we defer and re-check;
 * when that one exits we start ours. Checked once at startup only, LinkedIn went silent (2026-11-09).
 */
export class ListenerKeeper {
  private own: Listener | null = null;
  private deferring = false;

  constructor(
    private otherRunning: () => boolean,
    private make: () => Listener,
    private log: (msg: string) => void,
  ) {}

  get running(): boolean {
    return this.own?.running ?? false;
  }

  check(): void {
    if (this.own) return; // ours restarts itself (ListenSupervisor backoff)
    if (this.otherRunning()) {
      if (!this.deferring) this.log("another allman listen is running for this store; watching the store only");
      this.deferring = true;
      return;
    }
    if (this.deferring) this.log("the other allman listen has exited; starting ours");
    this.deferring = false;
    this.own = this.make();
    this.own.start();
  }

  stop(): void {
    this.own?.stop();
  }
}

/**
 * Is another `allman listen` already running for this store (e.g. allman-mac's)? A listener started
 * without --store may be using this store too, so it counts; one on a different --store doesn't.
 */
const LISTEN_CMD = /^(?:\S*\/(?:ba|z)?sh\s+)?\S*allman\S*\s+listen\b/;

export function otherListenerRunning(store: string, ownPid?: number): boolean {
  const p = Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="], { stdout: "pipe" });
  return p.stdout
    .toString()
    .split("\n")
    .some((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) return false;
      const pid = Number(m[1]);
      const cmd = m[2] ?? "";
      // The program itself must be allman (optionally run by a shell), not any command line that merely
      // mentions "allman listen" (a grep for it made the daemon defer to nothing, 2026-11-09).
      if (pid === process.pid || pid === ownPid || !LISTEN_CMD.test(cmd)) return false;
      return !cmd.includes("--store") || cmd.includes(`--store ${store}`);
    });
}
