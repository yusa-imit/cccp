import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postJSON, startInstance, type Instance } from './helpers/instance.ts'

let TMP = ''
const active: Instance[] = []

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'cccp-int-'))
})

afterEach(async () => {
  await Promise.all(active.splice(0).map((i) => i.stop()))
  rmSync(TMP, { recursive: true, force: true })
})

async function spawn(name: string, opts: { supervisor?: string } = {}) {
  const inst = await startInstance({ name, home: TMP, supervisor: opts.supervisor })
  active.push(inst)
  return inst
}

describe('peer discovery', () => {
  test('two instances see each other via /peers', async () => {
    const alice = await spawn('alice')
    const bob = await spawn('bob')

    const fromBob = await fetch(`${bob.url}/peers`).then((r) => r.json() as Promise<any[]>)
    const fromAlice = await fetch(`${alice.url}/peers`).then((r) => r.json() as Promise<any[]>)

    expect(fromBob.map((p) => p.name)).toContain('alice')
    expect(fromAlice.map((p) => p.name)).toContain('bob')
  })

  test('/info returns this instance metadata', async () => {
    const alice = await spawn('alice')
    const info = await fetch(`${alice.url}/info`).then((r) => r.json() as Promise<any>)
    expect(info.name).toBe('alice')
    expect(info.capabilities).toEqual(['channel', 'channel-permission'])
  })
})

describe('inbound /msg', () => {
  test('emits a channel notification on the receiver when sender is a known peer', async () => {
    const alice = await spawn('alice')
    const bob = await spawn('bob')

    const res = await postJSON(`${bob.url}/msg`, {
      from: 'alice',
      kind: 'task',
      task_id: 't-1',
      content: 'please count files',
    })
    expect(res.status).toBe(200)

    const evt = await bob.waitForNotification(
      'notifications/claude/channel',
      (p) => p.meta.task_id === 't-1',
    )
    expect(evt.params.content).toBe('please count files')
    expect(evt.params.meta).toMatchObject({
      sender: 'alice',
      kind: 'task',
      task_id: 't-1',
    })
  })

  test('rejects unknown senders with 403 and no notification is emitted', async () => {
    const bob = await spawn('bob')
    const before = bob.notifications.length

    const res = await postJSON(`${bob.url}/msg`, {
      from: 'eve',
      kind: 'note',
      content: 'injected text',
    })
    expect(res.status).toBe(403)

    await Bun.sleep(150)
    expect(bob.notifications.length).toBe(before)
  })

  test('rejects missing `from` field with 400', async () => {
    const bob = await spawn('bob')
    const res = await postJSON(`${bob.url}/msg`, { kind: 'note', content: 'x' })
    expect(res.status).toBe(400)
  })

  test('accepts loopback messages from self', async () => {
    const alice = await spawn('alice')
    const res = await postJSON(`${alice.url}/msg`, {
      from: 'alice',
      kind: 'note',
      content: 'self test',
    })
    expect(res.status).toBe(200)
    await alice.waitForNotification(
      'notifications/claude/channel',
      (p) => p.content === 'self test',
    )
  })
})

describe('inbound /permission/request', () => {
  test('emits a perm-request channel notification with all fields as attributes', async () => {
    const alice = await spawn('alice')
    const bob = await spawn('bob')

    await postJSON(`${alice.url}/permission/request`, {
      from: 'bob',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'list files',
      input_preview: 'ls -la',
    })

    const evt = await alice.waitForNotification(
      'notifications/claude/channel',
      (p) => p.meta.kind === 'perm-request',
    )
    expect(evt.params.meta).toMatchObject({
      sender: 'bob',
      kind: 'perm-request',
      request_id: 'abcde',
      tool_name: 'Bash',
    })
    expect(evt.params.content).toContain('Bash')
    expect(evt.params.content).toContain('abcde')
    expect(evt.params.content).toContain('list files')
  })
})

