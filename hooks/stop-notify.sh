#!/usr/bin/env bash
# CCP Stop hook — optionally notifies a peer when this session ends.
#
# Activate by exporting CCP_NOTIFY_ON_STOP=<peer-name> before launching Codex.
# The hook reads the local registry to find <peer-name>'s URL, then POSTs a
# `note` to /msg. It never blocks the session and exits 0 on every path.

set -u

[ -z "${CCP_NOTIFY_ON_STOP:-}" ] && exit 0

peer="$CCP_NOTIFY_ON_STOP"
home="${CCP_HOME:-$HOME/.ccp}"
me=$(
  CCP_NAME_VALUE="${CCP_NAME:-}" CCP_HOME_VALUE="$home" node <<'NODE'
const fs = require('fs')
const path = require('path')
if (process.env.CCP_NAME_VALUE) {
  process.stdout.write(process.env.CCP_NAME_VALUE)
  process.exit(0)
}
const dir = path.join(process.env.CCP_HOME_VALUE, 'registry')
let matches = []
try {
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const rec = JSON.parse(fs.readFileSync(full, 'utf8'))
    matches.push({ rec, mtime: fs.statSync(full).mtimeMs })
  }
} catch {}
matches.sort((a, b) => b.mtime - a.mtime)
process.stdout.write(matches[0]?.rec?.name || `${require('os').hostname().split('.')[0]}-${process.pid}`)
NODE
)
registry="$home/registry/${peer}.json"

[ -f "$registry" ] || exit 0

url=$(grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' "$registry" | head -n1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
[ -z "$url" ] && exit 0

# Read the hook JSON payload from stdin (Codex sends session info there).
payload=$(cat 2>/dev/null || echo '{}')

body=$(printf '{"from":"%s","kind":"note","content":"session %s stopped"}' "$me" "$me")

curl -sS -m 3 -X POST -H 'Content-Type: application/json' -d "$body" "$url/msg" >/dev/null 2>&1 || true

exit 0
