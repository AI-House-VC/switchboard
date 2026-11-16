/**
 * `switchboard linkedin-login`: runs `allman login` with a browser that's actually on this Mac.
 *
 * allman signs in through Playwright, which by default launches its own Chromium from
 * ~/Library/Caches/ms-playwright. A fresh Mac doesn't have that, so `allman login` exits at once with
 * "Executable doesn't exist" (seen 2026-11-16 on a second user's Mac). allman honours
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, so we point it at an installed Chromium-based browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findAllman } from "../adapters/linkedin/allman.ts";
import type { Paths } from "../config.ts";

/** Chromium-based browsers Playwright can drive, in order of preference (relative to /Applications). */
export const BROWSERS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Exit code when there's no browser to sign in with; Switchboard.app shows its own message for it. */
export const NO_BROWSER_EXIT = 3;
/** Exit code after the sign-in was cancelled (SIGTERM's number). */
export const CANCELLED_EXIT = 15;

export type LoginBrowser = { kind: "installed"; path: string } | { kind: "playwright" } | null;

export function loginBrowser(
  env: Record<string, string | undefined>,
  home: string,
  exists: (p: string) => boolean = existsSync,
  playwrightChromium: () => boolean = () => hasPlaywrightChromium(home),
): LoginBrowser {
  const forced = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (forced && exists(forced)) return { kind: "installed", path: forced };
  for (const root of ["/Applications", join(home, "Applications")])
    for (const b of BROWSERS) {
      const path = join(root, b);
      if (exists(path)) return { kind: "installed", path };
    }
  return playwrightChromium() ? { kind: "playwright" } : null;
}

function hasPlaywrightChromium(home: string): boolean {
  const cache = join(home, "Library/Caches/ms-playwright");
  try {
    return readdirSync(cache).some((d) => /^chromium-\d+$/.test(d));
  } catch {
    return false;
  }
}

export async function linkedinLogin(
  p: Paths,
  o: { env?: Record<string, string | undefined>; home?: string; browser?: LoginBrowser } = {},
): Promise<number> {
  const env = o.env ?? process.env;
  const home = o.home ?? env.HOME ?? "";
  const allman = findAllman(p);
  if (!allman) {
    console.error("The LinkedIn helper (allman) is missing. Reinstall Switchboard.");
    return 1;
  }
  const browser = o.browser === undefined ? loginBrowser(env, home) : o.browser;
  if (!browser) {
    console.error(
      "Signing in to LinkedIn needs Google Chrome (or Microsoft Edge, Brave or Chromium). " +
        "Install one, then try again. Switchboard only uses it for this sign-in window.",
    );
    return NO_BROWSER_EXIT;
  }
  const childEnv = { ...env };
  if (browser.kind === "installed") childEnv.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = browser.path;
  const child = Bun.spawn([allman, "login", "--store", p.allmanStore], {
    env: childEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Cancelling sign-in in the app terminates us; take allman (and its browser) down too.
  // Exit 15 then, the status Switchboard.app already treats as "cancelled" (SIGTERM), not as a failure.
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const code = await child.exited;
    return cancelled ? CANCELLED_EXIT : code;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
