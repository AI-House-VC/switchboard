/**
 * Helpers shared by the Apple/WhatsApp readers. Ported from an earlier Python reader's
 * extractors/imessage/imessage_sync.py (copy_sqlite, apple_ts, norm_handle).
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const APPLE_EPOCH_S = 978307200; // 2001-01-01T00:00:00Z in Unix seconds

/**
 * Run `fn` against a private temp copy of a SQLite db (with -wal/-shm, so recent writes are included).
 * The live file is never opened. The temp dir is removed afterwards, even on error.
 */
export function withTempCopies<T>(sources: string[], fn: (copies: Map<string, Database>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-"));
  const copies = new Map<string, Database>();
  try {
    for (const [i, src] of sources.entries()) {
      if (!existsSync(src)) continue;
      const sub = join(dir, String(i));
      Bun.spawnSync(["mkdir", "-m", "700", sub]);
      const dest = join(sub, basename(src));
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix);
      }
      // Opened read-write only so SQLite can fold in the copied WAL; it's a private copy.
      copies.set(src, new Database(dest));
    }
    return fn(copies);
  } finally {
    for (const db of copies.values()) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Apple-epoch timestamp (seconds, or nanoseconds on modern macOS) to Unix ms. */
export function appleToUnixMs(value: number | bigint | null | undefined): number {
  if (!value) return 0;
  let v = Number(value);
  if (v > 1e11) v = Math.floor(v / 1e9); // nanoseconds
  return (v + APPLE_EPOCH_S) * 1000;
}

export function unixMsToApple(ms: number, nanoseconds: boolean): number {
  const s = Math.floor(ms / 1000) - APPLE_EPOCH_S;
  return nanoseconds ? s * 1e9 : s;
}

/** Emails lowercased; phone numbers reduced to digits with a + prefix (10-digit US numbers get +1). */
export function normHandle(h: string | null | undefined): string {
  const s = (h ?? "").trim();
  if (s.includes("@")) return s.toLowerCase();
  let digits = s.replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return digits ? `+${digits}` : s;
}

/**
 * Pull the plain string out of an NSAttributedString typedstream blob (macOS 13+ often leaves
 * `text` null). Same byte-level rule as the earlier Python reader's decode_attributed_body.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string {
  if (!blob || blob.length === 0) return "";
  const data = Buffer.from(blob);
  const i = data.indexOf("NSString");
  if (i < 0) return "";
  const b = data.subarray(i + "NSString".length + 5);
  if (b.length === 0) return "";
  let n: number;
  let start: number;
  if (b[0] === 0x81) {
    n = b.readUInt16LE(1);
    start = 3;
  } else if (b[0] === 0x82) {
    n = b.readUInt32LE(1);
    start = 5;
  } else {
    n = b[0] ?? 0;
    start = 1;
  }
  return b.subarray(start, start + n).toString("utf8");
}

/** Truncate display names coming from third parties (docs/DESIGN.md: label/truncate sender names). */
export function safeName(name: string | null | undefined, max = 80): string | null {
  if (!name) return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
