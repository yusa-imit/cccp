import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, renameSync } from 'node:fs'
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

export type RoomRecord = {
  name: string
  members: string[]
  createdBy: string
  createdAt: number
}

function cccpHome() {
  return process.env.CCCP_HOME?.trim() || join(homedir(), '.cccp')
}
function registryDir() {
  return join(cccpHome(), 'registry')
}
function roomsDir() {
  return join(cccpHome(), 'rooms')
}
const STALE_MS = 60_000

function ensureDir() {
  mkdirSync(registryDir(), { recursive: true })
}
function ensureRoomsDir() {
  mkdirSync(roomsDir(), { recursive: true })
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
  const envName = process.env.CCCP_NAME?.trim()
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

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function roomPath(name: string) {
  return join(roomsDir(), `${sanitize(name)}.json`)
}

function isValidRoomName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(name)
}

function writeRoomAtomic(rec: RoomRecord) {
  ensureRoomsDir()
  const path = roomPath(rec.name)
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2))
  renameSync(tmp, path)
}

export function getRoom(name: string): RoomRecord | undefined {
  try {
    const raw = readFileSync(roomPath(name), 'utf8')
    return JSON.parse(raw) as RoomRecord
  } catch {
    return undefined
  }
}

export function listRooms(): RoomRecord[] {
  ensureRoomsDir()
  const out: RoomRecord[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(roomsDir())
  } catch {
    return out
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = readFileSync(join(roomsDir(), f), 'utf8')
      out.push(JSON.parse(raw) as RoomRecord)
    } catch {
      // ignore malformed
    }
  }
  return out
}

export function createRoom(name: string, owner: string, initialMembers: string[] = []): RoomRecord {
  if (!isValidRoomName(name)) {
    throw new Error(`invalid room name "${name}" (allowed: a-z A-Z 0-9 _ . - up to 64 chars)`)
  }
  const existing = getRoom(name)
  if (existing) throw new Error(`room "${name}" already exists`)
  const members = Array.from(new Set([owner, ...initialMembers]))
  const rec: RoomRecord = { name, members, createdBy: owner, createdAt: Date.now() }
  writeRoomAtomic(rec)
  return rec
}

export function joinRoom(name: string, peer: string): RoomRecord {
  if (!isValidRoomName(name)) throw new Error(`invalid room name "${name}"`)
  const existing = getRoom(name)
  const rec: RoomRecord = existing ?? {
    name,
    members: [],
    createdBy: peer,
    createdAt: Date.now(),
  }
  if (!rec.members.includes(peer)) rec.members.push(peer)
  writeRoomAtomic(rec)
  return rec
}

export function leaveRoom(name: string, peer: string): RoomRecord | undefined {
  const existing = getRoom(name)
  if (!existing) return undefined
  const before = existing.members.length
  existing.members = existing.members.filter((m) => m !== peer)
  if (existing.members.length === 0) {
    try {
      rmSync(roomPath(name), { force: true })
    } catch {}
    return existing
  }
  if (existing.members.length !== before) writeRoomAtomic(existing)
  return existing
}

export function roomsContaining(peer: string): RoomRecord[] {
  return listRooms().filter((r) => r.members.includes(peer))
}