describe('inbound /permission/verdict', () => {
  test('returns 404 when no pending request matches', async () => {
    const alice = await spawn('alice')
    const bob = await spawn('bob')
    const res = await postJSON(`${alice.url}/permission/verdict`, {
      from: 'bob',
      request_id: 'zzzzz',
      behavior: 'allow',
    })
    expect(res.status).toBe(404)
  })

  test('rejects bad behavior with 400', async () => {
    const alice = await spawn('alice')
    const bob = await spawn('bob')
    const res = await postJSON(`${alice.url}/permission/verdict`, {
      from: 'bob',
      request_id: 'zzzzz',
      behavior: 'maybe',
    })
    expect(res.status).toBe(400)
  })
})

describe('register tool', () => {
  test('renames the instance in the registry', async () => {
    const inst = await spawn('original')
    expect(await registryHas(TMP, 'original')).toBe(true)

    // initialize MCP session (required before request-style calls in some SDK setups)
    await initializeMcp(inst)

    const res = await inst.callTool('register', { name: 'renamed' })
    expect(textOf(res)).toContain('registered as "renamed"')

    expect(await registryHas(TMP, 'renamed')).toBe(true)
    expect(await registryHas(TMP, 'original')).toBe(false)

    // whoami reflects new name
    const who = await inst.callTool('whoami')
    expect(textOf(who)).toContain('renamed')
  })

  test('rejects renaming to a name already held by another live peer', async () => {
    const a = await spawn('a')
    const b = await spawn('b')
    await initializeMcp(b)

    const res = await b.callTool('register', { name: 'a' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/already in use/)

    // b is still under its original name
    expect(await registryHas(TMP, 'b')).toBe(true)
  })

  test('renaming to the same name is a no-op success', async () => {
    const inst = await spawn('same')
    await initializeMcp(inst)
    const res = await inst.callTool('register', { name: 'same' })
    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toContain('already registered')
  })
})

function textOf(res: any): string {
  if (!res?.content) return ''
  return res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

async function registryHas(home: string, name: string): Promise<boolean> {
  const path = join(home, 'registry', `${name}.json`)
  try {
    require('node:fs').statSync(path)
    return true
  } catch {
    return false
  }
}

async function initializeMcp(inst: Instance) {
  // Drive the MCP initialize handshake so request-style calls (tools/call) are accepted.
  await (inst.proc.stdin as any).write?.(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cccp-test', version: '0.0.0' },
      },
    }) + '\n',
  )
  // Allow the server to process the initialize round-trip
  await Bun.sleep(150)
  await (inst.proc.stdin as any).write?.(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
  )
  await Bun.sleep(50)
}

describe('outbound permission relay (full loop)', () => {
  test(
    'supervised instance forwards permission_request to supervisor, and supervisor verdict resolves it',
    async () => {
      // alice acts as supervisor; bob is supervised
      const alice = await spawn('alice')
      const bob = await spawn('bob', { supervisor: 'alice' })

      // Simulate Claude Code asking bob's MCP server for a permission decision
      await bob.sendNotification('notifications/claude/channel/permission_request', {
        request_id: 'qwert',
        tool_name: 'Bash',
        description: 'delete /tmp/test',
        input_preview: 'rm -rf /tmp/test',
      })

      // alice's inbox should have received the relay and pushed a perm-request notification
      const relayed = await alice.waitForNotification(
        'notifications/claude/channel',
        (p) => p.meta.request_id === 'qwert',
      )
      expect(relayed.params.meta.sender).toBe('bob')
      expect(relayed.params.meta.kind).toBe('perm-request')

      // alice answers: POST verdict back to bob
      const res = await postJSON(`${bob.url}/permission/verdict`, {
        from: 'alice',
        request_id: 'qwert',
        behavior: 'allow',
      })
      expect(res.status).toBe(200)

      // bob must emit notifications/claude/channel/permission so Claude Code closes its dialog
      const verdict = await bob.waitForNotification(
        'notifications/claude/channel/permission',
        (p) => p.request_id === 'qwert',
      )
      expect(verdict.params.behavior).toBe('allow')
    },
    15_000,
  )
})
