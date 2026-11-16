/** LinkedIn sign-in uses a browser that's on this Mac, since a fresh Mac has no Playwright Chromium. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedinLogin, loginBrowser, NO_BROWSER_EXIT } from "../src/cli/linkedin-login.ts";
import { paths } from "../src/config.ts";

const FAKE = join(import.meta.dir, "../scripts/fake-allman.sh");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const none = () => false;

describe("loginBrowser", () => {
  test("prefers Google Chrome when it's installed", () => {
    const has = new Set([CHROME, EDGE]);
    expect(loginBrowser({}, "/Users/x", (p) => has.has(p), none)).toEqual({ kind: "installed", path: CHROME });
  });

  test("falls back to another Chromium browser, including in ~/Applications", () => {
    expect(loginBrowser({}, "/Users/x", (p) => p === EDGE, none)).toEqual({ kind: "installed", path: EDGE });
    const userBrave = "/Users/x/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    expect(loginBrowser({}, "/Users/x", (p) => p === userBrave, none)).toEqual({ kind: "installed", path: userBrave });
  });

  test("an explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH wins", () => {
    const env = { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/chromium" };
    expect(loginBrowser(env, "/Users/x", () => true, none)).toEqual({ kind: "installed", path: "/opt/chromium" });
  });

  test("no browser: Playwright's own Chromium if cached, otherwise nothing", () => {
    expect(loginBrowser({}, "/Users/x", none, () => true)).toEqual({ kind: "playwright" });
    expect(loginBrowser({}, "/Users/x", none, none)).toBeNull();
  });
});

describe("linkedinLogin", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "sb-login-"));
    const log = join(root, "allman.log");
    const env = { SWITCHBOARD_HOME: root, SWITCHBOARD_ALLMAN: FAKE, FAKE_ALLMAN_LOG: log };
    return { p: paths(env), env: { ...process.env, ...env }, log };
  };

  test("runs allman login with the store and the chosen browser", async () => {
    const { p, env, log } = setup();
    const code = await linkedinLogin(p, { env, home: "/Users/x", browser: { kind: "installed", path: CHROME } });
    expect(code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe(`login --store ${p.allmanStore}`);
    expect(lines[1]).toBe(`browser=${CHROME}`);
  });

  test("passes allman's failure through", async () => {
    const { p, env } = setup();
    const code = await linkedinLogin(p, {
      env: { ...env, FAKE_ALLMAN_LOGIN_EXIT: "1" },
      browser: { kind: "installed", path: CHROME },
    });
    expect(code).toBe(1);
  });

  test("no browser at all: a clear exit code and allman is never started", async () => {
    const { p, env, log } = setup();
    expect(await linkedinLogin(p, { env, browser: null })).toBe(NO_BROWSER_EXIT);
    expect(() => readFileSync(log, "utf8")).toThrow();
  });
});
