#!/usr/bin/env bash
# CCP PermissionRequest hook for Codex.
#
# Set CCP_SUPERVISOR=<peer-name> before launching Codex. When Codex asks for a
# tool approval, this hook forwards the request to the supervisor peer, waits
# briefly for a verdict, and returns a Codex PermissionRequest decision.

set -u

[ -z "${CCP_SUPERVISOR:-}" ] && exit 0

payload=$(cat 2>/dev/null || echo '{}')

parsed=$(
  PAYLOAD="$payload" node <<'NODE'
const input = JSON.parse(process.env.PAYLOAD || '{}')
const tool = input.tool_name || 'unknown'
const toolInput = input.tool_input == null ? '' : JSON.stringify(input.tool_input)
const desc = input.tool_input?.description || input.tool_input?.command || ''
const turn = input.turn_id || Date.now().toString(36)
const req = `${turn}-${Math.random().toString(36).slice(2, 8)}`
console.log(JSON.stringify({ tool, toolInput, desc, req }))
NODE
)

tool_name=$(printf '%s' "$parsed" | node -e 'process.stdin.on("data",d=>{const x=JSON.parse(d); process.stdout.write(x.tool)})')
input_preview=$(printf '%s' "$parsed" | node -e 'process.stdin.on("data",d=>{const x=JSON.parse(d); process.stdout.write(x.toolInput)})')
description=$(printf '%s' "$parsed" | node -e 'process.stdin.on("data",d=>{const x=JSON.parse(d); process.stdout.write(x.desc)})')
request_id=$(printf '%s' "$parsed" | node -e 'process.stdin.on("data",d=>{const x=JSON.parse(d); process.stdout.write(x.req)})')

home="${CCP_HOME:-$HOME/.ccp}"
peer="$CCP_SUPERVISOR"
me=$(
  CCP_NAME_VALUE="${CCP_NAME:-}" CCP_HOME_VALUE="$home" CCP_SUPERVISOR_VALUE="$peer" node <<'NODE'
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
    if (rec.meta?.supervisor === process.env.CCP_SUPERVISOR_VALUE) {
      matches.push({ rec, mtime: fs.statSync(full).mtimeMs })
    }
  }
} catch {}
matches.sort((a, b) => b.mtime - a.mtime)
process.stdout.write(matches[0]?.rec?.name || `${require('os').hostname().split('.')[0]}-${process.pid}`)
NODE
)
registry="$home/registry/${peer}.json"
verdict_file="$home/permissions/${me}/${request_id}.json"
timeout="${CCP_PERMISSION_TIMEOUT_SEC:-120}"

[ -f "$registry" ] || exit 0

url=$(node -e 'const fs=require("fs"); const p=process.argv[1]; try { process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).url || "") } catch {}' "$registry")
[ -z "$url" ] && exit 0

body=$(
  FROM="$me" REQUEST_ID="$request_id" TOOL_NAME="$tool_name" DESCRIPTION="$description" INPUT_PREVIEW="$input_preview" node <<'NODE'
const body = {
  from: process.env.FROM,
  request_id: process.env.REQUEST_ID,
  tool_name: process.env.TOOL_NAME,
  description: process.env.DESCRIPTION || '',
  input_preview: process.env.INPUT_PREVIEW || '',
}
process.stdout.write(JSON.stringify(body))
NODE
)

curl -sS -m 5 -X POST -H 'Content-Type: application/json' -d "$body" "$url/permission/request" >/dev/null 2>&1 || exit 0

deadline=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f "$verdict_file" ]; then
    behavior=$(node -e 'const fs=require("fs"); const p=process.argv[1]; try { process.stdout.write(JSON.parse(fs.readFileSync(p,"utf8")).behavior || "") } catch {}' "$verdict_file")
    rm -f "$verdict_file"
    if [ "$behavior" = "allow" ] || [ "$behavior" = "deny" ]; then
      BEHAVIOR="$behavior" node <<'NODE'
const behavior = process.env.BEHAVIOR
const out = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: behavior === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by CCP supervisor peer.' },
  },
}
process.stdout.write(JSON.stringify(out))
NODE
      exit 0
    fi
  fi
  sleep 1
done

exit 0
