/**
 * `switchboard relay --upstream <url> [--port 47822] [--state-dir DIR]`. Also built on its own as
 * dist/switchboard-relay.mjs (scripts/build-relay.sh), which runs on plain Node: `node switchboard-relay.mjs ...`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./relay.ts";

export const RELAY_USAGE = `switchboard relay --upstream <url> [--port 47822] [--state-dir DIR]

  An always-on stand-in for Switchboard on a bot host, for when Switchboard runs on a laptop that sleeps.
  Point the bot host's "switchboard" MCP server at http://127.0.0.1:<port>/mcp, keeping its Authorization
  header. When the Mac answers, calls go through; when it doesn't, tools say "Switchboard is offline".
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runRelay(args: string[]): Promise<number> {
  const upstream = flag(args, "--upstream");
  if (!upstream || args.includes("--help")) {
    console.log(RELAY_USAGE);
    return upstream ? 0 : 2;
  }
  const port = Number(flag(args, "--port") ?? 47822);
  const stateDir =
    flag(args, "--state-dir") ??
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "switchboard-relay");
  try {
    new URL(upstream);
  } catch {
    console.error(`relay: --upstream must be a full address, like https://mac.example.ts.net/mcp`);
    return 2;
  }
  const relay = await startRelay({
    upstream,
    port,
    stateDir,
    log: (e) => console.error(JSON.stringify({ at: new Date().toISOString(), ...e })),
  });
  const stop = () => void relay.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return -1;
}

// Run directly (the standalone Node build).
if (import.meta.main ?? process.argv[1]?.endsWith("switchboard-relay.mjs")) {
  const code = await runRelay(process.argv.slice(2));
  if (code >= 0) process.exit(code);
}
