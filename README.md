# ccp — Codex channels peer

> **Languages**: **English** (this file) · [한국어](./README.ko.md)

A Codex plugin that lets multiple local Codex sessions discover each other,
send notes, delegate tasks, fetch replies, and optionally relay approval
requests to a supervisor peer.

Each session runs a local MCP server (`ccp-inbox`). Peers discover each other
through `~/.ccp/registry/`. Inbound messages are queued in the receiving
session's inbox until Codex calls `fetch_messages`.

## Requirements

- macOS or Linux on `darwin-arm64`, `darwin-x64`, `linux-x64`, or `linux-arm64`
- Codex with MCP, plugin, skill, and hook support
- Either a prebuilt `ccp-inbox` binary or Bun 1.x on PATH

## Install

### As a Codex plugin

This repository is now a Codex plugin root:

```bash
codex plugin marketplace add /absolute/path/to/ccp
```

Then enable the plugin in `~/.codex/config.toml`:

```toml
[plugins."ccp@ccp-local"]
enabled = true
```

Restart the Codex CLI session after enabling the plugin so plugin MCP servers
are reloaded.

The Codex plugin files are:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks.json`
- `skills/ccp-protocol/SKILL.md`

### As a bare MCP server

Add this to `~/.codex/config.toml` or a trusted project `.codex/config.toml`:

```toml
[mcp_servers.ccp-inbox]
command = "/absolute/path/to/ccp/server/start.sh"
enabled = true
```

Or use the CLI:

```bash
codex mcp add ccp-inbox -- /absolute/path/to/ccp/server/start.sh
```

In Codex CLI v0.130, plugin `commands/` are not exposed as top-level slash
commands. Use natural language prompts such as "list CCP peers" or "fetch CCP
messages" instead of `/ccp-*` slash commands.

## Runtime Binary

`server/start.sh` resolves the server binary in this order:

1. `$CCP_BIN` if set
2. `server/dist/ccp-inbox-<os>-<arch>`
3. `server/dist/ccp-inbox`
4. If `bun` is on PATH, compile `server/inbox.ts` once
5. Otherwise, print a release download command

Build locally:

```bash
cd server
bun install
bun run build
```

Build all release targets:

```bash
cd server
bun run build:all
```

## Run Two Peers

Terminal 1:

```bash
codex -C /absolute/path/to/ccp \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="alice"'
```

Terminal 2:

```bash
codex -C /absolute/path/to/ccp \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="bob"'
```

When each session starts, its server writes a registry record such as
`~/.ccp/registry/alice.json`.

Note: setting `CCP_NAME=alice codex` in the shell may not propagate to Codex
MCP servers. Prefer the `-c mcp_servers.ccp-inbox.env.CCP_NAME=...` override
for CLI testing.

## Workflow

List peers:

```text
Use ccp-inbox list_peers and show me the CCP peer list.
```

Delegate work:

```text
Use ccp-inbox send_to_peer to send bob a task: find the 3 most recently modified files and report their names and mtimes.
```

The sender receives a `task_id`. The receiver must fetch queued messages:

```text
Fetch my CCP messages.
```

Codex should call `fetch_messages`, execute any `kind="task"` message, and
reply with `respond_to_peer({ task_id, content })`. The original sender can
then fetch messages to see the `kind="reply"` result.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `CCP_NAME` | Name of this instance. Defaults to `<hostname>-<pid>`. |
| `CCP_PORT` | Inbox HTTP port. Defaults to an OS-assigned free port. |
| `CCP_SUPERVISOR` | Peer name to relay Codex `PermissionRequest` hooks to. |
| `CCP_NOTIFY_ON_STOP` | Peer name to notify when this session stops. |
| `CCP_PERMISSION_TIMEOUT_SEC` | Seconds for the permission hook to wait for a supervisor verdict. Defaults to `120`. |
| `CCP_HOME` | Registry root. Defaults to `~/.ccp`. Mostly useful for tests. |

## Permission Relay

Start a supervisor:

```bash
codex -C /absolute/path/to/ccp \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="alice"'
```

Start a supervised session:

```bash
codex -C /absolute/path/to/ccp \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="bob"' \
  -c 'mcp_servers.ccp-inbox.env.CCP_SUPERVISOR="alice"'
```

When Codex in `bob` raises a permission request, `hooks/permission-request.sh`
posts a `perm-request` message to `alice`. Alice fetches messages, decides, and
calls:

```json
respond_permission({ "peer": "bob", "request_id": "...", "behavior": "allow" })
```

The verdict is written back for Bob's hook to consume.

## MCP Tools

- `fetch_messages({ clear? })`
- `send_to_peer({ to, content, kind?, task_id? })`
- `respond_to_peer({ task_id, content })`
- `list_peers()`
- `whoami()`
- `register({ name })`
- `respond_permission({ peer, request_id, behavior })`

Message kinds:

- `task`: the peer should perform real work and answer with `respond_to_peer`
- `reply`: answer to a delegated task
- `note`: passive information
- `perm-request`: permission request from a supervised peer
- `permission-verdict`: visibility note for a permission verdict

## HTTP Endpoints

| Path | Payload |
| --- | --- |
| `POST /msg` | `{ from, content, kind, task_id? }` |
| `POST /permission/request` | `{ from, request_id, tool_name, description, input_preview }` |
| `POST /permission/verdict` | `{ from, request_id, behavior }` |
| `GET /info` | this instance's metadata |
| `GET /peers` | discovered peers |

Every `POST` requires `from` to match a currently alive registered peer, except
loopback from the same instance.

## Tests

```bash
cd server
bun test
```

The tests cover peer discovery, sender gating, queued inbox delivery, register
renames, and the permission relay path.

## Limitations

- Same machine only. Discovery is filesystem-based and HTTP binds to
  `127.0.0.1`.
- Codex does not receive arbitrary MCP server notifications as new model turns.
  Peers must fetch messages with `fetch_messages`.
- Permission relay depends on Codex hook support and a waiting hook process.
