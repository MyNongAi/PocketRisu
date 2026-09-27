/**
 * B2 through the real /api/patch: a seeded run of the patch shapes a client
 * produces (chat stub metadata, card and module edits, nested edits, slot
 * replaces, characters and modules added and removed at depth 2) plus
 * failing ones, mirrored on a local copy. Each accepted patch must leave the
 * server's hash equal to the client's calculateHash (the next patch's
 * expectedHash proves it), a failing one must leave the database as it was,
 * and after a persist the disk holds exactly the mirrored view.
 *
 * With POCKETRISU_TEST_FREEZE_CACHE=1 every installed root is deep-frozen and
 * the server audits each patch against the whole-branch clone and a full
 * calculateHash (auditPatchedRootForTests in server.cjs); an audit failure
 * would surface here as a 500 on a patch that should apply and as a nonzero
 * cachedRootMutationReports.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskDb, sessionCookie } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const { applyPatch } = require('fast-json-patch')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function boot(env: Record<string, string>) {
  const srv = await spawnServer({ env })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 6, chatsPerCharacter: 3 }))).ok).toBe(true)
  return { srv, client }
}

async function readDb(client: RisuClient) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

function sendPatch(client: RisuClient, patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
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

type Op = { op: string, path: string, value?: unknown }

// Characters the run itself adds have no chats, so removing them again is a
// plain client delete with no bodies involved.
let serial = 0
function newCharacter() {
  const n = serial++
  return { name: `Added ${n}`, chaId: `added-${n}`, desc: '', firstMessage: '', chats: [], chatPage: 0, image: '', type: 'character' }
}
function newModule() {
  const n = serial++
  return { name: `Module ${n}`, id: `module-${n}`, description: '', lorebook: [{ key: 'k', content: `lore ${n}`, insertorder: 1 }], regex: [] }
}

function generate(rand: () => number, db: any): { ops: Op[], fails: boolean } {
  const i = Math.floor(rand() * db.characters.length)
  const m = Math.floor(rand() * db.modules.length)
  const chats = db.characters[i].chats
  const j = Math.floor(rand() * Math.max(1, chats.length))
  const addedIndex = db.characters.findIndex((c: any) => typeof c.chaId === 'string' && c.chaId.startsWith('added-'))
  const r = rand()
  if (r < 0.25 && chats.length > 0) return { ops: [{ op: 'replace', path: `/characters/${i}/chats/${j}/lastDate`, value: 1727500000000 + serial++ }], fails: false }
  if (r < 0.32 && chats.length > 0) return { ops: [{ op: 'replace', path: `/characters/${i}/chats/${j}/name`, value: `Chat ${serial++}` }], fails: false }
  if (r < 0.42) return { ops: [{ op: 'replace', path: `/characters/${i}/name`, value: `Name ${serial++}` }], fails: false }
  if (r < 0.48) return { ops: [{ op: 'add', path: `/characters/${i}/tags`, value: ['a', `t${serial++}`] }, { op: 'add', path: `/characters/${i}/extraField`, value: { nested: [serial++] } }], fails: false }
  if (r < 0.56) return { ops: [{ op: 'replace', path: `/modules/${m}/lorebook/0/content`, value: `edited ${serial++}` }], fails: false }
  if (r < 0.60) return { ops: [{ op: 'replace', path: `/modules/${m}`, value: newModule() }], fails: false }
  if (r < 0.65) return { ops: [{ op: 'add', path: `/modules/${m}`, value: newModule() }], fails: false }
  if (r < 0.69 && db.modules.length > 2) return { ops: [{ op: 'remove', path: `/modules/${m}` }], fails: false }
  if (r < 0.74) return { ops: [{ op: 'add', path: '/characters/-', value: newCharacter() }], fails: false }
  if (r < 0.78 && addedIndex >= 0) return { ops: [{ op: 'remove', path: `/characters/${addedIndex}` }, { op: 'replace', path: `/characters/0/desc`, value: `after remove ${serial++}` }], fails: false }
  if (r < 0.84) {
    // A client save touching several places at once.
    const k = Math.floor(rand() * db.characters.length)
    return {
      ops: [
        { op: 'replace', path: `/characters/${k}/desc`, value: `desc ${serial++}` },
        { op: 'replace', path: `/modules/${m}/name`, value: `module name ${serial++}` },
        { op: 'replace', path: '/temperature', value: 50 + (serial++ % 40) },
      ],
      fails: false,
    }
  }
  if (r < 0.90) return { ops: [{ op: 'replace', path: `/characters/${i}/name`, value: 'never applied' }, { op: 'remove', path: `/characters/${i}/missingField` }], fails: true }
  if (r < 0.94) return { ops: [{ op: 'replace', path: `/characters/${i}/desc`, value: 'never applied' }, { op: 'replace', path: `/modules/${db.modules.length + 4}/name`, value: 'x' }], fails: true }
  return { ops: [{ op: 'replace', path: '/characters/01/name', value: 'non-canonical index' }], fails: true }
}

async function runSequence(env: Record<string, string>, seed: number) {
  const { srv, client } = await boot(env)
  serial = 0
  // The seed has no modules; the first patch adds the array.
  let local = await readDb(client)
  const addModules = [{ op: 'add', path: '/modules', value: [newModule(), newModule(), newModule()] }]
  expect((await sendPatch(client, addModules, utils.calculateHash(local).toString(16))).status).toBe(200)
  local = applyPatch(structuredClone(local), structuredClone(addModules), true).newDocument

  const rand = mulberry32(seed)
  let applied = 0
  let failed = 0
  for (let n = 0; n < 70; n++) {
    const { ops, fails } = generate(rand, local)
    const res = await sendPatch(client, ops, utils.calculateHash(local).toString(16))
    const where = `#${n} ${JSON.stringify(ops)}`
    if (fails) {
      expect(res.status, where).toBe(500)
      failed++
      continue
    }
    expect(res.status, `${where}: ${await res.clone().text()}`).toBe(200)
    local = applyPatch(structuredClone(local), structuredClone(ops), true).newDocument
    applied++
  }
  expect(applied).toBeGreaterThan(45)
  expect(failed).toBeGreaterThan(3)

  // The served view is the mirror, and its hash is the one the server holds.
  const served = await readDb(client)
  expect(served).toEqual(local)
  expect((await sendPatch(client, [], utils.calculateHash(local).toString(16))).status).toBe(200)

  const flushed = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
  expect(flushed.status).toBe(200)
  const disk = await readDiskDb(srv.cwd)
  expect(disk.modules).toEqual(local.modules)
  expect(disk.characters.map((c: any) => c.chaId)).toEqual(local.characters.map((c: any) => c.chaId))
  for (const [index, character] of local.characters.entries()) {
    const { chats: _viewChats, ...card } = character
    const { chats: diskChats, ...diskCard } = disk.characters[index]
    expect(diskCard).toEqual(card)
    // Stub metadata edits reached the disk chats; bodies are untouched.
    expect(diskChats.map((ch: any) => [ch.id, ch.name, ch.lastDate])).toEqual(character.chats.map((ch: any) => [ch.id, ch.name, ch.lastDate]))
    for (const chat of diskChats) expect(Array.isArray(chat.message)).toBe(true)
  }

  const memory = await (await client.fetch('/api/debug/memory')).json() as any
  // The spawned server inherits this process's env (the whole suite may run frozen).
  const frozen = (env.POCKETRISU_TEST_FREEZE_CACHE ?? process.env.POCKETRISU_TEST_FREEZE_CACHE) === '1'
  expect(memory.dbCache.testHardening).toBe(frozen)
  expect(memory.dbCache.cachedRootMutationReports).toBe(0)
}

describe('element-level patch sharing through /api/patch', () => {
  test('a seeded run of client patch shapes, cached roots frozen and audited', async () => {
    await runSequence({ POCKETRISU_TEST_FREEZE_CACHE: '1' }, 0xb2c0)
  }, 90_000)

  test('the same run without test hardening', async () => {
    await runSequence({}, 0xb2c0)
  }, 90_000)
})
