---
description: Claude Code channels peer
argument-hint: <peer> <task>
allowed-tools:
  - mcp__cccp-inbox__send_to_peer
  - mcp__cccp-inbox__list_peers
---

Arguments: `$ARGUMENTS` (first token = peer name, rest = task description).

Steps:
1. Parse `$ARGUMENTS`. If incomplete, call `list_peers` and ask the user to pick a peer + describe the task.
2. Call `send_to_peer` with `to=<peer>`, `kind="task"`, `content=<task description, framed as a clear instruction to a peer agent>`. Capture the returned `task_id`.
3. Tell the user: "Delegated to <peer> with task_id=<id>. I'll continue when their reply arrives as a `<channel>` event." Then stop and wait — do NOT spin or poll. The reply will arrive automatically as a channel notification with `kind="reply"` and the same `task_id`.
4. When the reply arrives (you'll see it as `<channel source="cccp-inbox" sender="<peer>" kind="reply" task_id="<id>">…`), incorporate it into your response to the user.
