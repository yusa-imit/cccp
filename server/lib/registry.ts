import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export type PeerRecord = {
  name: string
  url: string
  pid: number
  startedAt: number
  capabilities: string[]
  meta?: Record<string, string>
}

function registryDir() {
  const base = process.env.CCP_HOME?.trim() || join(homedir(), '.ccp')
  return join(base, 'registry')
}
const STALE_MS = 60_000

function ensureDir() {
  mkdirSync(registryDir(), { recursive: true })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code === 'EPERM'
  }
}

function recordPath(name: string) {
  return join(registryDir(), `${sanitize(name)}.json`)
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

export function defaultName(): string {
  const envName = process.env.CCP_NAME?.trim()
  if (envName) return envName
  return `${hostname().split('.')[0]}-${process.pid}`
}

export function registerSelf(rec: Omit<PeerRecord, 'startedAt'>): () => void {
  ensureDir()
  const full: PeerRecord = { ...rec, startedAt: Date.now() }
  const path = recordPath(full.name)
  writeFileSync(path, JSON.stringify(full, null, 2))

  const heartbeat = setInterval(() => {
    try {
      writeFileSync(path, JSON.stringify({ ...full, startedAt: Date.now() }, null, 2))
    } catch {}
  }, 20_000)

  const cleanup = () => {
    clearInterval(heartbeat)
    try {
      rmSync(path, { force: true })
    } catch {}
  }

  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('beforeExit', cleanup)

  return cleanup
}

export function listPeers(excludeName?: string): PeerRecord[] {
  ensureDir()
  const out: PeerRecord[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(registryDir())
  } catch {
    return out
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const path = join(registryDir(), f)
    try {
      const raw = readFileSync(path, 'utf8')
      const rec = JSON.parse(raw) as PeerRecord
      if (excludeName && rec.name === excludeName) continue
      const st = statSync(path)
      const stale = Date.now() - st.mtimeMs > STALE_MS
      if (stale || !isAlive(rec.pid)) {
        try {
          rmSync(path, { force: true })
        } catch {}
        continue
      }
      out.push(rec)
    } catch {
      try {
        rmSync(path, { force: true })
      } catch {}
    }
  }
  return out
}

export function findPeer(name: string): PeerRecord | undefined {
  return listPeers().find((p) => p.name === name)
}
