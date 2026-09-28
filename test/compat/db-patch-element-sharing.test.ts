/**
 * B2 through the real /api/patch: a seeded run of the patch shapes a client
 * produces (chat stub metadata, card and module edits, nested edits, slot
 * replaces, characters and modules added and removed at depth 2, a create or
 * delete followed by edits at the shifted indexes, moves and copies inside
 * the arrays) plus failing ones, mirrored on a local copy. Each accepted
 * patch must leave the server's hash equal to the client's calculateHash (the
 * next patch's expectedHash proves it), a failing one must leave the
 * database as it was, and after a persist the disk holds exactly the
 * mirrored view.
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

type Op = { op: string, path: string, from?: string, value?: unknown }

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
  const n = db.characters.length
  const i = Math.floor(rand() * n)
  const m = Math.floor(rand() * db.modules.length)
  const chats = db.characters[i].chats
  const j = Math.floor(rand() * Math.max(1, chats.length))
  const addedIndex = db.characters.findIndex((c: any) => typeof c.chaId === 'string' && c.chaId.startsWith('added-'))
  const r = rand()
  if (r < 0.20 && chats.length > 0) return { ops: [{ op: 'replace', path: `/characters/${i}/chats/${j}/lastDate`, value: 1727500000000 + serial++ }], fails: false }
  if (r < 0.26 && chats.length > 0) return { ops: [{ op: 'replace', path: `/characters/${i}/chats/${j}/name`, value: `Chat ${serial++}` }], fails: false }
  if (r < 0.33) return { ops: [{ op: 'replace', path: `/characters/${i}/name`, value: `Name ${serial++}` }], fails: false }
  if (r < 0.37) return { ops: [{ op: 'add', path: `/characters/${i}/tags`, value: ['a', `t${serial++}`] }, { op: 'add', path: `/characters/${i}/extraField`, value: { nested: [serial++] } }], fails: false }
  if (r < 0.43) return { ops: [{ op: 'replace', path: `/modules/${m}/lorebook/0/content`, value: `edited ${serial++}` }], fails: false }
  if (r < 0.46) return { ops: [{ op: 'replace', path: `/modules/${m}`, value: newModule() }], fails: false }
  if (r < 0.49) return { ops: [{ op: 'add', path: `/modules/${m}`, value: newModule() }], fails: false }
  if (r < 0.52 && db.modules.length > 2) return { ops: [{ op: 'remove', path: `/modules/${m}` }], fails: false }
  if (r < 0.55) return { ops: [{ op: 'add', path: '/characters/-', value: newCharacter() }], fails: false }
  // A create at any index, as the client sends it (the final index), then an
  // edit of a character the insert shifted.
  if (r < 0.59) {
    const at = Math.floor(rand() * (n + 1))
    return { ops: [{ op: 'add', path: `/characters/${at}`, value: newCharacter() }, { op: 'replace', path: `/characters/${Math.min(at + 1, n)}/desc`, value: `after insert ${serial++}` }], fails: false }
  }
  if (r < 0.62 && addedIndex >= 0) return { ops: [{ op: 'remove', path: `/characters/${addedIndex}` }, { op: 'replace', path: `/characters/0/desc`, value: `after remove ${serial++}` }], fails: false }
  // The client's create-and-delete shape: the remove, the add at its final
  // index, then edits at final indexes.
  if (r < 0.66 && addedIndex >= 0) {
    const at = Math.floor(rand() * n)
    const k = Math.floor(rand() * n)
    return {
      ops: [
        { op: 'remove', path: `/characters/${addedIndex}` },
        { op: 'add', path: `/characters/${at}`, value: newCharacter() },
        { op: 'replace', path: `/characters/${k}/name`, value: `shifted ${serial++}` },
        { op: 'add', path: `/characters/${at}/tags`, value: ['new'] },
      ],
      fails: false,
    }
  }
  // Moves inside the array (a reorder op the server accepts), then an edit
  // of the moved character.
  if (r < 0.69 && n > 1) {
    const from = Math.floor(rand() * n)
    const to = Math.floor(rand() * n)
    return { ops: [{ op: 'move', from: `/characters/${from}`, path: `/characters/${to}` }, { op: 'replace', path: `/characters/${to}/name`, value: `moved ${serial++}` }], fails: false }
  }
  if (r < 0.71) {
    const count = db.modules.length
    return {
      ops: [
        { op: 'copy', from: `/modules/${m}`, path: '/modules/-' },
        { op: 'replace', path: `/modules/${count}/id`, value: `module-copy-${serial++}` },
        { op: 'replace', path: `/modules/${count}/lorebook/0/content`, value: `copied ${serial++}` },
      ],
      fails: false,
    }
  }
  if (r < 0.78) {
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
  if (r < 0.83) return { ops: [{ op: 'replace', path: `/characters/${i}/name`, value: 'never applied' }, { op: 'remove', path: `/characters/${i}/missingField` }], fails: true }
  if (r < 0.87) return { ops: [{ op: 'replace', path: `/characters/${i}/desc`, value: 'never applied' }, { op: 'replace', path: `/modules/${db.modules.length + 4}/name`, value: 'x' }], fails: true }
  if (r < 0.90) return { ops: [{ op: 'add', path: `/characters/${n + 1}`, value: newCharacter() }], fails: true }
  // Structural ops that ran, then one that fails: nothing may stay behind.
  if (r < 0.94) return { ops: [{ op: 'add', path: '/characters/0', value: newCharacter() }, { op: 'replace', path: `/characters/${i + 1}/name`, value: 'never applied' }, { op: 'remove', path: `/characters/${n + 1}` }], fails: true }
  if (r < 0.97) return { ops: [{ op: 'move', from: `/characters/${i}`, path: '/characters/0' }, { op: 'replace', path: '/characters/0/desc', value: 'never applied' }, { op: 'test', path: '/characters/0/name', value: 'certainly not' }], fails: true }
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

  // A create or delete keeps every other character's identity through the
  // patch, so the incremental persister (db-persister.cjs) copies each of
  // them from the blob wherever it now sits and encodes only the new one.
  // POCKETRISU_PERSIST_VERIFY: the server compares every planned write with
  // the reference encoder.
  test('character create and delete in incremental mode copy every other character', async () => {
    const { srv, client } = await boot({
      POCKETRISU_FLAG_PERSIST_MODE: 'incremental',
      POCKETRISU_PERSIST_VERIFY: '1',
      POCKETRISU_CHUNK_THRESHOLD: '4096',
    })
    serial = 1000
    const cookie = await sessionCookie(client)
    let local = await readDb(client)
    const send = async (ops: Op[]) => {
      const res = await sendPatch(client, ops, utils.calculateHash(local).toString(16))
      expect(res.status, `${JSON.stringify(ops)}: ${await res.clone().text()}`).toBe(200)
      local = applyPatch(structuredClone(local), structuredClone(ops), true).newDocument
      expect((await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie } })).status).toBe(200)
      const memory = await (await client.fetch('/api/debug/memory')).json() as any
      expect(memory.persist.verifyFailures).toBe(0)
      expect(memory.dbCache.cachedRootMutationReports).toBe(0)
      return memory.persist.persister.last
    }
    const order = () => local.characters.map((c: any) => c.chaId)
    const seeded = order()

    // The first write encodes everything; the second copies everything.
    expect(await send([{ op: 'replace', path: '/temperature', value: 41 }])).toMatchObject({ persistMode: 'incremental', spans: false })
    const baseline = await send([{ op: 'replace', path: '/temperature', value: 42 }])
    expect(baseline).toMatchObject({ persistMode: 'incremental', spans: true, freshOwners: 0, freshChats: 0 })
    expect(baseline.spanOwners).toBeGreaterThanOrEqual(seeded.length)

    expect(await send([{ op: 'add', path: `/characters/${local.characters.length}`, value: newCharacter() }]))
      .toMatchObject({ spans: true, freshOwners: 1, spanOwners: baseline.spanOwners, freshChats: 0 })
    expect(await send([{ op: 'add', path: '/characters/0', value: newCharacter() }]))
      .toMatchObject({ spans: true, freshOwners: 1, spanOwners: baseline.spanOwners + 1, freshChats: 0 })
    expect(await send([{ op: 'remove', path: '/characters/0' }]))
      .toMatchObject({ spans: true, freshOwners: 0, spanOwners: baseline.spanOwners + 1, freshChats: 0 })
    // The client's shape: delete, create at the final index, edit a shifted character.
    const shifted = local.characters[3].chaId
    expect(await send([
      { op: 'remove', path: `/characters/${local.characters.length - 1}` },
      { op: 'add', path: '/characters/2', value: newCharacter() },
      { op: 'replace', path: '/characters/4/name', value: 'shifted, then edited' },
    ])).toMatchObject({ spans: true, freshOwners: 2, spanOwners: baseline.spanOwners - 1, freshChats: 0 })
    expect(local.characters[4].chaId).toBe(shifted)

    const disk = await readDiskDb(srv.cwd)
    expect(disk.characters.map((c: any) => c.chaId)).toEqual(order())
    for (const [index, character] of local.characters.entries()) {
      const { chats: viewChats, ...card } = character
      const { chats: diskChats, ...diskCard } = disk.characters[index]
      expect(diskCard).toEqual(card)
      expect(diskChats.map((ch: any) => ch.id)).toEqual(viewChats.map((ch: any) => ch.id))
      for (const chat of diskChats) expect(Array.isArray(chat.message)).toBe(true)
    }
  }, 90_000)
})
