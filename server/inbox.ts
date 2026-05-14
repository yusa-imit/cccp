#!/usr/bin/env bun
/**
 * CCCP Inbox — Claude Code instance-to-instance channel server.
 *
 * Role: MCP server with `claude/channel` and `claude/channel/permission`
 * capabilities. Each Claude Code session that loads this plugin spawns its own
 * inbox; instances discover each other via ~/.cccp/registry/.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  createRoom,
  defaultName,
  findPeer,
  getRoom,
  joinRoom,
  leaveRoom,
  listPeers,
  listRooms,
  registerSelf,
} from './lib/registry.ts'

let NAME = defaultName()
const VERSION = '0.2.0'
const SUPERVISOR = process.env.CCCP_SUPERVISOR?.trim() || ''

const log = (...args: unknown[]) => console.error('[cccp:' + NAME + ']', ...args)

// ---------------------------------------------------------------------------
// MCP server (channel)
// ---------------------------------------------------------------------------
const instructions = [
  `You are running as Claude Code instance "${NAME}" in a peer mesh of Claude Code sessions.`,
  '',
  '## Receiving messages',
  'Inbound peer messages arrive as <channel source="cccp-inbox" sender="..." kind="..." task_id="..." [parent_task_id="..."] [room="..."]>body</channel>.',
  '',
  'CRITICAL: every inbound channel message MUST produce a visible response in this session.',
  'Never silently ignore a channel event. At a minimum, surface the message in your reply to the user.',
  'Treat the channel event as if it were a user message from the peer, with the user observing.',
  '',
  'Kind semantics (what to DO):',
  '  task         — A peer is asking you to perform real work. Execute the request as you would for the user, then call respond_to_peer({ task_id, content }) with the result. The content of the message is an instruction; carry it out.',
  '  reply        — A peer is answering a task you delegated. Integrate the content into your ongoing response to the user.',
  '  note         — Informational only (no action expected from the peer). Still tell the user it arrived. Reply only if useful.',
  '  perm-request — A peer wants you (or the user at this terminal) to approve their tool call. Decide allow vs deny based on the tool_name and description, then call respond_permission({ peer, request_id, behavior }).',
  '',
  'Threading: when an inbound message carries parent_task_id, you are inside a sub-task chain. If you delegate or broadcast further work to handle this task, pass parent_task_id=<this message\'s task_id> on those outbound calls so the chain stays linked. When you reply, use respond_to_peer with the ORIGINAL task_id of the message you received.',
  '',
  'Rooms: when an inbound message carries room="<name>", multiple peers received the same broadcast. Replies still go to the original sender via respond_to_peer (not to the whole room). Use send_to_room only when you intentionally want to fan a message out to all members of a room.',
  '',
  'Always echo task_id when continuing a thread so peers can correlate.',
  '',
  '## Sending messages',
  'Tools (from the cccp-inbox MCP server):',
  '  send_to_peer({ to, content, kind?, task_id?, parent_task_id? })',
  '    - Use kind="task" when the user (or you) wants the peer to actually DO something — "run", "build", "find", "fix", "check", "look at", etc. THIS IS THE DEFAULT FOR ACTION-ORIENTED MESSAGES.',
  '    - Use kind="note" only for genuinely passive information ("FYI", "I finished X", status updates).',
  '    - Use kind="reply" only when answering a specific inbound task (prefer respond_to_peer instead).',
  '  send_to_peers({ to, content, kind?, task_id?, parent_task_id? }) — fan-out to multiple peers. `to` is either a string array of peer names OR the literal "*" to broadcast to every alive peer except yourself. All recipients share the same task_id, so their replies merge into one thread.',
  '  send_to_room({ room, content, kind?, task_id?, parent_task_id? }) — broadcast to all alive members of a room (except yourself). The receivers see room="<name>" on the channel tag.',
  '  respond_to_peer({ task_id, content }) — convenience reply to the original sender of a task you received.',
  '  list_peers() — list currently alive peer instances.',
  '  list_rooms() — list known rooms and their members.',
  '  create_room({ name, members? }) — create a new room; this instance is added as a member automatically.',
  '  join_room({ name }) — add this instance to a room (creates the room if it does not exist).',
  '  leave_room({ name }) — remove this instance from a room (deletes the room if no members remain).',
  '  whoami() — this instance\'s current registered name.',
  '  register({ name }) — change this instance\'s name in the registry (so peers see it under the new name). Use when the user wants to rename / register the session at runtime instead of relying on the CCCP_NAME env var.',
  '  respond_permission({ peer, request_id, behavior }) — answer a peer\'s permission relay.',
  '',
  'When the user tells you to "tell / ask / have / make peer X do Y" or "send X to peer Y to run/build/check Z",',
  'use kind="task" — that is the only kind that causes the peer to do work.',
  'When the user says "broadcast", "send to everyone", "ask all peers", or "ask the team / room <name>", prefer send_to_peers or send_to_room rather than looping send_to_peer.',
].join('\n')

const mcp = new Server(
  { name: 'cccp-inbox', version: VERSION },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions,
  },
)

// Tracks task threads we originated, so the model can `respond_to_peer`
// without remembering the original sender.
const inboundTaskOrigins = new Map<string, string>() // task_id -> sender name

// Tracks permission requests this instance forwarded to a supervisor peer,
// so we know which peer to expect the verdict from.
const pendingPermissionRelays = new Map<string, string>() // request_id -> peer name

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCCP-Sender': NAME },
    body: JSON.stringify(body),
  })
}

function escapeAttr(v: string) {
  return v.replace(/"/g, '&quot;')
}

async function pushChannel(content: string, meta: Record<string, string>) {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  })
}

function newTaskId() {
  return `${NAME}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

type SendOpts = {
  content: string
  kind: string
  task_id: string
  parent_task_id?: string
  room?: string
}

async function deliverTo(peerName: string, opts: SendOpts): Promise<{ ok: boolean; status: number; error?: string }> {
  const peer = findPeer(peerName)
  if (!peer) return { ok: false, status: 0, error: 'not alive' }
  try {
    const body: Record<string, unknown> = {
      from: NAME,
      content: opts.content,
      kind: opts.kind,
      task_id: opts.task_id,
    }
    if (opts.parent_task_id) body.parent_task_id = opts.parent_task_id
    if (opts.room) body.room = opts.room
    const res = await postJSON(`${peer.url}/msg`, body)
    if (!res.ok) return { ok: false, status: res.status, error: await res.text() }
    return { ok: true, status: res.status }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? String(err) }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_to_peer',
      description:
        'Send a message to a single peer Claude Code instance. CHOOSE KIND CAREFULLY: use kind="task" when you want the peer to actually do work (run a command, find/build/check something, answer a question). Use kind="note" ONLY for passive information ("FYI…", status updates) — notes do NOT cause the peer to act. If you are unsure, prefer kind="task". To fan out to multiple peers, use send_to_peers; to address a room, use send_to_room.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target peer name (see list_peers).' },
          content: { type: 'string', description: 'Message body.' },
          kind: {
            type: 'string',
            enum: ['task', 'reply', 'note'],
            description: 'Message intent. Default "note".',
          },
          task_id: {
            type: 'string',
            description: 'Correlation id. Required for replies; auto-generated for new tasks.',
          },
          parent_task_id: {
            type: 'string',
            description:
              'Optional parent thread id. Set this when the new message is a sub-task of an inbound task you received — pass that inbound task\'s task_id here so the receiver can see the chain.',
          },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'send_to_peers',
      description:
        'Broadcast the same message to multiple peers at once. All recipients receive an identical task_id, so their replies merge into one thread on your side. Use this instead of looping send_to_peer when the user says "ask everyone", "broadcast", or names multiple peers.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            description:
              'Either an array of peer names, or the literal string "*" to address every alive peer except yourself.',
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string', enum: ['*'] },
            ],
          },
          content: { type: 'string', description: 'Message body.' },
          kind: {
            type: 'string',
            enum: ['task', 'reply', 'note'],
            description: 'Message intent. Default "note".',
          },
          task_id: {
            type: 'string',
            description: 'Shared correlation id; auto-generated if omitted.',
          },
          parent_task_id: {
            type: 'string',
            description: 'Optional parent thread id (see send_to_peer).',
          },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'send_to_room',
      description:
        'Broadcast a message to all currently-alive members of a room (except yourself). Receivers see room="<name>" on the inbound channel tag.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Room name (see list_rooms).' },
          content: { type: 'string', description: 'Message body.' },
          kind: {
            type: 'string',
            enum: ['task', 'reply', 'note'],
            description: 'Message intent. Default "note".',
          },
          task_id: {
            type: 'string',
            description: 'Shared correlation id; auto-generated if omitted.',
          },
          parent_task_id: {
            type: 'string',
            description: 'Optional parent thread id (see send_to_peer).',
          },
        },
        required: ['room', 'content'],
      },
    },
    {
      name: 'create_room',
      description:
        'Create a new room. The current instance is added as a member automatically. Optionally provide an initial list of other peer names to add as members. Fails if a room with that name already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Room name. Allowed characters: letters, digits, underscore, hyphen, dot. 1-64 chars.',
          },
          members: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional peer names to add as initial members.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'join_room',
      description:
        'Add this instance to a room. Creates the room if it does not exist (with this instance as the sole member and owner).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Room name.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'leave_room',
      description:
        'Remove this instance from a room. If no members remain, the room is deleted.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Room name.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_rooms',
      description:
        'List all rooms known on this machine and their members. Membership persists across sessions until a peer explicitly leaves the room.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'respond_to_peer',
      description:
        'Reply to the most recent inbound task with a given task_id. The peer who originally sent the task receives this as kind="reply".',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'task_id of the inbound task you are answering.' },
          content: { type: 'string', description: 'Reply body.' },
        },
        required: ['task_id', 'content'],
      },
    },
    {
      name: 'list_peers',
      description: 'List currently alive peer instances discovered via ~/.cccp/registry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'whoami',
      description: 'Return this instance\'s current registered name and URL.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'register',
      description:
        'Rename this instance in the peer registry. Replaces whatever name was set via CCCP_NAME (or auto-generated) so other peers see this session under the new name. Fails if another alive peer already holds that name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'New name for this instance. Allowed characters: letters, digits, underscore, hyphen, dot. Names with other characters are sanitized.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'respond_permission',
      description:
        'Respond to a permission request that a peer forwarded to this session. Sends an allow/deny verdict back to the originating peer, which will resolve their pending tool-approval dialog.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'The peer who asked for permission.' },
          request_id: { type: 'string', description: 'request_id from the perm-request message.' },
          behavior: { type: 'string', enum: ['allow', 'deny'] },
        },
        required: ['peer', 'request_id', 'behavior'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send_to_peer': {
        const to = String(args.to ?? '')
        const content = String(args.content ?? '')
        const kind = (args.kind as string) || 'note'
        const task_id = (args.task_id as string) || newTaskId()
        const parent_task_id = (args.parent_task_id as string) || undefined
        const result = await deliverTo(to, { content, kind, task_id, parent_task_id })
        if (!result.ok)
          return toolErr(`peer ${to} delivery failed (${result.status || 'offline'}): ${result.error ?? ''}`)
        return toolOk(
          `sent kind=${kind} task_id=${task_id}${parent_task_id ? ` parent_task_id=${parent_task_id}` : ''} to ${to}`,
        )
      }

      case 'send_to_peers': {
        const rawTo = args.to
        const content = String(args.content ?? '')
        const kind = (args.kind as string) || 'note'
        const task_id = (args.task_id as string) || newTaskId()
        const parent_task_id = (args.parent_task_id as string) || undefined

        let targets: string[]
        if (rawTo === '*') {
          targets = listPeers(NAME).map((p) => p.name)
        } else if (Array.isArray(rawTo)) {
          targets = (rawTo as unknown[]).map((v) => String(v)).filter((v) => v && v !== NAME)
        } else {
          return toolErr('to must be a string array or the literal "*"')
        }
        if (targets.length === 0) return toolErr('no peers to send to (all peers offline or list empty)')

        const results = await Promise.all(
          targets.map(async (name) => ({ name, ...(await deliverTo(name, { content, kind, task_id, parent_task_id })) })),
        )
        const ok = results.filter((r) => r.ok).map((r) => r.name)
        const failed = results.filter((r) => !r.ok)
        const lines: string[] = []
        lines.push(`broadcast kind=${kind} task_id=${task_id}${parent_task_id ? ` parent_task_id=${parent_task_id}` : ''}`)
        lines.push(`delivered: ${ok.length ? ok.join(', ') : '(none)'}`)
        if (failed.length)
          lines.push(`failed: ${failed.map((f) => `${f.name} (${f.error ?? f.status})`).join(', ')}`)
        return failed.length && ok.length === 0 ? toolErr(lines.join('\n')) : toolOk(lines.join('\n'))
      }

      case 'send_to_room': {
        const room_name = String(args.room ?? '')
        const content = String(args.content ?? '')
        const kind = (args.kind as string) || 'note'
        const task_id = (args.task_id as string) || newTaskId()
        const parent_task_id = (args.parent_task_id as string) || undefined
        const room = getRoom(room_name)
        if (!room) return toolErr(`room not found: ${room_name}. Try list_rooms or create_room.`)
        const alivePeers = new Set(listPeers().map((p) => p.name))
        const targets = room.members.filter((m) => m !== NAME && alivePeers.has(m))
        const offline = room.members.filter((m) => m !== NAME && !alivePeers.has(m))
        if (targets.length === 0)
          return toolErr(
            `no alive recipients in room "${room_name}" (members: ${room.members.join(', ') || '(none)'})`,
          )
        const results = await Promise.all(
          targets.map(async (name) => ({
            name,
            ...(await deliverTo(name, { content, kind, task_id, parent_task_id, room: room_name })),
          })),
        )
        const ok = results.filter((r) => r.ok).map((r) => r.name)
        const failed = results.filter((r) => !r.ok)
        const lines: string[] = []
        lines.push(
          `room=${room_name} kind=${kind} task_id=${task_id}${parent_task_id ? ` parent_task_id=${parent_task_id}` : ''}`,
        )
        lines.push(`delivered: ${ok.length ? ok.join(', ') : '(none)'}`)
        if (failed.length)
          lines.push(`failed: ${failed.map((f) => `${f.name} (${f.error ?? f.status})`).join(', ')}`)
        if (offline.length) lines.push(`offline members skipped: ${offline.join(', ')}`)
        return failed.length && ok.length === 0 ? toolErr(lines.join('\n')) : toolOk(lines.join('\n'))
      }

      case 'create_room': {
        const room_name = String(args.name ?? '')
        const members = Array.isArray(args.members)
          ? (args.members as unknown[]).map((v) => String(v))
          : []
        try {
          const rec = createRoom(room_name, NAME, members)
          return toolOk(`created room "${rec.name}" with members: ${rec.members.join(', ')}`)
        } catch (err: any) {
          return toolErr(err?.message ?? String(err))
        }
      }

      case 'join_room': {
        const room_name = String(args.name ?? '')
        try {
          const rec = joinRoom(room_name, NAME)
          return toolOk(`joined room "${rec.name}" — members: ${rec.members.join(', ')}`)
        } catch (err: any) {
          return toolErr(err?.message ?? String(err))
        }
      }

      case 'leave_room': {
        const room_name = String(args.name ?? '')
        const rec = leaveRoom(room_name, NAME)
        if (!rec) return toolErr(`room not found: ${room_name}`)
        if (rec.members.length === 0) return toolOk(`left and deleted room "${room_name}" (no members remaining)`)
        return toolOk(`left room "${room_name}" — remaining members: ${rec.members.join(', ')}`)
      }

      case 'list_rooms': {
        const rooms = listRooms()
        if (rooms.length === 0) return toolOk('no rooms')
        return toolOk(
          rooms
            .map((r) => `- ${r.name}  members=[${r.members.join(', ')}]  createdBy=${r.createdBy}`)
            .join('\n'),
        )
      }

      case 'respond_to_peer': {
        const task_id = String(args.task_id ?? '')
        const content = String(args.content ?? '')
        const origin = inboundTaskOrigins.get(task_id)
        if (!origin) return toolErr(`no inbound task with task_id=${task_id}`)
        const result = await deliverTo(origin, { content, kind: 'reply', task_id })
        if (!result.ok)
          return toolErr(`reply to ${origin} failed (${result.status || 'offline'}): ${result.error ?? ''}`)
        return toolOk(`reply sent to ${origin} for task_id=${task_id}`)
      }

      case 'list_peers': {
        const peers = listPeers(NAME)
        return toolOk(
          peers.length === 0
            ? 'no other instances alive'
            : peers
                .map(
                  (p) =>
                    `- ${p.name}  ${p.url}  pid=${p.pid}  uptime=${Math.round((Date.now() - p.startedAt) / 1000)}s`,
                )
                .join('\n'),
        )
      }

      case 'whoami': {
        return toolOk(`${NAME}  ${url}  pid=${process.pid}`)
      }

      case 'register': {
        const requested = String(args.name ?? '').trim()
        if (!requested) return toolErr('name is required')
        if (requested === NAME) return toolOk(`already registered as "${NAME}"`)
        const collision = listPeers().find((p) => p.name === requested && p.pid !== process.pid)
        if (collision)
          return toolErr(
            `cannot register as "${requested}": already in use by pid=${collision.pid} at ${collision.url}`,
          )
        const previous = NAME
        NAME = requested
        try {
          reregister()
        } catch (err: any) {
          NAME = previous
          reregister()
          return toolErr(`re-register failed: ${err?.message ?? String(err)}`)
        }
        log(`renamed: "${previous}" → "${NAME}"`)
        return toolOk(`registered as "${NAME}" (was "${previous}")`)
      }

      case 'respond_permission': {
        const peer_name = String(args.peer ?? '')
        const request_id = String(args.request_id ?? '')
        const behavior = String(args.behavior ?? '')
        if (behavior !== 'allow' && behavior !== 'deny')
          return toolErr('behavior must be allow|deny')
        const peer = findPeer(peer_name)
        if (!peer) return toolErr(`peer not found: ${peer_name}`)
        const res = await postJSON(`${peer.url}/permission/verdict`, {
          from: NAME,
          request_id,
          behavior,
        })
        if (!res.ok) return toolErr(`peer ${peer_name} returned ${res.status}`)
        return toolOk(`verdict "${behavior}" sent to ${peer_name} for ${request_id}`)
      }
    }
    return toolErr(`unknown tool: ${req.params.name}`)
  } catch (err: any) {
    return toolErr(`error: ${err?.message ?? String(err)}`)
  }
})

function toolOk(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
function toolErr(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

// ---------------------------------------------------------------------------
// Permission relay (outbound) — when Claude Code asks THIS server for approval
// ---------------------------------------------------------------------------
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!SUPERVISOR) {
    log('permission_request', params.request_id, '— no CCCP_SUPERVISOR set, ignoring')
    return
  }
  const peer = findPeer(SUPERVISOR)
  if (!peer) {
    log('permission_request', params.request_id, `— supervisor ${SUPERVISOR} not alive`)
    return
  }
  pendingPermissionRelays.set(params.request_id, SUPERVISOR)
  await postJSON(`${peer.url}/permission/request`, {
    from: NAME,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  }).catch((e) => log('relay POST failed:', e))
})

// ---------------------------------------------------------------------------
// HTTP listener — inbound from other instances
// ---------------------------------------------------------------------------
const started = Date.now()
const server = Bun.serve({
  port: Number(process.env.CCCP_PORT ?? 0),
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/info') {
      return Response.json({
        name: NAME,
        version: VERSION,
        capabilities: ['channel', 'channel-permission'],
        startedAt: started,
      })
    }
    if (req.method === 'GET' && url.pathname === '/peers') {
      return Response.json(listPeers(NAME))
    }

    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

    let body: any
    try {
      body = await req.json()
    } catch {
      return new Response('bad json', { status: 400 })
    }

    // Sender gating: only accept messages whose `from` is a known live peer,
    // OR loopback (so curl-based manual testing from this machine works).
    const from = String(body?.from ?? '').trim()
    if (!from) return new Response('missing from', { status: 400 })
    const senderAlive = listPeers().some((p) => p.name === from) || from === NAME
    if (!senderAlive) {
      log('rejected message from unknown sender:', from)
      return new Response('unknown sender', { status: 403 })
    }

    if (url.pathname === '/msg') {
      const content = String(body.content ?? '')
      const kind = String(body.kind ?? 'note')
      const task_id = String(body.task_id ?? '')
      const parent_task_id = body.parent_task_id ? String(body.parent_task_id) : ''
      const room = body.room ? String(body.room) : ''
      log(
        `/msg accepted: from=${from} kind=${kind} task_id=${task_id}` +
          (parent_task_id ? ` parent_task_id=${parent_task_id}` : '') +
          (room ? ` room=${room}` : ''),
      )
      if (kind === 'task' && task_id) inboundTaskOrigins.set(task_id, from)
      await pushChannel(content, {
        sender: from,
        kind,
        ...(task_id ? { task_id } : {}),
        ...(parent_task_id ? { parent_task_id } : {}),
        ...(room ? { room } : {}),
      })
      log(`/msg notification pushed to Claude (sender=${from} kind=${kind})`)
      // Also write a debug marker so out-of-band tests can detect delivery.
      try {
        require('node:fs').appendFileSync(
          `/tmp/cccp-${NAME}-msg.log`,
          JSON.stringify({ at: Date.now(), from, kind, task_id, parent_task_id, room, content }) + '\n',
        )
      } catch {}
      return new Response('ok')
    }

    if (url.pathname === '/permission/request') {
      // A peer is asking THIS session to approve their tool call.
      const request_id = String(body.request_id ?? '')
      const tool_name = String(body.tool_name ?? '')
      const description = String(body.description ?? '')
      const input_preview = String(body.input_preview ?? '')
      await pushChannel(
        [
          `Peer "${from}" is asking permission to run ${tool_name}.`,
          ``,
          `Description: ${description}`,
          `Input: ${input_preview}`,
          ``,
          `To answer, call respond_permission with peer="${from}", request_id="${request_id}", behavior="allow"|"deny".`,
        ].join('\n'),
        {
          sender: from,
          kind: 'perm-request',
          request_id,
          tool_name,
        },
      )
      return new Response('ok')
    }

    if (url.pathname === '/permission/verdict') {
      // A peer is answering a permission request we forwarded to them.
      const request_id = String(body.request_id ?? '')
      const behavior = String(body.behavior ?? '')
      if (behavior !== 'allow' && behavior !== 'deny')
        return new Response('bad behavior', { status: 400 })
      const expected = pendingPermissionRelays.get(request_id)
      if (!expected || expected !== from) {
        log('ignored verdict from', from, 'for', request_id, '(expected', expected, ')')
        return new Response('no such request', { status: 404 })
      }
      pendingPermissionRelays.delete(request_id)
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
      return new Response('ok')
    }

    return new Response('not found', { status: 404 })
  },
})

const url = `http://127.0.0.1:${server.port}`
log('listening on', url)

let cleanupRegistry: () => void = () => {}

function reregister() {
  cleanupRegistry()
  cleanupRegistry = registerSelf({
    name: NAME,
    url,
    pid: process.pid,
    capabilities: ['channel', 'channel-permission'],
    meta: SUPERVISOR ? { supervisor: SUPERVISOR } : undefined,
  })
}
reregister()

process.on('beforeExit', () => {
  try {
    server.stop()
  } catch {}
  cleanupRegistry()
})

await mcp.connect(new StdioServerTransport())
log('mcp connected — name=' + NAME, SUPERVISOR ? `supervisor=${SUPERVISOR}` : '')
