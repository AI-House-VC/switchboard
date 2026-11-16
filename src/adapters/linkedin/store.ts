/**
 * LinkedIn ingest from allman's store (read only; Switchboard never reads COOKIES.json).
 * Layout (allman-cli v0.7.1 src/store/conversations.ts):
 *   {store}/{accountProfileId}/{convId}/RECORD.json
 *   {store}/{accountProfileId}/{convId}/messages/YYYY-MM.jsonl
 * The account dir also holds alias symlinks (profileId, slug → convId dir) and non-conversation
 * dirs (connections, companies, invitations, ...); only real directories with a RECORD.json are read.
 */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getCheckpoint,
  refreshThreadTimes,
  setCheckpoint,
  upsertHandle,
  upsertMessage,
  upsertThread,
} from "../../index/db.ts";
import { safeName } from "../shared.ts";

interface Participant {
  profileId: string;
  profileUrn: string;
  backendUrn: string | null;
  slug: string | null;
  name: string;
}

interface ConversationRecord {
  convId: string;
  profileId: string;
  slug: string | null;
  isGroup?: boolean;
  title?: string | null;
  participants?: Participant[];
  profileUrn: string;
  name: string;
  unreadCount: number;
}

interface StoredMessage {
  urn: string;
  timestamp: number;
  fromUrn: string;
  fromName: string;
  isFromMe: boolean;
  body: string;
  attachments?: Array<{ type: string; name?: string; title?: string }>;
  subject?: string | null;
  fallbackText?: string | null;
}

/** The account directory: a real dir whose AUTH.json exists. Selects by alias (slug symlink) if given. */
export function accountDir(store: string, account: string | null): string | null {
  if (!existsSync(store)) return null;
  if (account) {
    const p = join(store, account);
    return existsSync(join(p, "AUTH.json")) ? p : null;
  }
  const real = readdirSync(store).filter((d) => {
    const p = join(store, d);
    return !lstatSync(p).isSymbolicLink() && lstatSync(p).isDirectory() && existsSync(join(p, "AUTH.json"));
  });
  return real.length === 1 ? join(store, real[0] as string) : null;
}

export function readAuth(dir: string): { status: string; lastSyncAt: string | null; profileSlug: string | null } {
  const a = JSON.parse(readFileSync(join(dir, "AUTH.json"), "utf8"));
  return { status: a.status ?? "unknown", lastSyncAt: a.lastSyncAt ?? null, profileSlug: a.profileSlug ?? null };
}

function attachmentLabel(m: StoredMessage): string {
  const a = m.attachments ?? [];
  if (a.length === 0) return "";
  return a.map((x) => `[${x.type}${x.title || x.name ? `: ${x.title ?? x.name}` : ""}]`).join(" ");
}

function listConversationDirs(dir: string): string[] {
  return readdirSync(dir).filter((d) => {
    const p = join(dir, d);
    const st = lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory() && existsSync(join(p, "RECORD.json"));
  });
}

/**
 * Incremental: each conversation's fingerprint (file count + newest mtime of RECORD.json and
 * messages/*.jsonl, taken before reading) is stored; a conversation is re-read only when it changes.
 * Messages older than the backfill window are not indexed.
 */
export function ingestLinkedIn(
  index: Database,
  dir: string,
  opts: { backfillDays: number; now?: number },
): { messages: number; threads: number } {
  const seen: Record<string, string> = JSON.parse(getCheckpoint(index, "linkedin.fingerprints") ?? "{}");
  const cutoff = (opts.now ?? Date.now()) - opts.backfillDays * 86400_000;
  let n = 0;
  const touched = new Set<string>();

  const conversations = listConversationDirs(dir);
  index.transaction(() => {
    for (const convId of conversations) {
      const cdir = join(dir, convId);
      const recPath = join(cdir, "RECORD.json");
      const msgDir = join(cdir, "messages");
      const files = existsSync(msgDir) ? readdirSync(msgDir).filter((f) => f.endsWith(".jsonl")) : [];
      const mtimes = [statSync(recPath).mtimeMs, ...files.map((f) => statSync(join(msgDir, f)).mtimeMs)];
      const fingerprint = `${mtimes.length}:${Math.max(...mtimes)}`;
      if (seen[convId] === fingerprint) continue;
      seen[convId] = fingerprint;

      const rec = JSON.parse(readFileSync(recPath, "utf8")) as ConversationRecord;
      const group = Boolean(rec.isGroup);
      const people: Participant[] = group
        ? (rec.participants ?? [])
        : [{ profileId: rec.profileId, profileUrn: rec.profileUrn, backendUrn: null, slug: rec.slug, name: rec.name }];
      const byUrn = new Map<string, Participant>();
      for (const p of people) {
        byUrn.set(p.profileUrn, p);
        if (p.backendUrn) byUrn.set(p.backendUrn, p);
      }
      const handleOf = (p: Participant) => (p.slug ?? p.profileId).toLowerCase();
      const threadId = `li:${rec.convId}`;
      upsertThread(index, {
        id: threadId,
        channel: "linkedin",
        native_id: rec.convId,
        title: safeName(rec.title ?? rec.name),
        is_group: group,
        unread: rec.unreadCount ?? 0,
        participants: people.map((p) => ({ handle: handleOf(p), name: safeName(p.name) })),
      });
      for (const p of people) upsertHandle(index, "linkedin", handleOf(p), safeName(p.name));

      // Only month files that could hold in-window messages (YYYY-MM.jsonl).
      const cutoffMonth = new Date(cutoff).toISOString().slice(0, 7);
      for (const f of files) {
        if (f.slice(0, 7) < cutoffMonth) continue;
        for (const line of readFileSync(join(msgDir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          let m: StoredMessage;
          try {
            m = JSON.parse(line);
          } catch {
            continue; // a partially written line; the next pass picks it up
          }
          if (m.timestamp < cutoff) continue;
          const body = [m.subject ? `Subject: ${m.subject}` : "", m.body || m.fallbackText || "", attachmentLabel(m)]
            .filter(Boolean)
            .join("\n")
            .trim();
          if (!body) continue;
          const sender = byUrn.get(m.fromUrn);
          upsertMessage(index, {
            id: `li:${m.urn}`,
            thread_id: threadId,
            channel: "linkedin",
            native_id: m.urn,
            ts: m.timestamp,
            from_handle: m.isFromMe ? null : sender ? handleOf(sender) : null,
            from_name: m.isFromMe ? null : safeName(m.fromName),
            is_from_me: m.isFromMe,
            body,
            kind: m.body ? "text" : "media",
            reply_to_native_id: null,
          });
          n++;
        }
      }
      touched.add(threadId);
    }
    refreshThreadTimes(index, touched);
    setCheckpoint(index, "linkedin.fingerprints", JSON.stringify(seen));
  })();
  return { messages: n, threads: touched.size };
}
