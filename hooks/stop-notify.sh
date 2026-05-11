#!/usr/bin/env bash
# CCCP Stop hook — optionally notifies a peer when this session ends.
#
# Activate by exporting CCCP_NOTIFY_ON_STOP=<peer-name> before launching claude.
# The hook reads the local registry to find <peer-name>'s URL, then POSTs a
# `note` to /msg. It never blocks the session and exits 0 on every path.

set -u

[ -z "${CCCP_NOTIFY_ON_STOP:-}" ] && exit 0

peer="$CCCP_NOTIFY_ON_STOP"
me="${CCCP_NAME:-$(hostname -s)-$$}"
registry="$HOME/.cccp/registry/${peer}.json"

[ -f "$registry" ] || exit 0

url=$(grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' "$registry" | head -n1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
[ -z "$url" ] && exit 0

# Read the hook JSON payload from stdin (Claude Code sends session info there).
payload=$(cat 2>/dev/null || echo '{}')

body=$(printf '{"from":"%s","kind":"note","content":"session %s stopped"}' "$me" "$me")

curl -sS -m 3 -X POST -H 'Content-Type: application/json' -d "$body" "$url/msg" >/dev/null 2>&1 || true

exit 0
