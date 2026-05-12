---
description: Codex channels peer
argument-hint: <peer> <task>
allowed-tools:
  - mcp__ccp-inbox__send_to_peer
  - mcp__ccp-inbox__list_peers
  - mcp__ccp-inbox__fetch_messages
---

Arguments: `$ARGUMENTS` (first token = peer name, rest = task description).

Steps:
1. Parse `$ARGUMENTS`. If incomplete, call `list_peers` and ask the user to pick a peer + describe the task.
2. Call `send_to_peer` with `to=<peer>`, `kind="task"`, `content=<task description, framed as a clear instruction to a peer agent>`. Capture the returned `task_id`.
3. Tell the user: "Delegated to <peer> with task_id=<id>. Ask me to fetch peer replies when you want to check the inbox."
4. When the user asks for replies, call `fetch_messages` and incorporate any `kind="reply"` message with the same `task_id`.
