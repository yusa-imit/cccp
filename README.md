# cccp — Claude Code channels peer

> **Languages**: **English** (this file) · [한국어](./README.ko.md)

A Claude Code plugin that lets multiple Claude Code instances talk to each
other: delegate work to a peer, get a reply back, and optionally relay
tool-approval prompts across sessions. Each session runs a local MCP **channel**
server (`cccp-inbox`); other instances auto-discover it through
`~/.cccp/registry/`; messages arrive in the receiving Claude's context as
`<channel source="cccp-inbox" sender="..." kind="..." task_id="...">` tags.

> **Requirements**: Claude Code v2.1.80+ (v2.1.81+ for permission relay), Bun
> 1.x, macOS or Linux.
>
> **Research preview**: custom channels are not on the approved allowlist, so
> sessions must be launched with `--dangerously-load-development-channels`.
>
> **Interactive mode only**: channel-driven turns require an interactive
> `claude` session. `-p`/headless mode receives the notification but does not
> trigger a new model turn — see [Limitations](#limitations).

---

## Install

### Prerequisites

- **macOS or Linux** on `darwin-arm64`, `darwin-x64`, `linux-x64`, or `linux-arm64`
- **Either** a prebuilt binary from the GitHub release **or** [Bun](https://bun.sh) 1.x on PATH (the wrapper compiles a binary on first run)
- Claude Code v2.1.80+

### Option A — install as a Claude Code plugin (recommended)

```bash
# inside Claude Code
/plugin marketplace add yusa-imit/cccp
/plugin install cccp@cccp
```

On the first session that launches the MCP server, `server/start.sh` resolves a
runtime binary in this order:

1. `$CCCP_BIN` if set
2. `server/dist/cccp-inbox-<os>-<arch>` (downloaded release asset)
3. `server/dist/cccp-inbox` (locally compiled)
4. If `bun` is on PATH, compile one now (one-time, ~5s)
5. Otherwise, fail with a `curl` command to fetch the release asset

To skip the bun-compile step, drop a prebuilt binary in place:

```bash
PLATFORM=darwin-arm64    # darwin-x64 | linux-x64 | linux-arm64
PLUGIN_DIR="$HOME/.claude/plugins/cache/cccp/cccp"     # adjust if version differs
mkdir -p "$PLUGIN_DIR"/*/server/dist
curl -L -o "$PLUGIN_DIR"/*/server/dist/cccp-inbox-${PLATFORM} \
  https://github.com/yusa-imit/cccp/releases/latest/download/cccp-inbox-${PLATFORM}
chmod +x "$PLUGIN_DIR"/*/server/dist/cccp-inbox-${PLATFORM}
```

### Option B — local clone

```bash
git clone https://github.com/yusa-imit/cccp.git
# inside Claude Code (from any project)
/plugin marketplace add /absolute/path/to/cccp
/plugin install cccp@cccp
```

### Option C — bare MCP server (no slash commands / skill / hook)

```bash
git clone https://github.com/yusa-imit/cccp.git
```

Add to `~/.claude.json` or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "cccp-inbox": {
      "command": "/absolute/path/to/cccp/server/start.sh"
    }
  }
}
```

### Launching with channels enabled

Every `claude` invocation that wants channel delivery needs the
development-channel opt-in:

```bash
# plugin install (Options A/B)
claude --dangerously-load-development-channels plugin:cccp@cccp

# bare MCP server (Option C)
claude --dangerously-load-development-channels server:cccp-inbox
```

The flag is required while channels are in research preview.

### Building binaries yourself

```bash
cd server
bun install
bun run build              # current platform → dist/cccp-inbox
bun run build:all          # all 4 supported platforms
```

The GitHub Actions workflow at [`.github/workflows/release.yml`](./.github/workflows/release.yml)
builds and attaches all four binaries to a Release whenever a tag matching
`v*` is pushed.

---

## Run (two-instance scenario)

### Terminal 1 — alice

```bash
CCCP_NAME=alice claude --dangerously-load-development-channels plugin:cccp@cccp
```

When the session boots, `~/.cccp/registry/alice.json` is written and the inbox
HTTP server starts listening on an OS-assigned port.

### Terminal 2 — bob

```bash
CCCP_NAME=bob claude --dangerously-load-development-channels plugin:cccp@cccp
```

The two instances now discover each other.

### First exchange

In alice's session:

```
/cccp-peers
```

Alice calls `list_peers` and shows `bob`.

```
/cccp-delegate bob find the 3 most recently modified files in this directory and tell me their names and mtimes
```

Alice sends a `task` message to bob. The following tag arrives in bob's
context:

```
<channel source="cccp-inbox" sender="alice" kind="task" task_id="alice-...">
find the 3 most recently modified files ...
</channel>
```

Bob's Claude auto-loads the `cccp-protocol` skill, executes the request, then
calls `respond_to_peer({ task_id, content })`. The result lands in alice's
context as `<channel ... kind="reply" task_id="...">`, and alice's Claude
summarizes it for the user.

---

## Environment variables

| Variable              | Purpose                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCCP_NAME`           | Name of this instance. Defaults to `<hostname>-<pid>`.                                                                                                           |
| `CCCP_PORT`           | Inbox HTTP port. Defaults to an OS-assigned free port.                                                                                                           |
| `CCCP_SUPERVISOR`     | Peer name to relay tool-permission prompts to. When set, every Claude Code tool-approval dialog is forwarded to that peer.                                       |
| `CCCP_NOTIFY_ON_STOP` | Peer name to notify on session end via the Stop hook (sends a `kind=note` message).                                                                              |
| `CCCP_HOME`           | Override the registry root. Defaults to `~/.cccp`. Mostly useful for tests.                                                                                      |

