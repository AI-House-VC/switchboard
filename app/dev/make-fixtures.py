"""Synthetic fixture homes for UI review: dev/out/<scenario>/app/{status.json,config.json}. No real data."""
import json, os, sys
from datetime import datetime, timedelta, timezone

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
now = datetime.now(timezone.utc)
iso = lambda mins: (now - timedelta(minutes=mins)).isoformat().replace("+00:00", "Z")
OFF = "Switched off in Switchboard settings."

def ch(name, enabled=True, auth="local", at=None, msgs=0, problems=(), mode="off"):
    return {"channel": name, "enabled": enabled, "connected": at is not None and not problems, "auth": auth,
            "last_ingest_at": iso(at) if at is not None else None,
            "last_ingest": {"messages": msgs, "threads": min(msgs, 3)} if at is not None else None,
            "problems": list(problems), "mode": mode}

scenarios = {
    "first-run": ({"linkedin": "off", "imessage": "off", "whatsapp": "off"}, 1, [
        ch("linkedin", enabled=False, auth="no account", problems=[OFF]),
        ch("imessage", problems=[OFF]), ch("whatsapp", problems=[OFF]),
        {**ch("contacts", problems=[OFF])}]),
    "configured": ({"linkedin": "read_write", "imessage": "read", "whatsapp": "read_write"}, 1, [
        ch("linkedin", auth="authenticated", at=2, msgs=4, mode="read_write"),
        ch("imessage", at=1, msgs=0, mode="read"),
        ch("whatsapp", at=7, msgs=12, mode="read_write"),
        ch("contacts", at=30)]),
    "error": ({"linkedin": "read_write", "imessage": "read", "whatsapp": "read"}, 1, [
        ch("linkedin", auth="expired", at=600, problems=["LinkedIn session expired: run `allman login`."], mode="read_write"),
        ch("imessage", at=None, problems=["Can't read chat.db (EPERM): check Full Disk Access for the switchboard binary, then restart the daemon (`switchboard doctor`)."], mode="read"),
        ch("whatsapp", enabled=False, problems=["WhatsApp desktop not installed or not linked on this Mac"], mode="read"),
        ch("contacts", at=30)]),
    "missing": ({"linkedin": "off", "imessage": "read", "whatsapp": "read"}, 1, [
        ch("linkedin", enabled=False, auth="no account", problems=[OFF]),
        ch("imessage", at=3, msgs=2, mode="read"),
        ch("whatsapp", enabled=False, problems=["WhatsApp desktop not installed or not linked on this Mac"], mode="read"),
        ch("contacts", at=30)]),
    "stopped": ({"linkedin": "off", "imessage": "read", "whatsapp": "off"}, 999999, [
        ch("linkedin", enabled=False, auth="no account", problems=[OFF]),
        ch("imessage", at=300, mode="read"), ch("whatsapp", problems=[OFF]), ch("contacts", at=300)]),
}
for name, (modes, pid, channels) in scenarios.items():
    d = os.path.join(out, name, "app"); os.makedirs(d, exist_ok=True)
    json.dump({"backfill_days": 30, "channels": modes}, open(os.path.join(d, "config.json"), "w"), indent=2)
    json.dump({"pid": pid, "at": iso(0), "approval_port": 48123, "channels": channels},
              open(os.path.join(d, "status.json"), "w"), indent=2)
print("fixtures in", out)
