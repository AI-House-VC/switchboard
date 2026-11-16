#!/bin/bash
# Development stub for the switchboard helper (SWITCHBOARD_BIN). Synthetic only; never touches real data.
# Writes modes into $SWITCHBOARD_HOME/app/config.json like the real set-channel does.
set -euo pipefail
cfg="$SWITCHBOARD_HOME/app/config.json"
case "${1:-}" in
  app-setup)
    echo "{\"config_created\":false,\"old_agent_removed\":false,\"claude_code\":\"${FAKE_CLAUDE:-registered}\"}" ;;
  set-channel)
    /usr/bin/python3 -I - "$cfg" "$2" "$3" <<'PY'
import json, sys
path, ch, mode = sys.argv[1:]
c = json.load(open(path))
c.setdefault("channels", {})[ch] = mode
json.dump(c, open(path, "w"), indent=2)
print(json.dumps(c["channels"]))
PY
    ;;
  daemon)
    # The app runs this as its child. FAKE_DAEMON=exit simulates a service that keeps failing.
    [ "${FAKE_DAEMON:-}" = exit ] && exit 1
    exec /bin/sleep 86400 ;;
  doctor)
    cat <<'TXT'
Switchboard doctor (synthetic)
  ok    background service   pid 4242, approval page on 127.0.0.1:48123
  ok    imessage             312 threads, last ingest 2 min ago
  warn  whatsapp             off
  fail  linkedin             not signed in: run allman login
TXT
    ;;
  *) echo "unknown" >&2; exit 2 ;;
esac
