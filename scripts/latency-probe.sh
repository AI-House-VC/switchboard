#!/bin/bash
# M1 acceptance probe: for each LinkedIn message that arrives after this starts, print how many seconds it
# took to become queryable in the index (index first-seen time minus the message timestamp).
# Prints direction and latency only; never message text, names or ids. Usage: latency-probe.sh [minutes]
set -euo pipefail
IDX="$HOME/Library/Application Support/Switchboard/index.db"
MINUTES=${1:-20}
start=$(($(date +%s) * 1000))
end=$(($(date +%s) + MINUTES * 60))
seen=""
echo "watching LinkedIn for ${MINUTES}m (target: ≤10s)…"
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(python3 -I -c 'import time; print(int(time.time()*1000))')
  while IFS='|' read -r rowid ts mine; do
    [ -z "$rowid" ] && continue
    case " $seen " in *" $rowid "*) continue ;; esac
    seen="$seen $rowid"
    dir=$([ "$mine" = 1 ] && echo outbound || echo inbound)
    awk -v n="$now" -v t="$ts" -v d="$dir" 'BEGIN { printf "%s message: %.1fs %s\n", d, (n - t) / 1000, ((n - t) <= 10000 ? "✓" : "✗ over 10s") }'
  done < <(sqlite3 "$IDX" "select rowid, ts, is_from_me from messages where channel = 'linkedin' and ts >= $start")
  sleep 0.5
done
