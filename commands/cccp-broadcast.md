---
description: Claude Code channels peer — broadcast a task or note to multiple peers
argument-hint: <peers|*> <message>
allowed-tools:
  - mcp__cccp-inbox__send_to_peers
  - mcp__cccp-inbox__list_peers
---

Arguments: `$ARGUMENTS`. The first token is either:
- a comma-separated list of peer names (`alice,bob,carol`), or
- the literal `*` to address every alive peer except yourself.

The remaining text is the message body.

Steps:
1. Parse `$ARGUMENTS`. If empty or missing the message, call `list_peers` and ask the user which peers + what to send.
2. Decide the kind:
   - If the message is an action request ("run", "build", "find", "check", "look at", "fix", "investigate", a question that needs an answer), use `kind="task"`.
   - Otherwise use `kind="note"`.
3. Call `send_to_peers` with `to=<array or "*">`, `content=<message>`, the chosen `kind`. Capture the returned `task_id`.
4. Tell the user: "Broadcast to <peers> with task_id=<id>. I'll continue as replies arrive as `<channel>` events." For `kind="task"`, stop and wait — replies will arrive automatically as channel notifications with `kind="reply"` and the same `task_id`. Do not poll. As each reply arrives, fold it into your running answer.
