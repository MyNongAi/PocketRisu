/**
 * The database persist modes (db-persister.cjs) against each other, through
 * the real server: a seeded run of requests (patches of every shape a client
 * sends, chat saves, new chats, flushes, restarts, a failing database write,
 * a failure after the write, and persistMode flips through the flags file) is
 * sent to two servers, one in persistMode 'reference' and one in the mode
 * under test. After every step both are flushed, and their /api/read bytes,
 * their database.bin on disk and a sample of chat GETs must be identical.
 *
 * The blob is chunked (POCKETRISU_CHUNK_THRESHOLD) so the planned paths
 * write chunk lists, and every planned persist is also compared by the server
 * itself with the reference encoder (POCKETRISU_PERSIST_VERIFY); its
 * verifyFailures must stay 0, as must the incremental audit's mismatches.
 */
import { afterAll, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskValue, sessionCookie } from './helpers/disk.js'

const Sqlite = require('better-sqlite3')
const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const { cdcSplit } = require('../../server/node/chunkStore.cjs')
const { applyPatch } = require('fast-json-patch')

const DB_KEY = 'database/database.bin'
const DB_KEY_HEX = Buffer.from(DB_KEY).toString('hex')
const FAIL_DB = fileURLToPath(new URL('./helpers/fail-db-persist-preload.cjs', import.meta.url))
const FAIL_AFTER = fileURLToPath(new URL('./helpers/fail-after-db-write-preload.cjs', import.meta.url))
const ENV = {
  POCKETRISU_CHUNK_THRESHOLD: '4096',
  POCKETRISU_PERSIST_VERIFY: '1',
  POCKETRISU_FLAGS_STAT_INTERVAL_MS: '0',
  POCKETRISU_PERSIST_RETRY_MS: '300',
  POCKETRISU_PERSIST_AUDIT_INTERVAL_MS: '0',
  POCKETRISU_PERSIST_AUDIT_IDLE_MS: '150',
  NODE_OPTIONS: `--require ${FAIL_DB} --require ${FAIL_AFTER}`,
}
const sessionHeaders = { 'x-session-id': 'db-persist-modes', 'x-user-active': '1' }

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

type Mode = 'reference' | 'full-plan' | 'incremental'
interface Node { srv: ServerHandle, client: RisuClient, cookie: string, mode: Mode }

function writeFlags(saveDir: string, mode: Mode) {
  fs.writeFileSync(path.join(saveDir, 'pocketrisu-flags.json'), JSON.stringify({ persistMode: mode }))
}

async function start(mode: Mode, from?: Node): Promise<Node> {
  const srv = await spawnServer({
    env: ENV,
    seedSave: async (saveDir) => {
      writeFlags(saveDir, mode)
      if (!from) return
      // A consistent snapshot of the previous server's database, as after a restart.
      const db = new Sqlite(path.join(from.srv.cwd, 'save', 'risuai.db'), { readonly: true })
      try { await db.backup(path.join(saveDir, 'risuai.db')) } finally { db.close() }
    },
  })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  return { srv, client, cookie: await sessionCookie(client), mode }
}

function setMode(node: Node, mode: Mode) {
  writeFlags(path.join(node.srv.cwd, 'save'), mode)
  node.mode = mode
}

async function flush(node: Node) {
  return node.client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: node.cookie } })
}

async function readBytes(node: Node) {
  const res = await node.client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return Buffer.from(await res.arrayBuffer())
}

