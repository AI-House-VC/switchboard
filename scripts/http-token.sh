#!/usr/bin/env bash
# Mint a per-client token for Switchboard's loopback HTTP endpoint (a bot host on another
# machine, e.g. OpenMausBot on a home server, reaching this Mac through tailscale serve).
#
#   ./scripts/http-token.sh [client] [port]      defaults: openmausbot 47821
#
# Needs the 1Password CLI (op). Stores the token in 1Password (a vault you pick; item "Switchboard token (<client>)"), writes only its sha256
# and the port into Switchboard's config.json, restarts the daemon, and copies the header value
# "Bearer <token>" to the clipboard for 90 seconds so you can paste it into your bot host's Authorization
# header. The token is never printed, logged or passed on a command line. Re-running rotates it.
set -euo pipefail

CLIENT="${1:-openmausbot}"
PORT="${2:-47821}"
VAULT="${SWITCHBOARD_OP_VAULT:-}"
[[ -n "$VAULT" ]] || read -r -p "1Password vault to store the token in [Private]: " VAULT
VAULT="${VAULT:-Private}"
TITLE="Switchboard token ($CLIENT)"
CONFIG="$HOME/Library/Application Support/Switchboard/config.json"

[[ "$CLIENT" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || { echo "client must be lowercase letters, digits, - or _" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo "port must be 1024-65535" >&2; exit 1; }
[[ -f "$CONFIG" ]] || { echo "No Switchboard config at $CONFIG: run switchboard install first." >&2; exit 1; }
command -v op >/dev/null || { echo "1Password CLI (op) not found." >&2; exit 1; }
op whoami >/dev/null 2>&1 || op signin >/dev/null

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TOKEN="sbt_$(openssl rand -hex 32)"
HASH="$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"

# 1Password item via a 0600 template file, never argv.
TOKEN="$TOKEN" python3 -I - "$TMP/item.json" "$TITLE" <<'PY'
import json, os, sys
path, title = sys.argv[1], sys.argv[2]
item = {"title": title, "category": "API_CREDENTIAL",
        "fields": [{"id": "credential", "type": "CONCEALED", "label": "credential", "value": os.environ["TOKEN"]},
                   {"id": "notesPlain", "type": "STRING", "purpose": "NOTES",
                    "value": "Switchboard loopback HTTP token. Header: Authorization: Bearer <credential>. Rotate with scripts/http-token.sh."}]}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(item, f)
PY
if op item get "$TITLE" --vault "$VAULT" >/dev/null 2>&1; then
  op item delete "$TITLE" --vault "$VAULT" --archive >/dev/null
fi
op item create --vault "$VAULT" --template "$TMP/item.json" >/dev/null

# config.json: the hash and port only.
python3 -I - "$CONFIG" "$CLIENT" "$HASH" "$PORT" <<'PY'
import json, os, sys
path, client, digest, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
c = json.load(open(path))
http = c.setdefault("http", {"port": None, "tokens": [], "public_hosts": []})
http["port"] = port
http["tokens"] = [t for t in http.get("tokens", []) if t.get("client") != client] + [{"client": client, "sha256": digest}]
clients = c.setdefault("clients", {})
clients.setdefault(client, {"send_policy": "confirm", "approval": "mac_page"})
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write(json.dumps(c, indent=2) + "\n")
os.replace(tmp, path)
PY

launchctl kickstart -k "gui/$(id -u)/vc.aihouse.switchboard" >/dev/null 2>&1 || true

printf 'Bearer %s' "$TOKEN" | pbcopy
unset TOKEN
( sleep 90; [[ "$(pbpaste)" == Bearer\ sbt_* ]] && printf '' | pbcopy ) >/dev/null 2>&1 &

echo "✓ Token saved in 1Password: $VAULT / $TITLE"
echo "✓ Switchboard now serves http://127.0.0.1:$PORT/mcp for client '$CLIENT' (daemon restarted)"
echo "✓ Header value copied to the clipboard for 90 seconds. Paste it over any saved Authorization value."
echo
echo "In OpenMausBot: Plugins → MCP servers. Delete any 'switchboard' command entry (editing one keeps"
echo "its old arguments and it stays a command). Then Add server → Edit details → Connect to a URL:"
PUBLIC="$(python3 -I -c 'import json,sys; h=json.load(open(sys.argv[1])).get("http",{}).get("public_hosts") or []; print(h[0] if h else "")' "$CONFIG")"
if [[ -n "$PUBLIC" ]]; then echo "    URL:     https://$PUBLIC/mcp   (tailnet; needs: tailscale serve --bg $PORT)"
else echo "    URL:     http://127.0.0.1:$PORT/mcp"; fi
echo "    Header:  Authorization  =  (paste)"
