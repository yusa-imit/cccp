---
description: Claude Code channels peer
argument-hint: <peer> <message>
allowed-tools:
  - mcp__cccp-inbox__send_to_peer
  - mcp__cccp-inbox__list_peers
---

Arguments: `$ARGUMENTS` (first whitespace-separated token is the peer name, the rest is the message body).

Steps:
1. Parse `$ARGUMENTS`. If empty or missing message, call `list_peers` and ask the user which peer + what to send.
2. Call `send_to_peer` with `to=<peer>`, `content=<message>`, `kind="note"`.
3. Confirm to the user that the note was delivered, including the returned `task_id`.

This is fire-and-forget: do NOT wait for a reply. For round-trip delegation, use `/cccp-delegate` instead.
