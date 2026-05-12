---
name: ccp-protocol
description: Codex channels peer — the protocol for this session's participation in a multi-instance Codex mesh over MCP. Load this skill whenever the user asks you to talk to / delegate to / coordinate with / send a message to / fetch messages from / answer back to another Codex instance, peer, or session. Covers how to interpret each `kind` (task / reply / note / perm-request), which ccp-inbox tools to call (`fetch_messages`, `send_to_peer`, `respond_to_peer`, `list_peers`, `respond_permission`), how to thread replies with `task_id`, and the behavioral rules for never silently ignoring a fetched peer message.
---

# CCP Protocol

You are one node in a peer mesh of Codex instances. Each instance runs a `ccp-inbox` MCP server that:

- discovers other instances via `~/.ccp/registry/`
- queues peer messages until you call `fetch_messages`
- exposes tools so you can send messages back

## Critical: never ignore a fetched peer message silently

Every message returned by `fetch_messages` MUST produce a visible response in your terminal. Treat the message as if it were a message from your user with the peer's session observing. The user is watching to see what arrived and what you did with it.

## Message kinds

| kind | meaning | expected action |
|------|---------|-----------------|
| `task` | a peer is asking you to perform work | **execute the request** as you would for the user, then `respond_to_peer({ task_id, content })` with the result |
| `reply` | a peer is answering a task you delegated | integrate the content as the result of that delegation |
| `note` | passive information (FYI, status update) | tell the user it arrived; reply only if useful |
| `perm-request` | a peer wants you to approve their tool call | decide, then `respond_permission({ peer, request_id, behavior: "allow"\|"deny" })` |

A `task` kind means the peer is delegating real work. Do not just acknowledge it — actually perform the request: read files, run commands, write code, whatever the message asks. Then send the answer back via `respond_to_peer`.

## Available tools (ccp-inbox)

- `fetch_messages({ clear? })` — fetch queued inbound peer messages. Use this when the user asks whether peers replied, after delegating work, or before deciding that there is no peer response yet. The default clears returned messages.
- `send_to_peer({ to, content, kind?, task_id? })` — send to a discovered peer. Omit `task_id` for new threads; the server will generate one. **Always pick `kind` deliberately**: `task` for action requests (the peer will do work), `note` only for passive FYI. The default is conservative ("note") so if the user clearly wants the peer to act, you must specify `kind: "task"` explicitly.
- `respond_to_peer({ task_id, content })` — reply to an inbound task (the server remembers who originally sent it).
- `list_peers()` — names + URLs of all alive peers.
- `respond_permission({ peer, request_id, behavior })` — answer a peer's permission relay.

## Behavioral rules

1. **No silent receives.** Every fetched peer message surfaces in your output. If a `task` arrives, do the work and emit a response. If a `note` arrives, at minimum tell the user the message came in (sender, content).
2. **Always continue threads with the same `task_id`.** Peers correlate replies that way.
3. **`task` messages are real work, not just chat.** Treat them with the same rigor as a user request, except your "user" is another Codex session that needs a concrete answer.
4. **Pick the right kind when sending.** If the user says "have peer X do Y" / "ask peer X to run Y" / "tell peer X to find Y" → kind must be `"task"`. Sending a `"note"` will not cause the peer to act. When in doubt between task and note, choose `task`.
5. **When you delegate** (`send_to_peer` with `kind: "task"`), tell your own user what you delegated and to whom, including the `task_id`. Later, call `fetch_messages` when the user asks for replies or when you need to check progress. Do not spin in a tight poll loop.
6. **Permission relay** is high-trust. Only `allow` a peer's permission request if the tool + description clearly match what they should be doing. When in doubt, `deny` and tell the peer (via `send_to_peer`, kind `note`) why.
7. **Don't loop.** If you receive a `reply` whose `task_id` you don't recognize as one you originated, treat it as a `note` instead of triggering more work.

## Identifying yourself

Your instance name appears in the inbox server's startup log. Other peers see you under that name in their `list_peers` output. When you `send_to_peer`, the receiver sees `sender=<your-name>` in the fetched message automatically.
