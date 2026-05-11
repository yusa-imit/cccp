import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultName, findPeer, listPeers, registerSelf } from '../lib/registry.ts'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'cccp-test-'))
  process.env.CCCP_HOME = TMP
  delete process.env.CCCP_NAME
})

afterEach(() => {
  delete process.env.CCCP_HOME
  delete process.env.CCCP_NAME
  rmSync(TMP, { recursive: true, force: true })
})

describe('defaultName', () => {
  test('uses CCCP_NAME when set', () => {
    process.env.CCCP_NAME = 'alpha'
    expect(defaultName()).toBe('alpha')
  })

  test('falls back to hostname-pid pattern', () => {
    delete process.env.CCCP_NAME
    const n = defaultName()
    expect(n).toMatch(/.+-\d+$/)
  })

  test('trims whitespace in env value', () => {
    process.env.CCCP_NAME = '  beta  '
    expect(defaultName()).toBe('beta')
  })
})

describe('registerSelf', () => {
  test('writes a JSON record for the current process', () => {
    const cleanup = registerSelf({
      name: 'alice',
      url: 'http://127.0.0.1:1234',
      pid: process.pid,
      capabilities: ['channel'],
    })
    const file = join(TMP, 'registry', 'alice.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    expect(data.name).toBe('alice')
    expect(data.url).toBe('http://127.0.0.1:1234')
    expect(data.pid).toBe(process.pid)
    expect(data.capabilities).toEqual(['channel'])
    expect(typeof data.startedAt).toBe('number')
    cleanup()
  })

  test('cleanup() removes the file', () => {
    const cleanup = registerSelf({
      name: 'tmp',
      url: 'http://127.0.0.1:1',
      pid: process.pid,
      capabilities: [],
    })
    expect(readdirSync(join(TMP, 'registry'))).toContain('tmp.json')
    cleanup()
    expect(readdirSync(join(TMP, 'registry'))).not.toContain('tmp.json')
  })

  test('sanitizes peer names with unsafe characters', () => {
    const cleanup = registerSelf({
      name: 'a/b c?',
      url: 'http://x',
      pid: process.pid,
      capabilities: [],
    })
    const files = readdirSync(join(TMP, 'registry'))
    expect(files.some((f) => f.includes('a_b_c_'))).toBe(true)
    cleanup()
  })
})

describe('listPeers', () => {
  test('returns empty when no registry dir yet', () => {
    expect(listPeers()).toEqual([])
  })

  test('returns alive peers', () => {
    const a = registerSelf({ name: 'a', url: 'http://x:1', pid: process.pid, capabilities: [] })
    const b = registerSelf({ name: 'b', url: 'http://x:2', pid: process.pid, capabilities: [] })
    const peers = listPeers()
    expect(peers.map((p) => p.name).sort()).toEqual(['a', 'b'])
    a()
    b()
  })

  test('excludes self when excludeName given', () => {
    const a = registerSelf({ name: 'a', url: 'http://x:1', pid: process.pid, capabilities: [] })
    const b = registerSelf({ name: 'b', url: 'http://x:2', pid: process.pid, capabilities: [] })
    const peers = listPeers('a')
    expect(peers.map((p) => p.name)).toEqual(['b'])
    a()
    b()
  })

  test('removes records for dead PIDs', () => {
    // Write a record by hand with a PID that almost certainly doesn't exist
    const dir = join(TMP, 'registry')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'ghost.json'),
      JSON.stringify({
        name: 'ghost',
        url: 'http://x:9',
        pid: 999_999_999,
        capabilities: [],
        startedAt: Date.now(),
      }),
    )
    const peers = listPeers()
    expect(peers.map((p) => p.name)).not.toContain('ghost')
    expect(readdirSync(dir)).not.toContain('ghost.json')
  })

  test('removes malformed JSON files', () => {
    const dir = join(TMP, 'registry')
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), 'not json')
    listPeers()
    expect(readdirSync(dir)).not.toContain('broken.json')
  })
})

describe('findPeer', () => {
  test('returns undefined when not found', () => {
    expect(findPeer('nobody')).toBeUndefined()
  })

  test('returns the record when found', () => {
    const c = registerSelf({ name: 'c', url: 'http://x:3', pid: process.pid, capabilities: [] })
    expect(findPeer('c')?.url).toBe('http://x:3')
    c()
  })
})
