---
description: Claude Code channels peer — manage and send to peer rooms
argument-hint: <subcommand> [args...]
allowed-tools:
  - mcp__cccp-inbox__create_room
  - mcp__cccp-inbox__join_room
  - mcp__cccp-inbox__leave_room
  - mcp__cccp-inbox__list_rooms
  - mcp__cccp-inbox__send_to_room
  - mcp__cccp-inbox__list_peers
---

Arguments: `$ARGUMENTS`. The first token is a subcommand:

- `list` — call `list_rooms` and present rooms + members as a short table.
- `create <name> [members...]` — call `create_room` with the given name; pass any extra tokens as `members`.
- `join <name>` — call `join_room`.
- `leave <name>` — call `leave_room`.
- `send <name> <message>` — call `send_to_room`. Choose the kind the same way `/cccp-broadcast` does: action language → `kind="task"`, FYI → `kind="note"`.

If `$ARGUMENTS` is empty or the subcommand is missing, call `list_rooms` and ask the user what they want to do.

For `send` with `kind="task"`, after issuing the call, tell the user the broadcast `task_id` and wait — replies will arrive as channel notifications. Do not poll.
