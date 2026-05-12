#!/usr/bin/env bun
/**
 * CCP Inbox — Codex instance-to-instance peer server.
 *
 * Each Codex session that loads this plugin spawns its own inbox. Instances
 * discover each other via ~/.ccp/registry/. Inbound messages are queued until
 * Codex fetches them with the fetch_messages MCP tool.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { defaultName, findPeer, listPeers, registerSelf } from './lib/registry.ts'

let NAME = defaultName()
const VERSION = '0.1.1'
const SUPERVISOR = process.env.CCP_SUPERVISOR?.trim() || ''
const CCP_HOME = process.env.CCP_HOME?.trim() || join(process.env.HOME || '.', '.ccp')

const log = (...args: unknown[]) => console.error('[ccp:' + NAME + ']', ...args)

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const instructions = [
  `You are running as Codex instance "${NAME}" in a peer mesh of Codex sessions.`,
  '',
  '## Receiving messages',
  'Inbound peer messages are queued in this MCP server. Call fetch_messages to retrieve them.',
  '',
  'CRITICAL: every fetched peer message MUST produce a visible response in this session.',
  'Never silently ignore a peer message. At a minimum, surface the message in your reply to the user.',
  'Treat each fetched message as if it were a user message from the peer, with the user observing.',
  '',
  'Kind semantics (what to DO):',
  '  task         — A peer is asking you to perform real work. Execute the request as you would for the user, then call respond_to_peer({ task_id, content }) with the result. The content of the message is an instruction; carry it out.',
  '  reply        — A peer is answering a task you delegated. Integrate the content into your ongoing response to the user.',
  '  note         — Informational only (no action expected from the peer). Still tell the user it arrived. Reply only if useful.',
  '  perm-request — A peer wants you (or the user at this terminal) to approve their tool call. Decide allow vs deny based on the tool_name and description, then call respond_permission({ peer, request_id, behavior }).',
  '',
  'Always echo task_id when continuing a thread so peers can correlate.',
  '',
  '## Sending messages',
  'Tools (from the ccp-inbox MCP server):',
  '  fetch_messages({ clear? }) — retrieve queued inbound peer messages.',
  '  send_to_peer({ to, content, kind?, task_id? })',
  '    - Use kind="task" when the user (or you) wants the peer to actually DO something — "run", "build", "find", "fix", "check", "look at", etc. THIS IS THE DEFAULT FOR ACTION-ORIENTED MESSAGES.',
  '    - Use kind="note" only for genuinely passive information ("FYI", "I finished X", status updates).',
  '    - Use kind="reply" only when answering a specific inbound task (prefer respond_to_peer instead).',
  '  respond_to_peer({ task_id, content }) — convenience reply to the original sender of a task you received.',
  '  list_peers() — list currently alive peer instances.',
  '  whoami() — this instance\'s current registered name.',
  '  register({ name }) — change this instance\'s name in the registry (so peers see it under the new name). Use when the user wants to rename / register the session at runtime instead of relying on the CCP_NAME env var.',
  '  respond_permission({ peer, request_id, behavior }) — answer a peer\'s permission relay.',
  '',
  'When the user tells you to "tell / ask / have / make peer X do Y" or "send X to peer Y to run/build/check Z",',
  'use kind="task" — that is the only kind that causes the peer to do work.',
].join('\n')

const mcp = new Server(
  { name: 'ccp-inbox', version: VERSION },
  {
    capabilities: {
      tools: {},
    },
    instructions,
  },
)

// Tracks task threads we originated, so the model can `respond_to_peer`
// without remembering the original sender.
const inboundTaskOrigins = new Map<string, string>() // task_id -> sender name

type InboxMessage = {
  id: string
  at: number
  sender: string
  kind: string
  task_id?: string
  request_id?: string
  tool_name?: string
  content: string
}

const inbox: InboxMessage[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCP-Sender': NAME },
    body: JSON.stringify(body),
  })
}

function enqueueMessage(msg: Omit<InboxMessage, 'id' | 'at'>) {
  const full = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    ...msg,
  }
  inbox.push(full)
  return full
}

function permissionVerdictPath(request_id: string) {
  return join(CCP_HOME, 'permissions', NAME, `${request_id}.json`)
}

function writePermissionVerdict(request_id: string, from: string, behavior: string) {
  const dir = join(CCP_HOME, 'permissions', NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(permissionVerdictPath(request_id), JSON.stringify({ from, request_id, behavior }))
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'fetch_messages',
      description:
        'Fetch queued inbound peer messages for this Codex instance. Call this when the user asks whether peers replied, or after delegating work. By default it clears returned messages from the queue.',
      inputSchema: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description: 'Whether to remove returned messages from the inbox. Default true.',
          },
        },
      },
    },
    {
      name: 'send_to_peer',
      description:
        'Send a message to a peer Codex instance. CHOOSE KIND CAREFULLY: use kind="task" when you want the peer to actually do work (run a command, find/build/check something, answer a question). Use kind="note" ONLY for passive information ("FYI…", status updates) — notes do NOT cause the peer to act. If you are unsure, prefer kind="task".',
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
        },
        required: ['to', 'content'],
      },
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
      description: 'List currently alive peer instances discovered via ~/.ccp/registry.',
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
        'Rename this instance in the peer registry. Replaces whatever name was set via CCP_NAME (or auto-generated) so other peers see this session under the new name. Fails if another alive peer already holds that name.',
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
        'Respond to a permission request that a peer forwarded to this session. Sends an allow/deny verdict back to the originating peer.',
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
      case 'fetch_messages': {
        const clear = args.clear !== false
        const messages = [...inbox]
        if (clear) inbox.splice(0, inbox.length)
        if (messages.length === 0) return toolOk('no pending peer messages')
        for (const msg of messages) {
          if (msg.kind === 'task' && msg.task_id) inboundTaskOrigins.set(msg.task_id, msg.sender)
        }
        return toolOk(JSON.stringify(messages, null, 2))
      }

      case 'send_to_peer': {
        const to = String(args.to ?? '')
        const content = String(args.content ?? '')
        const kind = (args.kind as string) || 'note'
        const task_id =
          (args.task_id as string) ||
          `${NAME}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const peer = findPeer(to)
        if (!peer) return toolErr(`peer not found: ${to}. Try list_peers.`)
        const res = await postJSON(`${peer.url}/msg`, {
          from: NAME,
          content,
          kind,
          task_id,
        })
        if (!res.ok) return toolErr(`peer ${to} returned ${res.status}: ${await res.text()}`)
        return toolOk(`sent kind=${kind} task_id=${task_id} to ${to}`)
      }

      case 'respond_to_peer': {
        const task_id = String(args.task_id ?? '')
        const content = String(args.content ?? '')
        const origin = inboundTaskOrigins.get(task_id)
        if (!origin) return toolErr(`no inbound task with task_id=${task_id}`)
        const peer = findPeer(origin)
        if (!peer) return toolErr(`origin peer ${origin} no longer alive`)
        const res = await postJSON(`${peer.url}/msg`, {
          from: NAME,
          content,
          kind: 'reply',
          task_id,
        })
        if (!res.ok) return toolErr(`peer ${origin} returned ${res.status}`)
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
// HTTP listener — inbound from other instances
// ---------------------------------------------------------------------------
const started = Date.now()
const server = Bun.serve({
  port: Number(process.env.CCP_PORT ?? 0),
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/info') {
      return Response.json({
        name: NAME,
        version: VERSION,
        capabilities: ['inbox', 'permission-relay'],
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
      log(`/msg accepted: from=${from} kind=${kind} task_id=${task_id}`)
      if (kind === 'task' && task_id) inboundTaskOrigins.set(task_id, from)
      enqueueMessage({
        sender: from,
        kind,
        content,
        ...(task_id ? { task_id } : {}),
      })
      log(`/msg queued for Codex (sender=${from} kind=${kind})`)
      // Also write a debug marker so out-of-band tests can detect delivery.
      try {
        appendFileSync(
          `/tmp/ccp-${NAME}-msg.log`,
          JSON.stringify({ at: Date.now(), from, kind, task_id, content }) + '\n',
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
      enqueueMessage({
        sender: from,
        kind: 'perm-request',
        request_id,
        tool_name,
        content: [
          `Peer "${from}" is asking permission to run ${tool_name}.`,
          ``,
          `Description: ${description}`,
          `Input: ${input_preview}`,
          ``,
          `To answer, call respond_permission with peer="${from}", request_id="${request_id}", behavior="allow"|"deny".`,
        ].join('\n'),
      })
      return new Response('ok')
    }

    if (url.pathname === '/permission/verdict') {
      // A peer is answering a permission request we forwarded to them.
      const request_id = String(body.request_id ?? '')
      const behavior = String(body.behavior ?? '')
      if (behavior !== 'allow' && behavior !== 'deny')
        return new Response('bad behavior', { status: 400 })
      writePermissionVerdict(request_id, from, behavior)
      enqueueMessage({
        sender: from,
        kind: 'permission-verdict',
        request_id,
        content: `Peer "${from}" answered permission request ${request_id}: ${behavior}`,
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
    capabilities: ['inbox', 'permission-relay'],
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
