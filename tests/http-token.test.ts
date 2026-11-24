/**
 * scripts/http-token.sh against fakes: op, tailscale, pgrep, launchctl and the clipboard are stand-ins, and a tiny
 * server plays the daemon (it accepts only tokens whose sha256 is in config.json, as the real one does after a
 * restart). Never touches 1Password, Tailscale or a real Switchboard.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/http-token.sh");

interface World {
  home: string;
  bin: string;
  config: string;
  clip: string;
  opLog: string;
}

function world(opts: { vaults?: string[]; opSignedIn?: boolean; opAccounts?: boolean; tailnet?: string | null }) {
  const root = mkdtempSync(join(tmpdir(), "sb-httptoken-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dir = join(home, "Library/Application Support/Switchboard");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ http: { port: null, tokens: [], public_hosts: [] }, clients: {} }));
  const w: World = { home, bin, config, clip: join(root, "clip"), opLog: join(root, "op.log") };
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const vaults = JSON.stringify((opts.vaults ?? ["Personal"]).map((name) => ({ name })));
  fake(
    "op",
    `echo "$*" >> "${w.opLog}"
case "$1 $2" in
  "whoami "*) exit ${opts.opSignedIn === false ? 1 : 0} ;;
  "account list") ${opts.opAccounts === false ? "exit 0" : 'echo "URL EMAIL"; echo "example.1password.com user@example.com"'} ;;
  "signin "*) exit 0 ;;
  "vault list") echo '${vaults}' ;;
  "item get") exit 1 ;;
  "item create") t=""; while [[ $# -gt 0 ]]; do [[ "$1" == --template ]] && t="$2"; shift; done; [[ -s "$t" ]] ;;
  *) exit 0 ;;
esac`,
  );
  fake(
    "tailscale",
    opts.tailnet === null ? "exit 1" : `echo '{"Self":{"DNSName":"${opts.tailnet ?? "mac.tail0000.ts.net."}"}}'`,
  );
  fake("pgrep", "exit 1"); // no Switchboard.app daemon
  fake("launchctl", `exit "\${FAKE_LAUNCHCTL_EXIT:-0}"`);
  fake("pbcopy", `cat > "${w.clip}"`);
  fake("pbpaste", `cat "${w.clip}" 2>/dev/null`);
  return w;
}

/** Plays the daemon: 200 to a bearer whose sha256 is in config.json, 401 otherwise. */
function fakeDaemon(config: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const tok = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const sha = createHash("sha256").update(tok).digest("hex");
      const c = JSON.parse(readFileSync(config, "utf8"));
      return new Response("{}", {
        status: c.http.tokens.some((t: { sha256: string }) => t.sha256 === sha) ? 200 : 401,
      });
    },
  });
}

async function run(w: World, port: number, env: Record<string, string> = {}, stdin = "\n") {
  const p = Bun.spawn(["bash", SCRIPT, "openmausbot", String(port)], {
    env: {
      HOME: w.home,
      PATH: `${w.bin}:/usr/bin:/bin`,
      SWITCHBOARD_CLIP_SECONDS: "0",
      SWITCHBOARD_RESTART_WAIT: "3",
      ...env,
    },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
};

describe("http-token.sh", () => {
  test("restarts, proves the endpoint takes the new token, fills public_hosts and prints both URLs", async () => {
    const w = world({});
    const daemon = fakeDaemon(w.config);
    try {
      const r = await run(w, daemon.port as number);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Switchboard restarted and serves");
      const c = JSON.parse(readFileSync(w.config, "utf8"));
      expect(c.http.port).toBe(daemon.port);
      expect(c.http.public_hosts).toEqual(["mac.tail0000.ts.net"]);
      expect(c.clients.openmausbot.send_policy).toBe("confirm");
      // The clipboard holds the header value; config holds only its hash; op never saw the token in argv.
      const clip = readFileSync(w.clip, "utf8");
      expect(clip).toMatch(/^Bearer sbt_[0-9a-f]{64}$/);
      const tok = clip.slice("Bearer ".length);
      expect(c.http.tokens).toEqual([
        { client: "openmausbot", sha256: createHash("sha256").update(tok).digest("hex") },
      ]);
      expect(readFileSync(w.opLog, "utf8")).not.toContain("sbt_");
      expect(r.out + r.err).not.toContain(tok);
      // Default vault on an individual account.
      expect(r.out).toContain("Personal / Switchboard token (openmausbot)");
      // Both remote setups, labelled.
      expect(r.out).toContain("With the relay");
      expect(r.out).toContain("http://127.0.0.1:47822/mcp");
      expect(r.out).toContain("Without the relay");
      expect(r.out).toContain("https://mac.tail0000.ts.net/mcp");
      // Re-running keeps one public host and one token for the client.
      const again = await run(w, daemon.port as number);
      expect(again.code).toBe(0);
      const c2 = JSON.parse(readFileSync(w.config, "utf8"));
      expect(c2.http.public_hosts).toEqual(["mac.tail0000.ts.net"]);
      expect(c2.http.tokens).toHaveLength(1);
    } finally {
      daemon.stop(true);
    }
  });

  test("never claims a restart when nothing restarted the daemon", async () => {
    const w = world({});
    const r = await run(w, freePort(), { FAKE_LAUNCHCTL_EXIT: "113" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("restarted");
    expect(r.out).toContain("Quit Switchboard");
  });

  test("a restart that doesn't bring the endpoint up isn't reported as done", async () => {
    const w = world({});
    const r = await run(w, freePort());
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("restarted");
    expect(r.out).toContain("isn't serving the new token");
  });

  test("prefers Private when present; refuses a vault that doesn't exist before touching config", async () => {
    const w = world({ vaults: ["Shared", "Private"] });
    const daemon = fakeDaemon(w.config);
    try {
      expect((await run(w, daemon.port as number)).out).toContain("Private / Switchboard token");
    } finally {
      daemon.stop(true);
    }
    const w2 = world({ vaults: ["Personal"] });
    const before = readFileSync(w2.config, "utf8");
    const r = await run(w2, freePort(), {}, "Private\n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("isn't one of your vaults");
    expect(readFileSync(w2.config, "utf8")).toBe(before);
  });

  test("points at 1Password's CLI integration setting when op knows no account", async () => {
    const w = world({ opSignedIn: false, opAccounts: false });
    const before = readFileSync(w.config, "utf8");
    const r = await run(w, freePort());
    expect(r.code).toBe(1);
    expect(r.err).toContain("Integrate with 1Password CLI");
    expect(readFileSync(w.config, "utf8")).toBe(before);
    expect(existsSync(w.clip)).toBe(false);
  });

  test("without a tailnet name it says how to add one", async () => {
    const w = world({ tailnet: null });
    const daemon = fakeDaemon(w.config);
    try {
      const r = await run(w, daemon.port as number);
      expect(r.code).toBe(0);
      expect(r.out).toContain("SWITCHBOARD_PUBLIC_HOST=");
      expect(JSON.parse(readFileSync(w.config, "utf8")).http.public_hosts).toEqual([]);
      const named = await run(w, daemon.port as number, { SWITCHBOARD_PUBLIC_HOST: "mac.tail0000.ts.net" });
      expect(named.out).toContain("https://mac.tail0000.ts.net/mcp");
    } finally {
      daemon.stop(true);
    }
  });
});
