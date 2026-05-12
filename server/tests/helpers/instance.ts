import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

export type Instance = {
  name: string
  url: string
  proc: Subprocess
  notifications: { method: string; params: any }[]
  /** Wait until a notification matching `method` and `predicate` arrives, or throw. */
  waitForNotification(
    method: string,
    predicate?: (params: any) => boolean,
    timeoutMs?: number,
  ): Promise<{ method: string; params: any }>
  /** Send a JSON-RPC notification to the server's stdin (simulating Codex). */
  sendNotification(method: string, params: any): Promise<void>
  /** Invoke an MCP tool and await its response. */
  callTool(name: string, args?: Record<string, unknown>): Promise<any>
  /** Stop the process and wait for exit. */
  stop(): Promise<void>
}

const INBOX_PATH = join(import.meta.dir, '..', '..', 'inbox.ts')

export async function startInstance(opts: {
  name: string
  home: string
  supervisor?: string
  /** Maximum time to wait for the URL to appear in the registry, ms. */
  bootTimeoutMs?: number
}): Promise<Instance> {
  const env: Record<string, string> = {
    ...process.env,
    CCP_NAME: opts.name,
    CCP_HOME: opts.home,
  }
  if (opts.supervisor) env.CCP_SUPERVISOR = opts.supervisor

  const proc = Bun.spawn(['bun', INBOX_PATH], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const notifications: { method: string; params: any }[] = []
  const waiters: {
    method: string
    predicate?: (p: any) => boolean
    resolve: (n: { method: string; params: any }) => void
  }[] = []
  const pendingResponses = new Map<number, (msg: any) => void>()
  let nextRequestId = 1

  ;(async () => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          // Response to a request we sent (has id, no method)
          if (typeof msg.id === 'number' && msg.method === undefined) {
            const resolver = pendingResponses.get(msg.id)
            if (resolver) {
              pendingResponses.delete(msg.id)
              resolver(msg)
            }
            continue
          }
          if (typeof msg.method === 'string') {
            const evt = { method: msg.method, params: msg.params }
            notifications.push(evt)
            const idx = waiters.findIndex(
              (w) => w.method === msg.method && (!w.predicate || w.predicate(msg.params)),
            )
            if (idx >= 0) {
              const [w] = waiters.splice(idx, 1)
              w.resolve(evt)
            }
          }
        } catch {
          // not JSON-RPC; ignore
        }
      }
    }
  })()

  async function writeStdin(payload: string) {
    const writer = (proc.stdin as any).getWriter ? (proc.stdin as any).getWriter() : null
    if (writer) {
      await writer.write(new TextEncoder().encode(payload))
      writer.releaseLock()
    } else {
      ;(proc.stdin as any).write(payload)
      await (proc.stdin as any).flush?.()
    }
  }

  // Wait for the registry file to appear (means the HTTP server is listening)
  const regFile = join(opts.home, 'registry', `${opts.name}.json`)
  const deadline = Date.now() + (opts.bootTimeoutMs ?? 4000)
  while (Date.now() < deadline) {
    if (existsSync(regFile)) break
    await Bun.sleep(50)
  }
  if (!existsSync(regFile)) {
    proc.kill()
    throw new Error(`instance ${opts.name} failed to register within timeout`)
  }
  const rec = JSON.parse(readFileSync(regFile, 'utf8'))

  return {
    name: opts.name,
    url: rec.url,
    proc,
    notifications,
    waitForNotification(method, predicate, timeoutMs = 3000) {
      const existing = notifications.find(
        (n) => n.method === method && (!predicate || predicate(n.params)),
      )
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const w = { method, predicate, resolve }
        waiters.push(w)
        setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) {
            waiters.splice(i, 1)
            reject(
              new Error(
                `timeout waiting for ${method}; received ${notifications
                  .map((n) => n.method)
                  .join(',')}`,
              ),
            )
          }
        }, timeoutMs)
      })
    },
    async sendNotification(method, params) {
      await writeStdin(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    async callTool(name, args = {}) {
      const id = nextRequestId++
      const payload =
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }) + '\n'
      const responsePromise = new Promise<any>((resolve, reject) => {
        pendingResponses.set(id, resolve)
        setTimeout(() => {
          if (pendingResponses.delete(id)) {
            reject(new Error(`timeout waiting for tools/call response (id=${id}, name=${name})`))
          }
        }, 3000)
      })
      await writeStdin(payload)
      const res = await responsePromise
      if (res.error) throw new Error(`tools/call error: ${JSON.stringify(res.error)}`)
      return res.result
    },
    async stop() {
      proc.kill()
      await proc.exited
    },
  }
}

export async function postJSON(url: string, body: unknown, sender = 'test-runner') {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCP-Sender': sender },
    body: JSON.stringify(body),
  })
}
