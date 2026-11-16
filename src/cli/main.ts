#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { paths } from "../config.ts";
/** switchboard: daemon | mcp | doctor | install | ingest */
import { runDaemon } from "../daemon/daemon.ts";
import { runShim } from "../mcp/shim.ts";
import { appSetup, setChannel } from "./app.ts";
import { runDoctor } from "./doctor.ts";
import { runInstall } from "./install.ts";
import { linkedinLogin } from "./linkedin-login.ts";

const USAGE = `switchboard <command>

  daemon                     run switchboardd (normally started by the LaunchAgent)
  mcp --client <label>       stdio MCP shim for a harness (label must be on the config allowlist)
  doctor                     check permissions, allman, LinkedIn auth and the daemon
  install [--no-claude]      install binaries + LaunchAgent, register Claude Code
  set-channel <channel> <mode>  (Switchboard.app) linkedin|imessage|whatsapp  off|read|read_write
  linkedin-login             sign in to LinkedIn (allman login, using an installed browser)
  app-setup                  (Switchboard.app) config, retire the old CLI agent, register Claude Code
  --version                  print the version
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "daemon":
      await runDaemon();
      return -1; // keep running
    case "mcp":
      runShim(flag(rest, "--client") ?? "claude-code");
      return -1;
    case "doctor":
      return runDoctor();
    case "install":
      return runInstall({
        from: process.execPath,
        noClaude: rest.includes("--no-claude"),
        noOpenSettings: rest.includes("--no-open"),
      });
    case "set-channel":
      try {
        console.log(JSON.stringify(setChannel(paths(), rest[0] ?? "", rest[1] ?? "")));
        return 0;
      } catch (e) {
        console.error((e as Error).message);
        return 2;
      }
    case "linkedin-login":
      return linkedinLogin(paths());
    case "app-setup":
      console.log(JSON.stringify(appSetup(paths(), { bin: process.execPath })));
      return 0;
    case "--version":
    case "version":
      console.log(pkg.version);
      return 0;
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);
