/** `switchboard doctor` pieces that decide what it prints. Synthetic states only. */
import { describe, expect, test } from "bun:test";
import { channelLine, claudeCodeLine, fdaTarget } from "../src/cli/doctor.ts";

const base = {
  channel: "imessage",
  enabled: true,
  connected: false,
  auth: "local",
  last_ingest: null,
  problems: [] as string[],
};

describe("channel lines follow the channel's mode, not just whether its data exists", () => {
  test("a channel switched off says off, not 'enabled' with a contradicting hint", () => {
    const l = channelLine({ ...base, mode: "off", problems: ["Switched off in Switchboard settings."] });
    expect(l.level).toBe("warn");
    expect(l.what).toContain("off in Switchboard settings");
    expect(l.what).not.toContain("enabled");
    expect(l.fix).toBeUndefined();
  });

  test("an on channel with a problem fails and shows the problem", () => {
    const l = channelLine({ ...base, mode: "read", problems: ["chat.db not readable"] });
    expect(l.level).toBe("fail");
    expect(l.what).toContain("on (read)");
    expect(l.fix).toBe("chat.db not readable");
  });

  test("an on channel that ingested is ok and shows counts", () => {
    const l = channelLine({ ...base, mode: "read_write", connected: true, last_ingest: { messages: 3 } });
    expect(l.level).toBe("ok");
    expect(l.what).toContain("messages=3");
  });

  test("a channel whose data isn't on this Mac says so", () => {
    const l = channelLine({ ...base, channel: "whatsapp", enabled: false, mode: "read" });
    expect(l.level).toBe("warn");
    expect(l.what).toContain("not on this Mac");
  });

  test("contacts (no mode) still reports", () => {
    const l = channelLine({ ...base, channel: "contacts", connected: true, last_ingest: { contacts: 2 } });
    expect(l.level).toBe("ok");
  });
});

describe("Full Disk Access tip names what actually holds the grant", () => {
  test("the app's helper points at the app bundle", () => {
    expect(fdaTarget("/Applications/Switchboard.app/Contents/Helpers/switchboard", false)).toBe(
      "/Applications/Switchboard.app",
    );
  });
  test("a CLI run while the app runs the daemon points at the app", () => {
    expect(fdaTarget("/Users/x/Applications/Switchboard/switchboard", true)).toBe("Switchboard.app");
  });
  test("the CLI build alone points at its installed binary", () => {
    expect(fdaTarget("/Users/x/Applications/Switchboard/switchboard", false)).toBe(
      "~/Applications/Switchboard/switchboard",
    );
  });
});

describe("Claude Code check", () => {
  test("no claude CLI is a skipped warning, not a crash", () => {
    const l = claudeCodeLine(null, () => {
      throw new Error("must not run");
    });
    expect(l.level).toBe("warn");
    expect(l.what).toContain("not found");
  });
  test("a claude that can't be started is a warning, not a crash", () => {
    const l = claudeCodeLine("/nowhere/claude", () => {
      throw new Error("ENOENT");
    });
    expect(l.level).toBe("warn");
  });
  test("registered and not registered", () => {
    expect(claudeCodeLine("claude", () => 0).level).toBe("ok");
    const no = claudeCodeLine("claude", () => 1);
    expect(no.level).toBe("warn");
    expect(no.what).toContain("not registered");
  });
});
