#!/usr/bin/env bash
# Mint a per-client token for Switchboard's loopback HTTP endpoint (a bot host on another
# machine, e.g. OpenMausBot on a home server, reaching this Mac through tailscale serve).
#
#   ./scripts/http-token.sh [client] [port]      defaults: openmausbot 47821
#
# Needs the 1Password CLI (op). Stores the token in 1Password (a vault you pick; item "Switchboard token (<client>)"),
# writes only its sha256, the port and this Mac's tailnet name (http.public_hosts) into Switchboard's config.json,
# restarts the daemon (Switchboard.app's or the terminal build's), checks that the endpoint now accepts the new
# token, and copies the header value "Bearer <token>" to the clipboard for 90 seconds so you can paste it into your
# bot host's Authorization header. The token is never printed, logged or passed on a command line. Re-running
# rotates it.
#
# Optional environment: SWITCHBOARD_OP_VAULT (skip the vault prompt), SWITCHBOARD_PUBLIC_HOST (this Mac's
# <mac>.<tailnet>.ts.net name, when the tailscale CLI can't tell us).
set -euo pipefail

CLIENT="${1:-openmausbot}"
PORT="${2:-47821}"
RELAY_PORT=47822
TITLE="Switchboard token ($CLIENT)"
CONFIG="$HOME/Library/Application Support/Switchboard/config.json"
WAIT_SECONDS="${SWITCHBOARD_RESTART_WAIT:-45}"
CLIP_SECONDS="${SWITCHBOARD_CLIP_SECONDS:-90}"

