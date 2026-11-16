/** M5 packaging: the release binary carries the pinned allman and refuses one that doesn't match the pin. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEmbeddedAllman } from "../src/cli/install.ts";

const named = (bytes: Uint8Array, name: string) => Object.assign(new Blob([bytes]), { name });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("embedded allman", () => {
  const bytes = new TextEncoder().encode("#!/bin/sh\necho fake allman\n");

  test("extracted beside switchboard, executable, when it matches the pin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-embed-"));
    const out = await extractEmbeddedAllman(
      dir,
      [named(new Uint8Array([1]), "other-x.txt"), named(bytes, "allman-ab12cd.")],
      sha(bytes),
    );
    expect(out).toBe(join(dir, "allman"));
    expect(readFileSync(join(dir, "allman"))).toEqual(Buffer.from(bytes));
    expect(statSync(join(dir, "allman")).mode & 0o777).toBe(0o755);
  });

  test("a binary that doesn't match the pin is refused and nothing is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-embed-"));
    await expect(extractEmbeddedAllman(dir, [named(bytes, "allman-ab12cd.")], "0".repeat(64))).rejects.toThrow(
      /sha256/,
    );
    expect(existsSync(join(dir, "allman"))).toBe(false);
  });

  test("none embedded (a dev build): returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-embed-"));
    expect(await extractEmbeddedAllman(dir, [], sha(bytes))).toBeNull();
  });
});

describe("version", () => {
  test("switchboard --version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--version"]);
    expect(r.stdout.toString().trim()).toBe(pkg.version);
  });
});

describe("allman trust inside the app", () => {
  test("the raw release matches the pin; a re-signed copy only via the app's sealed hash", async () => {
    const { allmanTrusted, ALLMAN_SHA256_DARWIN_ARM64 } = await import("../src/adapters/linkedin/allman.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const app = mkdtempSync(join(tmpdir(), "sb-appbundle-"));
    mkdirSync(join(app, "Contents/Helpers"), { recursive: true });
    mkdirSync(join(app, "Contents/Resources"), { recursive: true });
    const bin = join(app, "Contents/Helpers/allman");
    expect(allmanTrusted(bin, ALLMAN_SHA256_DARWIN_ARM64)).toBe("pin");
    expect(allmanTrusted(bin, "f".repeat(64))).toBeNull();
    writeFileSync(join(app, "Contents/Resources/allman.sha256"), `${"f".repeat(64)}\n`);
    expect(allmanTrusted(bin, "f".repeat(64))).toBe("app");
    expect(allmanTrusted(bin, "e".repeat(64))).toBeNull();
  });
});
