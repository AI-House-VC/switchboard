/**
 * Audit log (docs/DESIGN.md): JSONL, one line per tool call, rotated at 10 MB × 5.
 * Arguments are redacted to their keys and value types/lengths: no message text, queries or
 * handles in operational logs. Never logs cookies, tokens or secrets.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;

export function redactArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string") out[k] = `string(${v.length})`;
    else if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = typeof v;
    else out[k] = "object";
  }
  // Enum-like, non-content args are useful to keep verbatim.
  const a = args as Record<string, unknown>;
  for (const k of ["channel", "unread_only", "limit", "min_age_hours"]) {
    if (a[k] != null && typeof a[k] !== "object") out[k] = String(a[k]);
  }
  return out;
}

export class AuditLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(entry: Record<string, unknown>): void {
    this.rotate();
    const fresh = !existsSync(this.path);
    appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    if (fresh) chmodSync(this.path, 0o600);
  }

  private rotate(): void {
    if (!existsSync(this.path) || statSync(this.path).size < MAX_BYTES) return;
    rmSync(`${this.path}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}
