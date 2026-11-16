#!/bin/bash
# Test double for /usr/bin/open: records argv to $FAKE_OPEN_LOG, opens nothing.
[ -n "${FAKE_OPEN_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_OPEN_LOG"
exit 0
