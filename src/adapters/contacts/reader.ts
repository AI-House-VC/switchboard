/**
 * macOS Contacts reader. Ported from an earlier Python reader's contacts_index(), extended to read LinkedIn URLs
 * stored on a card (URL or social-profile fields) so cards can join LinkedIn identities.
 * Rebuilds the `people` table from scratch each run (it's a cache) and links handles to people.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normHandle, withTempCopies } from "../shared.ts";

export function addressBookFiles(dir: string): string[] {
  const out: string[] = [];
  const top = join(dir, "AddressBook-v22.abcddb");
  if (existsSync(top)) out.push(top);
  const sources = join(dir, "Sources");
  if (existsSync(sources)) {
    for (const s of readdirSync(sources)) {
      const f = join(sources, s, "AddressBook-v22.abcddb");
      if (existsSync(f)) out.push(f);
    }
  }
  return out;
}

/** linkedin.com/in/<slug> → slug (lowercased), else null. */
export function linkedinSlugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : null;
}

interface Card {
  id: string;
  name: string;
  phones: Set<string>;
  emails: Set<string>;
  linkedin: string | null;
}

export function ingestContacts(index: Database, dir: string): { people: number; linkedHandles: number } {
  const files = addressBookFiles(dir);
  const cards: Card[] = [];
  withTempCopies(files, (copies) => {
    for (const [src, db] of copies) {
      const sourceKey = Bun.hash(src).toString(36);
      try {
        const byPk = new Map<number, Card>();
        for (const r of db
          .query("select Z_PK as pk, ZFIRSTNAME as first, ZLASTNAME as last, ZORGANIZATION as org from ZABCDRECORD")
          .all() as Array<{ pk: number; first: string | null; last: string | null; org: string | null }>) {
          const name = [r.first, r.last].filter(Boolean).join(" ").trim() || r.org || "";
          if (!name) continue;
          byPk.set(r.pk, { id: `ab:${sourceKey}:${r.pk}`, name, phones: new Set(), emails: new Set(), linkedin: null });
        }
        for (const r of db.query("select ZOWNER as o, ZFULLNUMBER as v from ZABCDPHONENUMBER").all() as Array<{
          o: number;
          v: string | null;
        }>) {
          if (r.v) byPk.get(r.o)?.phones.add(normHandle(r.v));
        }
        for (const r of db.query("select ZOWNER as o, ZADDRESS as v from ZABCDEMAILADDRESS").all() as Array<{
          o: number;
          v: string | null;
        }>) {
          if (r.v) byPk.get(r.o)?.emails.add(normHandle(r.v));
        }
        const urls: Array<{ o: number; v: string | null }> = [];
        try {
          urls.push(...(db.query("select ZOWNER as o, ZURL as v from ZABCDURLADDRESS").all() as typeof urls));
        } catch {}
        try {
          urls.push(
            ...(db
              .query(
                "select ZOWNER as o, coalesce(ZURLSTRING, case when lower(ZSERVICENAME) like '%linkedin%' then 'linkedin.com/in/' || ZUSERNAME end) as v from ZABCDSOCIALPROFILE",
              )
              .all() as typeof urls),
          );
        } catch {}
        for (const r of urls) {
          const slug = linkedinSlugFromUrl(r.v);
          const card = byPk.get(r.o);
          if (slug && card && !card.linkedin) card.linkedin = slug;
        }
        cards.push(...byPk.values());
      } catch {
        // a source without the expected tables (e.g. an empty account)
      }
    }
  });

  let linked = 0;
  index.transaction(() => {
    index.exec("delete from people where id like 'ab:%'; update handles set person_id = null;");
    const ins = index.query(
      "insert or replace into people(id, display_name, contacts_card_id, linkedin_slug, phones_json, emails_json) values (?, ?, ?, ?, ?, ?)",
    );
    const link = index.query(
      "insert into handles(channel, handle, display_name, person_id) values (?, ?, ?, ?) " +
        "on conflict(channel, handle) do update set person_id = excluded.person_id, display_name = excluded.display_name",
    );
    for (const c of cards) {
      ins.run(c.id, c.name, c.id, c.linkedin, JSON.stringify([...c.phones]), JSON.stringify([...c.emails]));
      for (const h of [...c.phones, ...c.emails]) {
        // A handle seen on iMessage/WhatsApp gets the card's name; unseen handles are still recorded
        // so find_person can return the card's channels before any message exists.
        link.run("imessage", h, c.name, c.id);
        if (h.startsWith("+")) link.run("whatsapp", h, c.name, c.id);
        linked++;
      }
      if (c.linkedin) {
        link.run("linkedin", c.linkedin, c.name, c.id);
        linked++;
      }
    }
  })();
  return { people: cards.length, linkedHandles: linked };
}
