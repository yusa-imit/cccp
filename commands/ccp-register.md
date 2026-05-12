---
description: Codex channels peer
argument-hint: <name>
allowed-tools:
  - mcp__ccp-inbox__register
  - mcp__ccp-inbox__whoami
  - mcp__ccp-inbox__list_peers
---

Arguments: `$ARGUMENTS` (the new name for this instance).

Steps:
1. If `$ARGUMENTS` is empty, call `whoami` first to show the current name, then ask the user what they want to rename to.
2. Call `register({ name: <name> })`.
3. If it fails because the name is already taken by another live peer, run `list_peers` and ask the user to pick a different name.
4. On success, confirm the new name to the user. Other peers will see this session under the new name from now on — replies to messages they sent before the rename still arrive correctly because they're correlated by `task_id`, not name.