function sendPatch(node: Node, patch: unknown[], expectedHash: string) {
  return node.client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

function getChat(node: Node, chaId: string, chatId: string) {
  return node.client.fetch(`/api/chat-content/${chaId}/0`, { headers: { 'x-chat-id': chatId } })
}

function postChat(node: Node, chaId: string, chat: any, headers: Record<string, string> = {}) {
  return node.client.fetch(`/api/chat-content/${chaId}/0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-chat-id': chat.id, ...sessionHeaders, ...headers },
    body: Buffer.from(utils.encodeRisuSaveLegacy(chat)),
  })
}

async function persistStats(node: Node) {
  const res = await node.client.fetch('/api/debug/memory')
  expect(res.status).toBe(200)
  return (await res.json() as any).persist
}

function manifestHashes(cwd: string) {
  const db = new Sqlite(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq').pluck().all(DB_KEY) as string[]
  } finally {
    db.close()
  }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let serial = 0
function newCharacter() {
  const n = serial++
  return { name: `Added ${n}`, chaId: `added-${n}`, desc: `desc ${n}`, firstMessage: '', chats: [], chatPage: 0, image: '', type: 'character' }
}
function newModule() {
  const n = serial++
  return { name: `Module ${n}`, id: `module-${n}`, description: '', lorebook: [{ key: 'k', content: `lore ${n}`, insertorder: 1 }], regex: [] }
}

// The patch shapes a client sends, as in db-patch-element-sharing.
function patchFor(rand: () => number, db: any): unknown[] {
  const i = Math.floor(rand() * db.characters.length)
  const chats = db.characters[i].chats ?? []
  const j = Math.floor(rand() * Math.max(1, chats.length))
  const m = Math.floor(rand() * db.modules.length)
  const r = rand()
  if (r < 0.2 && chats.length > 0) return [{ op: 'replace', path: `/characters/${i}/chats/${j}/lastDate`, value: 1727500000000 + serial++ }]
  if (r < 0.27 && chats.length > 0) return [{ op: 'replace', path: `/characters/${i}/chats/${j}/name`, value: `Chat ${serial++}` }]
  if (r < 0.32 && chats.length > 0) return [{ op: 'add', path: `/characters/${i}/chats/${j}/folderId`, value: null }]
  if (r < 0.42) return [{ op: 'replace', path: `/characters/${i}/desc`, value: `desc ${serial++}` }]
  if (r < 0.52) return [{ op: 'replace', path: `/modules/${m}/lorebook/0/content`, value: `edited ${serial++}` }]
  if (r < 0.56) return [{ op: 'add', path: '/modules/-', value: newModule() }]
  if (r < 0.60 && db.modules.length > 2) return [{ op: 'remove', path: `/modules/${m}` }]
  if (r < 0.66) return [{ op: 'add', path: '/characters/-', value: newCharacter() }]
  if (r < 0.70) {
    const added = db.characters.findIndex((c: any) => typeof c.chaId === 'string' && c.chaId.startsWith('added-'))
    if (added >= 0) return [{ op: 'remove', path: `/characters/${added}` }]
  }
  if (r < 0.75 && db.characters.length > 1) {
    // A reorder: two whole characters swapped (depth-2 replaces).
    const a = Math.floor(rand() * db.characters.length)
    const b = (a + 1 + Math.floor(rand() * (db.characters.length - 1))) % db.characters.length
    return [
      { op: 'replace', path: `/characters/${a}`, value: db.characters[b] },
      { op: 'replace', path: `/characters/${b}`, value: db.characters[a] },
    ]
  }
  if (r < 0.85) return [{ op: 'replace', path: '/temperature', value: 50 + (serial++ % 40) }]
  if (r < 0.92) {
    return [
      { op: 'replace', path: `/characters/${i}/name`, value: `name ${serial++}` },
      { op: 'replace', path: `/modules/${m}/name`, value: `module name ${serial++}` },
    ]
  }
  // A no-op: the same value again (still a persist).
  return [{ op: 'replace', path: '/temperature', value: db.temperature }]
}

async function runPair(mode: Mode, seed: number, steps: number) {
  const rand = mulberry32(seed)
  serial = 0
  let ref = await start('reference')
  let sut = await start(mode)
  const seedBackup = createSeedBackup({ characterCount: 5, chatsPerCharacter: 3, messagesPerChat: 4 })
  for (const node of [ref, sut]) expect((await node.client.importBackup(seedBackup)).ok).toBe(true)

  let local = utils.normalizeJSON(await utils.decodeRisuSave(await readBytes(ref))) as any
  const addModules = [{ op: 'add', path: '/modules', value: [newModule(), newModule(), newModule()] }]
  for (const node of [ref, sut]) expect((await sendPatch(node, addModules, utils.calculateHash(local).toString(16))).status).toBe(200)
  local = applyPatch(structuredClone(local), structuredClone(addModules), true).newDocument

  const seen = { steps: 0, restarts: 0, dbFaults: 0, afterFaults: 0, flips: 0, chatSaves: 0, newChats: 0, patches: 0 }
  // Planned persists of the server under test, over all its restarts.
  const planned = { 'full-plan': 0, incremental: 0 }
  const countPlanned = async () => {
    const stats = await persistStats(sut)
    planned['full-plan'] += stats.persister.persists['full-plan']
    planned.incremental += stats.persister.persists.incremental
    expect(stats.verifyFailures).toBe(0)
    expect(stats.persister.audit.mismatches).toBe(0)
    expect(stats.persister.walkFailures).toBe(0)
  }
  const both = async <T,>(fn: (node: Node) => Promise<T>) => [await fn(ref), await fn(sut)] as const

  async function compare(label: string) {
    const flushed = await both(flush)
    for (const res of flushed) expect(res.status, `${label}: flush`).toBe(200)
    const [a, b] = await both(readBytes)
    expect(b.equals(a), `${label}: /api/read`).toBe(true)
    const diskA = readDiskValue(ref.srv.cwd, DB_KEY)!
    const diskB = readDiskValue(sut.srv.cwd, DB_KEY)!
    expect(diskB.length, `${label}: disk length`).toBe(diskA.length)
    expect(diskB.equals(diskA), `${label}: database.bin`).toBe(true)
    // The manifest is exactly cdcSplit of the bytes, in both.
    const expectedHashes = cdcSplit(diskA).map((c: any) => c.hash)
    expect(manifestHashes(sut.srv.cwd), `${label}: manifest`).toEqual(expectedHashes)
    expect(manifestHashes(ref.srv.cwd)).toEqual(expectedHashes)
    // A few chats, as the server serves them.
    const withChats = local.characters.filter((c: any) => c.chats?.length)
    for (let k = 0; k < 2 && withChats.length; k++) {
      const c = withChats[Math.floor(rand() * withChats.length)]
      const chat = c.chats[Math.floor(rand() * c.chats.length)]
      const [ga, gb] = await both((node) => getChat(node, c.chaId, chat.id))
      expect(gb.status).toBe(ga.status)
      expect(Buffer.from(await gb.arrayBuffer()).equals(Buffer.from(await ga.arrayBuffer())), `${label}: chat ${chat.id}`).toBe(true)
    }
  }

  async function patchBoth(patch: unknown[]) {
    const hash = utils.calculateHash(local).toString(16)
    const results = await both((node) => sendPatch(node, patch, hash))
    expect(results[0].status).toBe(200)
    expect(results[1].status).toBe(200)
    local = applyPatch(structuredClone(local), structuredClone(patch), true).newDocument
  }

  await compare('start')
  for (let n = 0; n < steps; n++) {
    seen.steps++
    const r = rand()
    const label = `seed ${seed} step ${n}`
    if (r < 0.2) {
      // A chat turn: the body first, then the stub's lastDate.
      const withChats = local.characters.map((c: any, i: number) => [c, i]).filter(([c]: any) => c.chats?.length)
      const [c, i] = withChats[Math.floor(rand() * withChats.length)]
      const j = Math.floor(rand() * c.chats.length)
      const chatId = c.chats[j].id
      for (const node of [ref, sut]) {
        const read = await getChat(node, c.chaId, chatId)
        expect(read.status).toBe(200)
        const chat = await utils.decodeRisuSave(Buffer.from(await read.arrayBuffer())) as any
        const saved = await postChat(node, c.chaId, { ...chat, message: [...chat.message, { role: 'user', data: `turn ${n}`, time: 1727500000000 + n }] }, {
          'x-if-match': read.headers.get('x-chat-etag')!,
        })
        expect(saved.status, `${label}: chat save`).toBe(200)
      }
      seen.chatSaves++
      if (rand() < 0.8) await patchBoth([{ op: 'replace', path: `/characters/${i}/chats/${j}/lastDate`, value: 1727500000000 + n }])
    } else if (r < 0.28) {
      // A new chat: body, then the catalog entry.
      const i = Math.floor(rand() * local.characters.length)
      const c = local.characters[i]
      const chatId = `new-${seed}-${n}`
      const chat = { id: chatId, name: `New ${n}`, message: [{ role: 'user', data: `hello ${n}` }], note: '', localLore: [], lastDate: 1727500000000 + n }
      for (const node of [ref, sut]) expect((await postChat(node, c.chaId, chat)).status, `${label}: new chat`).toBe(200)
      await patchBoth([{ op: 'add', path: `/characters/${i}/chats/0`, value: { id: chatId, name: chat.name, _stub: true, lastDate: chat.lastDate } }])
      seen.newChats++
    } else if (r < 0.34) {
      // Restart both, from what they flushed.
      await compare(`${label}: before restart`)
      await countPlanned()
      const nextRef = await start('reference', ref)
      const nextSut = await start(sut.mode, sut)
      await Promise.all([ref.srv.cleanup(), sut.srv.cleanup()])
      ref = nextRef
      sut = nextSut
      seen.restarts++
    } else if (r < 0.39) {
      // The database write fails (disk full); the change is written on a later persist.
      await patchBoth(patchFor(rand, local))
      for (const node of [ref, sut]) fs.writeFileSync(path.join(node.srv.cwd, 'fail-db-persist'), '')
      const failed = await both(flush)
      for (const res of failed) expect(res.status, `${label}: flush under a failing write`).toBe(500)
      for (const node of [ref, sut]) fs.rmSync(path.join(node.srv.cwd, 'fail-db-persist'))
      seen.dbFaults++
    } else if (r < 0.44) {
      // Something fails after the blob was written.
      await patchBoth(patchFor(rand, local))
      for (const node of [ref, sut]) fs.writeFileSync(path.join(node.srv.cwd, 'fail-after-db-write'), '')
      await both(flush)
      for (const node of [ref, sut]) fs.rmSync(path.join(node.srv.cwd, 'fail-after-db-write'))
      seen.afterFaults++
    } else if (r < 0.5) {
      const modes: Mode[] = ['full-plan', 'incremental', 'reference']
      setMode(sut, modes[Math.floor(rand() * modes.length)])
      seen.flips++
    } else {
      await patchBoth(patchFor(rand, local))
      seen.patches++
    }
    if (rand() < 0.08) await new Promise((resolve) => setTimeout(resolve, 400)) // idle: the audit may run
    await compare(label)
  }
  await countPlanned()
  console.log(`[persist-modes] ${mode} seed ${seed}: ${JSON.stringify({ ...seen, planned })}`)
  return { seen, planned }
}

describe('persist modes against the reference, request by request', () => {
  test('full-plan', async () => {
    const { seen, planned } = await runPair('full-plan', 11, 45)
    expect(seen.restarts + seen.dbFaults + seen.afterFaults + seen.flips).toBeGreaterThan(4)
    expect(planned['full-plan']).toBeGreaterThan(5)
  }, 300_000)

  test('incremental', async () => {
    const { seen, planned } = await runPair('incremental', 29, 45)
    expect(seen.restarts + seen.dbFaults + seen.afterFaults + seen.flips).toBeGreaterThan(4)
    expect(planned.incremental).toBeGreaterThan(5)
  }, 300_000)

  test('incremental, another seed', async () => {
    const { planned } = await runPair('incremental', 47, 45)
    expect(planned.incremental).toBeGreaterThan(5)
  }, 300_000)
})

describe('incremental persists', () => {
  test('copy unchanged owners, pass the audit, and take a snapshot before the first copy', async () => {
    const node = await start('incremental')
    expect((await node.client.importBackup(createSeedBackup({ characterCount: 6, chatsPerCharacter: 3, messagesPerChat: 3 }))).ok).toBe(true)
    const snapshotsBefore = (await (await node.client.fetch('/api/db/snapshots')).json() as any).snapshots?.length ?? null
    let local = utils.normalizeJSON(await utils.decodeRisuSave(await readBytes(node))) as any
    const send = async (patch: unknown[]) => {
      expect((await sendPatch(node, patch, utils.calculateHash(local).toString(16))).status).toBe(200)
      local = applyPatch(structuredClone(local), structuredClone(patch), true).newDocument
      expect((await flush(node)).status).toBe(200)
    }
    await send([{ op: 'replace', path: '/temperature', value: 42 }]) // first write: everything encoded
    let stats = await persistStats(node)
    expect(stats.persister.last.spans).toBe(false)
    await send([{ op: 'replace', path: '/characters/2/chats/1/lastDate', value: 5 }])
    stats = await persistStats(node)
    expect(stats.persister.last).toMatchObject({ persistMode: 'incremental', spans: true, commit: 'gapped' })
    // The touched character is encoded again; of its three chats, the one
    // whose stub changed is merged again, the other two are copied.
    expect(stats.persister.last.freshOwners).toBe(1)
    expect(stats.persister.last.freshChats).toBe(1)
    expect(stats.persister.last.spanChats).toBe(2)
    expect(stats.persister.incrementalCommitsThisBoot).toBe(1)
    if (snapshotsBefore !== null) {
      const after = (await (await node.client.fetch('/api/db/snapshots')).json() as any).snapshots?.length
      expect(after).toBeGreaterThan(snapshotsBefore)
    }
    // Idle: the audit re-encodes what the layout would copy.
    for (let i = 0; i < 50; i++) {
      stats = await persistStats(node)
      if (stats.persister.audit.passes > 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(stats.persister.audit.passes).toBeGreaterThan(0)
    expect(stats.persister.audit.mismatches).toBe(0)
    expect(stats.verifyFailures).toBe(0)
  }, 120_000)
})