---

## Permission relay (supervisor pattern)

To have alice approve every dangerous tool call bob attempts:

```bash
# alice (supervisor)
CCCP_NAME=alice \
  claude --dangerously-load-development-channels plugin:cccp@cccp

# bob (supervised)
CCCP_NAME=bob CCCP_SUPERVISOR=alice \
  claude --dangerously-load-development-channels plugin:cccp@cccp
```

When bob's Claude tries to use, say, `Bash`:

1. Bob's local approval dialog opens.
2. Concurrently, alice receives `<channel kind="perm-request" request_id="..." tool_name="Bash" ...>`.
3. Alice answers with `respond_permission({ peer: "bob", request_id: "...", behavior: "allow" })`.
4. Bob's dialog auto-closes and the tool runs.

Whichever side answers first wins (local terminal vs. remote peer).

---

## Protocol summary

### Channel tag (receiver side)

```
<channel source="cccp-inbox" sender="<peer>" kind="task|reply|note|perm-request" task_id="..."[, ...]>
body
</channel>
```

### MCP tools (each instance calls these on its own inbox)

- `send_to_peer({ to, content, kind?, task_id? })`
- `respond_to_peer({ task_id, content })`
- `list_peers()`
- `whoami()` — this instance's current name and URL
- `register({ name })` — rename this instance at runtime (slash command: `/cccp-register <name>`). Lets you skip the `CCCP_NAME` env var.
- `respond_permission({ peer, request_id, behavior })`

### HTTP endpoints (inbox-to-inbox traffic)

| Path                       | Payload                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `POST /msg`                | `{ from, content, kind, task_id? }`                                              |
| `POST /permission/request` | `{ from, request_id, tool_name, description, input_preview }`                    |
| `POST /permission/verdict` | `{ from, request_id, behavior }`                                                 |
| `GET /info`                | this instance's metadata                                                         |
| `GET /peers`               | discovered peers                                                                 |

Every `POST` requires `from` to match a **currently-alive registered peer**
(sender allowlist; loopback from self is also allowed).

---

## Tests

```bash
cd server
bun test
```

23 tests: 13 unit (registry) + 10 integration (spawns real inbox processes,
verifies HTTP routing, sender gating, channel notification emission, and the
full inbound/outbound permission-relay loop).

---

## Debugging

```bash
# inspect the live registry
ls ~/.cccp/registry/
cat ~/.cccp/registry/alice.json

# push a message manually (only works as a registered peer or via loopback)
curl -X POST http://127.0.0.1:<port>/msg \
  -H 'Content-Type: application/json' \
  -d '{"from":"alice","kind":"note","content":"manual test"}'

# inside a Claude Code session
/mcp                  # check cccp-inbox status
```

The inbox server's stderr is captured by Claude Code into
`~/.claude/debug/<session-id>.txt`.

### Stale plugin cache gotcha

`/plugin install cccp@cccp` snapshots a copy under
`~/.claude/plugins/cache/cccp/cccp/<version>/`. If you edit files in your
working copy, the cached copy is **not** automatically refreshed. Either
reinstall, or launch with `--plugin-dir /path/to/cccp` to load from the live
directory:

```bash
claude --plugin-dir /absolute/path/to/cccp \
       --dangerously-load-development-channels plugin:cccp@inline
```

---

## Limitations

- **Interactive mode only.** Channel notifications are routed into the model's
  context as new turns only in interactive `claude` sessions. In `-p`
  (`--print`) or SDK streaming mode the inbox still receives the POST, but
  the session ends after the first model turn and the inbound channel event
  never produces a new response. Tested directly; see commit history.
- **Same machine only.** Discovery is filesystem-based (`~/.cccp/registry/`)
  and the HTTP server listens on `127.0.0.1`. Cross-machine support is future
  work.
- **Sender trust model.** Any process running under the same user can register
  itself as a peer and post messages. Multi-user environments need additional
  authentication.
- **No shared context.** Each instance keeps its own transcript and memory.
  The message body is the only information channel.
- **Research-preview gate.** `--dangerously-load-development-channels` is
  required until the plugin is added to the official Anthropic allowlist.

---

## License

MIT.
