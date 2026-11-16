#!/bin/bash
# Run the app against a synthetic fixture:
#   dev/run.sh <first-run|configured|error|missing|stopped> [snapshot.png] [page] [channel:mode to confirm]
# Never touches the real service: stub helper (its `daemon` just sleeps), fixture SWITCHBOARD_HOME.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scenario="${1:-first-run}"
/usr/bin/python3 -I "$here/make-fixtures.py" >/dev/null
export SWITCHBOARD_HOME="$here/out/$scenario"
export SWITCHBOARD_BIN="$here/fake-switchboard.sh"
export SWITCHBOARD_ALLMAN="/usr/bin/true"
case "$scenario" in
  first-run) export SWITCHBOARD_FDA=missing FAKE_CLAUDE=not_installed; guide=NO ;;
  configured) export SWITCHBOARD_FDA=granted; guide=YES ;;
  error) export SWITCHBOARD_FDA=missing FAKE_CLAUDE=failed; guide=YES ;;
  missing) export SWITCHBOARD_FDA=granted; guide=YES ;;
  stopped) export SWITCHBOARD_FDA=granted FAKE_DAEMON=exit; guide=YES ;;
esac
[ -n "${2:-}" ] && export SWITCHBOARD_SNAPSHOT="$2"
[ -n "${3:-}" ] && export SWITCHBOARD_PAGE="$3"
[ -n "${4:-}" ] && export SWITCHBOARD_PENDING="$4"
export SWITCHBOARD_OPEN_WINDOW=1
exec "$here/../.build/debug/Switchboard" -guideDismissed "$guide" -setupBlockCopied NO
