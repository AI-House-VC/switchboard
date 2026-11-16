/** The commands Switchboard.app runs: set-channel and app-setup. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSetup, setChannel } from "../src/cli/app.ts";
import { paths } from "../src/config.ts";

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "sb-app-"));
  return { root, p: paths({ SWITCHBOARD_HOME: root }) };
};
const cfg = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("set-channel", () => {
  test("sets one channel, keeps the rest of the config, 0600", () => {
    const { p } = fresh();
    mkdirSync(p.appSupport, { recursive: true });
    writeFileSync(p.configFile, JSON.stringify({ profile: "strict", http: { port: 47821 } }));
    expect(setChannel(p, "whatsapp", "read")).toEqual({
      linkedin: "read_write",
      imessage: "read_write",
      whatsapp: "read",
    });
    const c = cfg(p.configFile);
    expect(c.http).toEqual({ port: 47821 });
    expect(c.channels.whatsapp).toBe("read");
    expect(statSync(p.configFile).mode & 0o777).toBe(0o600);
  });

  test("with no config yet: starts from the fresh (all off) config", () => {
    const { p } = fresh();
    expect(setChannel(p, "imessage", "read_write")).toEqual({
      linkedin: "off",
      imessage: "read_write",
      whatsapp: "off",
    });
  });

  test("rejects unknown channels and modes", () => {
    const { p } = fresh();
    expect(() => setChannel(p, "sms", "read")).toThrow(/channel/);
    expect(() => setChannel(p, "imessage", "write")).toThrow(/mode/);
  });
});

describe("app-setup", () => {
  test("first run: fresh all-off config, old CLI agent retired, Claude Code pointed at the app", () => {
    const { root, p } = fresh();
    const home = join(root, "home");
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    const old = join(home, "Library/LaunchAgents/vc.aihouse.switchboard.plist");
    writeFileSync(old, "<plist/>");
    const ran: string[] = [];
    const r = appSetup(p, {
      home,
      root: home,
      bin: "/Applications/Switchboard.app/Contents/Helpers/switchboard",
      run: (cmd) => {
        ran.push(cmd.join(" "));
        return 0;
      },
    });
    expect(r).toMatchObject({ config_created: true, old_agent_removed: true, claude_code: "registered" });
    expect(cfg(p.configFile).channels).toEqual({ linkedin: "off", imessage: "off", whatsapp: "off" });
    expect(existsSync(old)).toBe(false);
    expect(ran.some((c) => c.startsWith("launchctl bootout") && c.endsWith("/vc.aihouse.switchboard"))).toBe(true);
    expect(ran).toContain(
      "claude mcp add --scope user switchboard -- /Applications/Switchboard.app/Contents/Helpers/switchboard mcp --client claude-code",
    );
  });

  test("later runs keep the user's config and do nothing to agents that aren't there", () => {
    const { root, p } = fresh();
    mkdirSync(p.appSupport, { recursive: true });
    writeFileSync(p.configFile, JSON.stringify({ channels: { linkedin: "read", imessage: "off", whatsapp: "off" } }));
    const r = appSetup(p, {
      home: join(root, "home"),
      root: join(root, "home"),
      bin: "/x/switchboard",
      run: (cmd) => (cmd[1] === "which" ? 1 : 0),
    });
    expect(r).toMatchObject({ config_created: false, old_agent_removed: false, claude_code: "not_installed" });
    expect(cfg(p.configFile).channels.linkedin).toBe("read");
  });
});

describe("app-setup: Claude Desktop (the Claude app)", () => {
  const BIN = "/Applications/Switchboard.app/Contents/Helpers/switchboard";
  const ENTRY = { command: BIN, args: ["mcp", "--client", "claude-desktop"] };
  const setup = (opts: { app?: boolean; config?: string } = {}) => {
    const { root, p } = fresh();
    const home = join(root, "home");
    const dir = join(home, "Library/Application Support/Claude");
    mkdirSync(dir, { recursive: true });
    if (opts.app !== false) mkdirSync(join(home, "Applications/Claude.app"), { recursive: true });
    const file = join(dir, "claude_desktop_config.json");
    if (opts.config !== undefined) writeFileSync(file, opts.config, { mode: 0o600 });
    const go = () => appSetup(p, { home, root: home, bin: BIN, run: (cmd) => (cmd[1] === "which" ? 1 : 0) });
    return { file, go };
  };

  test("adds Switchboard and keeps the app's own settings and other servers", () => {
    const { file, go } = setup({
      config: JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "/x" } } }),
    });
    expect(go().claude_desktop).toBe("updated");
    const c = cfg(file);
    expect(c.preferences).toEqual({ theme: "dark" });
    expect(c.mcpServers.other).toEqual({ command: "/x" });
    expect(c.mcpServers.switchboard).toEqual(ENTRY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.before-switchboard`)).toBe(true);
  });

  test("already there: nothing written, reported as registered", () => {
    const { file, go } = setup({ config: JSON.stringify({ mcpServers: { switchboard: ENTRY } }) });
    const before = readFileSync(file, "utf8");
    expect(go().claude_desktop).toBe("registered");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("no config file yet: creates one with just Switchboard", () => {
    const { file, go } = setup();
    expect(go().claude_desktop).toBe("updated");
    expect(cfg(file)).toEqual({ mcpServers: { switchboard: ENTRY } });
  });

  test("a config that isn't valid JSON is never overwritten", () => {
    const { file, go } = setup({ config: "{ not json" });
    expect(go().claude_desktop).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  test("no Claude app: nothing written", () => {
    const { file, go } = setup({ app: false });
    expect(go().claude_desktop).toBe("not_installed");
    expect(existsSync(file)).toBe(false);
  });
});

describe("app-setup: finding Claude Code outside the app's PATH", () => {
  test("uses ~/.local/bin/claude when which can't see it", () => {
    const { root, p } = fresh();
    const home = join(root, "home");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/claude"), "#!/bin/sh\n", { mode: 0o755 });
    const ran: string[][] = [];
    const r = appSetup(p, {
      home,
      root: home,
      bin: "/x/switchboard",
      run: (cmd) => {
        ran.push(cmd);
        return cmd[1] === "which" ? 1 : 0;
      },
    });
    expect(r.claude_code).toBe("registered");
    expect(ran.some((c) => c[0] === join(home, ".local/bin/claude") && c[2] === "add")).toBe(true);
  });
});
