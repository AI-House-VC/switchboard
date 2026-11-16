#!/bin/bash
# Test double for /usr/bin/pbcopy: writes stdin to $FAKE_PBCOPY_OUT.
cat > "${FAKE_PBCOPY_OUT:-/dev/null}"
