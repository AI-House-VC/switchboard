/**
 * Resolve a send request to one exact, immutable target before anything is approved. Ambiguity and
 * unsupported cases are errors, never best guesses Rules (docs/DESIGN.md):
 *  - New conversations: 1:1 only. LinkedIn by profile slug/URL; iMessage to handles in Contacts;
 *    WhatsApp by phone. No new groups.
 *  - Existing groups: LinkedIn by thread id; iMessage only when imessage.group_send is on (spike);
 *    WhatsApp groups are a Copy & Open handoff.
 *  - iMessage recipients must be in Contacts, for replies too.
 */
import type { Database } from "bun:sqlite";
import { linkedinSlugFromUrl } from "../adapters/contacts/reader.ts";
import { normHandle } from "../adapters/shared.ts";
import type { Config } from "../config.ts";
import type { Channel } from "../index/db.ts";
import { getThread, type ThreadOut } from "../index/queries.ts";
import type { Target } from "../outbox/db.ts";

export class SendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SendRequest = { thread_id: string } | { channel: Channel; to: string };

function inContacts(index: Database, handle: string): boolean {
  const r = index
    .query("select 1 from handles where channel = 'imessage' and handle = ? and person_id like 'ab:%'")
    .get(handle);
  return Boolean(r);
}

function displayName(index: Database, channel: Channel, handle: string): string | null {
  const r = index.query("select display_name from handles where channel = ? and handle = ?").get(channel, handle) as {
    display_name: string | null;
  } | null;
  return r?.display_name ?? null;
}

function label(t: ThreadOut): string {
  return t.title ?? t.participants.map((p) => p.name ?? p.handle).join(", ");
}

const SLUG = /^[a-z0-9][a-z0-9\-_%.]{1,99}$/i;

export function linkedinSlug(to: string): string | null {
  const s = to.trim();
  const fromUrl = linkedinSlugFromUrl(s);
  if (fromUrl) return fromUrl;
  return SLUG.test(s) && !s.includes(".") ? s.toLowerCase() : null;
}

function fromThread(index: Database, config: Config, t: ThreadOut): Target {
  const handles = t.participants.map((p) => p.handle).filter((h): h is string => Boolean(h));
  const base = { channel: t.channel, thread_id: t.thread_id, is_group: t.is_group, display: label(t), handles };
  const native = t.thread_id.slice(3);
  switch (t.channel) {
    case "linkedin":
      return { ...base, native };
    case "imessage": {
      if (t.is_group) {
        if (!config.imessage.group_send)
          throw new SendError(
            "unsupported",
            "Sending into iMessage groups isn't enabled (M3 spike pending). Send 1:1 instead.",
          );
        return { ...base, native };
      }
      const [service, , raw] = native.split(";");
      const handle = normHandle(raw ?? "");
      if (!inContacts(index, handle))
        throw new SendError("recipient_not_in_contacts", "iMessage sends go only to people in your Contacts.");
      return { ...base, native: handle, service: service === "SMS" ? "SMS" : "iMessage", handles: [handle] };
    }
    case "whatsapp": {
      if (t.is_group) return { ...base, native };
      const phone = handles[0] ?? "";
      if (!/^\+\d{6,}$/.test(phone))
        throw new SendError("unsupported", "This WhatsApp chat has no phone number to open a prefilled draft with.");
      return { ...base, native: phone.slice(1), handles: [phone] };
    }
  }
}

export function resolveTarget(index: Database, config: Config, req: SendRequest): Target {
  if ("thread_id" in req) {
    const t = getThread(index, req.thread_id);
    if (!t) throw new SendError("not_found", `No thread ${req.thread_id}. Use list_threads or find_person.`);
    return fromThread(index, config, t);
  }
  const to = req.to.trim();
  if (/[,;]/.test(to) && req.channel !== "imessage")
    throw new SendError("unsupported", "One recipient only: Switchboard doesn't start new group conversations.");
  switch (req.channel) {
    case "linkedin": {
      const slug = linkedinSlug(to);
      if (!slug)
        throw new SendError("bad_recipient", "LinkedIn recipient must be a profile slug or linkedin.com/in/ URL.");
      const existing = index
        .query(
          `select t.id from threads t, json_each(t.participants_json) j
           where t.channel = 'linkedin' and t.is_group = 0 and json_extract(j.value, '$.handle') = ?
           order by t.last_message_at desc limit 1`,
        )
        .get(slug) as { id: string } | null;
      if (existing) return fromThread(index, config, getThread(index, existing.id) as ThreadOut);
      return {
        channel: "linkedin",
        thread_id: null,
        native: slug,
        is_group: false,
        display: displayName(index, "linkedin", slug) ?? slug,
        handles: [slug],
      };
    }
    case "imessage": {
      if (/[,;]/.test(to))
        throw new SendError("unsupported", "One recipient only: Switchboard doesn't start new group conversations.");
      const h = normHandle(to);
      if (!h.startsWith("+") && !h.includes("@"))
        throw new SendError("bad_recipient", "iMessage recipient must be a phone number or email.");
      if (!inContacts(index, h))
        throw new SendError("recipient_not_in_contacts", "iMessage sends go only to people in your Contacts.");
      for (const svc of ["iMessage", "SMS"]) {
        const t = getThread(index, `im:${svc};-;${h}`);
        if (t) return fromThread(index, config, t);
      }
      return {
        channel: "imessage",
        thread_id: null,
        native: h,
        service: "iMessage",
        is_group: false,
        display: displayName(index, "imessage", h) ?? h,
        handles: [h],
      };
    }
    case "whatsapp": {
      const h = normHandle(to);
      if (!/^\+\d{6,}$/.test(h)) throw new SendError("bad_recipient", "WhatsApp recipient must be a phone number.");
      const t = getThread(index, `wa:${h.slice(1)}@s.whatsapp.net`);
      if (t) return fromThread(index, config, t);
      return {
        channel: "whatsapp",
        thread_id: null,
        native: h.slice(1),
        is_group: false,
        display: displayName(index, "whatsapp", h) ?? h,
        handles: [h],
      };
    }
  }
}