[[ "$CLIENT" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || { echo "client must be lowercase letters, digits, - or _" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo "port must be 1024-65535" >&2; exit 1; }
[[ -f "$CONFIG" ]] || { echo "No Switchboard config at $CONFIG: open Switchboard.app (or run switchboard install) first." >&2; exit 1; }
command -v op >/dev/null || { echo "1Password CLI (op) not found." >&2; exit 1; }

# 1Password sign-in. With no account known to op, `op signin` asks to "add an account manually": that almost
# always means the desktop app's CLI integration is off.
if ! op whoami >/dev/null 2>&1; then
  if [[ -z "$(op account list 2>/dev/null)" ]]; then
    echo "The 1Password CLI doesn't see your 1Password account." >&2
    echo "Open 1Password → Settings → Developer → turn on \"Integrate with 1Password CLI\", then run this again." >&2
    exit 1
  fi
  op signin >/dev/null
fi

# Vault: default to Private (team accounts) or Personal (individual accounts), else the first one listed.
VAULTS="$(op vault list --format json | python3 -I -c 'import json,sys; print("\n".join(v["name"] for v in json.load(sys.stdin)))')"
[[ -n "$VAULTS" ]] || { echo "No 1Password vaults visible to op." >&2; exit 1; }
if grep -qx "Private" <<<"$VAULTS"; then DEFAULT_VAULT="Private"
elif grep -qx "Personal" <<<"$VAULTS"; then DEFAULT_VAULT="Personal"
else DEFAULT_VAULT="$(head -n1 <<<"$VAULTS")"; fi
VAULT="${SWITCHBOARD_OP_VAULT:-}"
if [[ -z "$VAULT" ]]; then
  echo "1Password vaults: $(paste -sd, - <<<"$VAULTS" | sed 's/,/, /g')"
  read -r -p "Vault to store the token in [$DEFAULT_VAULT]: " VAULT
fi
VAULT="${VAULT:-$DEFAULT_VAULT}"
grep -qxF "$VAULT" <<<"$VAULTS" || { echo "\"$VAULT\" isn't one of your vaults: $(paste -sd, - <<<"$VAULTS")" >&2; exit 1; }

# This Mac's tailnet name, so tailscale serve's Host header is accepted (http.public_hosts).
PUBLIC_HOST="${SWITCHBOARD_PUBLIC_HOST:-}"
if [[ -z "$PUBLIC_HOST" ]]; then
  TS="$(command -v tailscale || true)"
  [[ -z "$TS" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  if [[ -n "$TS" ]]; then
    PUBLIC_HOST="$("$TS" status --json 2>/dev/null | python3 -I -c 'import json,sys; print(((json.load(sys.stdin).get("Self") or {}).get("DNSName") or "").rstrip("."))' 2>/dev/null || true)"
  fi
fi
PUBLIC_HOST="${PUBLIC_HOST%.}"
if [[ -n "$PUBLIC_HOST" && ! "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]; then
  echo "\"$PUBLIC_HOST\" isn't a host name." >&2; exit 1
fi

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TOKEN="sbt_$(openssl rand -hex 32)"
HASH="$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
# The header lives in a 0600 file for curl (-H @file) and pbcopy, never in argv.
printf 'Authorization: Bearer %s\n' "$TOKEN" >"$TMP/auth-header"

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
unset TOKEN
if op item get "$TITLE" --vault "$VAULT" >/dev/null 2>&1; then
  op item delete "$TITLE" --vault "$VAULT" --archive >/dev/null
fi
op item create --vault "$VAULT" --template "$TMP/item.json" >/dev/null
rm -f "$TMP/item.json"

# config.json: the hash, the port and the public host only.
python3 -I - "$CONFIG" "$CLIENT" "$HASH" "$PORT" "$PUBLIC_HOST" <<'PY'
import json, os, sys
path, client, digest, port, public = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
c = json.load(open(path))
http = c.setdefault("http", {"port": None, "tokens": [], "public_hosts": []})
http["port"] = port
http["tokens"] = [t for t in http.get("tokens", []) if t.get("client") != client] + [{"client": client, "sha256": digest}]
hosts = http.setdefault("public_hosts", [])
if public and public not in hosts: hosts.append(public)
clients = c.setdefault("clients", {})
clients.setdefault(client, {"send_policy": "confirm", "approval": "mac_page"})
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write(json.dumps(c, indent=2) + "\n")
os.replace(tmp, path)
PY
[[ -n "$PUBLIC_HOST" ]] || PUBLIC_HOST="$(python3 -I -c 'import json,sys; h=json.load(open(sys.argv[1])).get("http",{}).get("public_hosts") or []; print(h[0] if h else "")' "$CONFIG")"

# Restart the daemon so it reads the new config. Switchboard.app runs it as a child and starts it again when it
# exits; the terminal build runs it as a LaunchAgent.
APP_PID="$(pgrep -f 'Switchboard.app/Contents/Helpers/switchboard daemon' 2>/dev/null | head -n1 || true)"
if [[ -n "$APP_PID" ]]; then
  kill -TERM "$APP_PID" 2>/dev/null && RESTART=app || RESTART=none
elif launchctl kickstart -k "gui/$(id -u)/vc.aihouse.switchboard" >/dev/null 2>&1; then
  RESTART=agent
else
  RESTART=none
fi

# Serving means: the endpoint takes the new token. A 200 to initialize can only come from a daemon that read it.
serving() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST -H @"$TMP/auth-header" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"http-token-check","version":"1"}}}' \
    "http://127.0.0.1:$PORT/mcp" 2>/dev/null || true)"
  [[ "$code" == 200 ]]
}
SERVING=0
if [[ "$RESTART" != none ]]; then
  for (( i = 0; i < WAIT_SECONDS; i++ )); do
    if [[ "$RESTART" == app ]] && pgrep -f 'Switchboard.app/Contents/Helpers/switchboard daemon' 2>/dev/null | grep -qx "$APP_PID"; then
      sleep 1; continue # the old daemon is still shutting down
    fi
    if serving; then SERVING=1; break; fi
    sleep 1
  done
fi

sed 's/^Authorization: //' "$TMP/auth-header" | tr -d '\n' | pbcopy
( sleep "$CLIP_SECONDS"; [[ "$(pbpaste)" == Bearer\ sbt_* ]] && printf '' | pbcopy ) >/dev/null 2>&1 &

echo "✓ Token saved in 1Password: $VAULT / $TITLE"
if (( SERVING )); then
  echo "✓ Switchboard restarted and serves http://127.0.0.1:$PORT/mcp on this Mac for client '$CLIENT'"
else
  echo "✗ Switchboard isn't serving the new token on port $PORT yet: the config is saved, but the daemon"
  if [[ -n "$APP_PID" || "$RESTART" == none ]]; then
    echo "  didn't pick it up. Quit Switchboard from its menu-bar icon and open it again, then re-check with:"
  else
    echo "  didn't come back. Check ~/Library/Logs/Switchboard, then re-check with:"
  fi
  echo "    curl -s -o /dev/null -w '%{http_code}\\n' -X POST http://127.0.0.1:$PORT/mcp   (401 means it's up)"
fi
echo "✓ Header value copied to the clipboard for $CLIP_SECONDS seconds. Paste it over any saved Authorization value."
if [[ -n "$PUBLIC_HOST" ]]; then
  echo "✓ Accepting the tailnet name $PUBLIC_HOST (http.public_hosts)"
else
  echo "! Couldn't find this Mac's tailnet name, so requests through tailscale serve will get 403. Run again with"
  echo "  SWITCHBOARD_PUBLIC_HOST=<mac>.<tailnet>.ts.net, or add that name to http.public_hosts in $CONFIG."
fi
echo
echo "On this Mac, expose the port to your tailnet (once):  tailscale serve --bg $PORT"
echo
echo "In OpenMausBot: Plugins → MCP servers. Delete any 'switchboard' command entry (editing one keeps"
echo "its old arguments and it stays a command). Then Add server → Edit details → Connect to a URL:"
MAC_URL="https://${PUBLIC_HOST:-<mac>.<tailnet>.ts.net}/mcp"
echo "    With the relay on the bot host (recommended if this Mac sleeps):"
echo "      URL:     http://127.0.0.1:$RELAY_PORT/mcp"
echo "      Relay:   node switchboard-relay.mjs --upstream $MAC_URL --port $RELAY_PORT"
echo "    Without the relay:"
echo "      URL:     $MAC_URL"
echo "    Bot host on this same Mac:"
echo "      URL:     http://127.0.0.1:$PORT/mcp"
echo "    Header:  Authorization  =  (paste)"
(( SERVING )) || exit 1
