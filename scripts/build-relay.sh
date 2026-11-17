#!/bin/bash
# Build dist/switchboard-relay.mjs: the relay on its own, for plain Node on a bot host (no Bun, no Mac).
set -euo pipefail
cd "$(dirname "$0")/.."
bun scripts/relay-snapshot.ts
mkdir -p dist
bun build src/relay/main.ts --target=node --format=esm --outfile dist/switchboard-relay.mjs
echo "built dist/switchboard-relay.mjs ($(wc -c < dist/switchboard-relay.mjs) bytes)"
