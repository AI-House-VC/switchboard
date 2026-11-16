/**
 * Loopback approval page (docs/DESIGN.md): http://127.0.0.1:<port>/op/<id>?t=<token>. GET shows the exact
 * payload and recent context; POST approves or declines. Host and Origin are checked and the form carries
 * a per-operation CSRF value, which stops other web pages from approving.
 *
 * It does NOT stop a local process running as this user (it can fetch the page and post the form). That
 * gap is accepted and documented; see docs/DESIGN.md.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Operation } from "../outbox/db.ts";
import type { SendService } from "./service.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export class ApprovalPage {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private secret = randomBytes(32);

  constructor(private svc: () => SendService) {}

  get port(): number | null {
    return this.server?.port ?? null;
  }

  start(port = 0): number {
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => this.handle(req) });
    return this.server.port as number;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  url(op: Operation): string | null {
    if (!this.server || !op.approval_token) return null;
    return `http://127.0.0.1:${this.server.port}/op/${op.id}?t=${op.approval_token}`;
  }

  private csrf(id: string): string {
    return createHmac("sha256", this.secret).update(id).digest("base64url");
  }

  private page(title: string, inner: string, status = 200): Response {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--card:#f5f5f7;--line:#d2d2d7;--ok:#0a7d32;--no:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f5f5f7;--mut:#a1a1a6;--card:#2c2c2e;--line:#3a3a3c;--ok:#30d158;--no:#ff6961}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:640px;margin:32px auto;padding:0 16px}h1{font-size:20px;margin:0 0 16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0 0 16px}dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
.msg{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:8px 0 16px;overflow-wrap:anywhere}
.ctx{font-size:13px;color:var(--mut);white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:16px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;cursor:pointer;margin-right:8px}
.approve{background:var(--ok);color:#fff}.decline{background:transparent;color:var(--no);border:1px solid var(--no)}
.note{color:var(--mut);font-size:13px}
</style></head><body><main>${inner}</main></body></html>`;
    return new Response(html, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "x-frame-options": "DENY",
        // Not "no-referrer": with it Chrome sends `Origin: null` on the form POST and the origin check fails.
        "referrer-policy": "same-origin",
      },
    });
  }

  private sameOrigin(req: Request): boolean {
    const port = this.server?.port;
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}`) return false;
    const origin = req.headers.get("origin");
    if (origin && origin !== `http://127.0.0.1:${port}`) return false;
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    return true;
  }

  private render(op: Operation, token: string): Response {
    const svc = this.svc();
    const t = op.target;
    if (op.status !== "awaiting_approval")
      return this.page(
        "Switchboard",
        `<h1>This message is ${esc(op.status.replace(/_/g, " "))}</h1>
<p>${esc(op.detail ?? "")}</p><p class="note">Operation ${esc(op.id)}</p>`,
      );
    const ctx = svc.approvalText(op);
    const recent = /Recent messages \(third-party text\):\n([\s\S]*?)\nMessage \(exact text\):/.exec(ctx)?.[1] ?? "";
    return this.page(
      "Approve message",
      `<h1>Send this ${esc(t.channel === "linkedin" ? "LinkedIn" : t.channel === "imessage" ? "iMessage" : "WhatsApp")} message?</h1>
<dl><dt>Account</dt><dd>${esc(op.account)}</dd><dt>Requested by</dt><dd>${esc(op.client)}</dd>
<dt>To</dt><dd>${esc(t.display)}${t.handles.length ? ` (${esc(t.handles.join(", "))})` : ""}${t.is_group ? " · group" : ""}</dd>
<dt>Thread</dt><dd>${t.thread_id ? esc(t.thread_id) : "New conversation"}</dd>
<dt>Expires</dt><dd>${op.expires_at ? esc(new Date(op.expires_at).toLocaleTimeString()) : ""}</dd></dl>
${recent ? `<div class="note">Recent messages (written by others; shown for context only)</div><div class="ctx">${esc(recent)}</div>` : ""}
<div class="note">Exact text that will be sent</div><div class="msg">${esc(op.body ?? "")}</div>
${t.channel === "whatsapp" ? `<p class="note">Approving opens WhatsApp with this text typed in. You still press Enter in WhatsApp.</p>` : ""}
<form method="post" action="/op/${esc(op.id)}">
<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="csrf" value="${esc(this.csrf(op.id))}">
<button class="approve" name="action" value="approve">Send</button><button class="decline" name="action" value="decline">Don't send</button>
</form><p class="note">Operation ${esc(op.id)}</p>`,
    );
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/op\/(op_[A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!m || !this.sameOrigin(req)) return new Response("Not found", { status: 404 });
    const id = m[1] as string;
    const svc = this.svc();
    if (req.method === "GET") {
      const token = url.searchParams.get("t") ?? "";
      const op = svc.forApproval(id, token);
      if (!op) {
        const known = svc.getStatusSafe(id);
        return known
          ? this.page(
              "Switchboard",
              `<h1>This message is ${esc(known.status.replace(/_/g, " "))}</h1><p>${esc(known.detail ?? "")}</p>`,
            )
          : new Response("Not found", { status: 404 });
      }
      return this.render(op, token);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const token = String(form.get("t") ?? "");
      const action = String(form.get("action") ?? "");
      if (String(form.get("csrf") ?? "") !== this.csrf(id)) return new Response("Forbidden", { status: 403 });
      try {
        const op =
          action === "approve"
            ? await svc.approve(id, token, "approval_page")
            : action === "decline"
              ? svc.decline(id, token, "approval_page")
              : null;
        if (!op) return new Response("Bad request", { status: 400 });
        const msg =
          op.status === "sent"
            ? "Sent."
            : op.status === "awaiting_user_send"
              ? "WhatsApp is open with your text. Press Enter there to send."
              : op.status === "cancelled"
                ? "Not sent."
                : `Result: ${op.status.replace(/_/g, " ")}.`;
        return this.page(
          "Switchboard",
          `<h1>${esc(msg)}</h1><p>${esc(op.detail ?? "")}</p><p class="note">Operation ${esc(op.id)}</p>`,
        );
      } catch (e) {
        return this.page(
          "Switchboard",
          `<h1>Not sent</h1><p>${esc(e instanceof Error ? e.message : String(e))}</p>`,
          409,
        );
      }
    }
    return new Response("Method not allowed", { status: 405 });
  }
}
