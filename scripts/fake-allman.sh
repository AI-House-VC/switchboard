#!/bin/bash
# Test double for allman (pattern from allman-mac's fake CLI harness). Never touches the network.
# Records each invocation's argv to $FAKE_ALLMAN_LOG when set.
# `send` behaviour comes from $FAKE_ALLMAN_SEND: ok (default) | stale | auth | fail | hang.
# `send --dry-run` comes from $FAKE_ALLMAN_PROBE: new (default) | existing:<convId> | fail.
[ -n "${FAKE_ALLMAN_LOG:-}" ] && echo "$*" >> "$FAKE_ALLMAN_LOG"
case "${1:-}" in
  --version) echo "0.7.1" ;;
  listen)
    echo '{"event":"connected","account":"ACoOWNER","timestamp":0}'
    trap 'exit 0' TERM INT
    while :; do sleep 1; done ;;
  sync) echo '{"ok":true,"conversations":0}' ;;
  status) echo '[{"status":"authenticated"}]' ;;
  send)
    if [ "${2:-}" = "--dry-run" ]; then
      case "${FAKE_ALLMAN_PROBE:-new}" in
        new) echo '{"dryRun":true,"convId":null,"isNewConversation":true}' ;;
        existing:*) echo "{\"dryRun\":true,\"convId\":\"${FAKE_ALLMAN_PROBE#existing:}\",\"isNewConversation\":false}" ;;
        *) echo "Profile not found" >&2; exit 1 ;;
      esac
      exit 0
    fi
    case "${FAKE_ALLMAN_SEND:-ok}" in
      ok) echo "{\"messageUrn\":\"urn:li:msg:fake-$RANDOM\",\"conversationUrn\":\"urn:li:conv:fake\",\"deliveredAt\":0,\"isNewConversation\":false}" ;;
      stale) echo "1 new message(s) received before send — aborting." >&2; exit 1 ;;
      auth) echo "Session expired: run allman login" >&2; exit 1 ;;
      fail) echo "Send failed: boom" >&2; exit 1 ;;
      hang) sleep 300 ;;
    esac ;;
  *) echo "fake-allman: unsupported: $*" >&2; exit 2 ;;
esac
