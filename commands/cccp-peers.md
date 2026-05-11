---
description: Claude Code channels peer
allowed-tools:
  - mcp__cccp-inbox__list_peers
---

Call the `list_peers` MCP tool from the `cccp-inbox` server and present the result as a short table (name, url, uptime). If empty, tell the user no other CCCP instances are running and remind them to start another `claude` session that has the cccp plugin enabled.
