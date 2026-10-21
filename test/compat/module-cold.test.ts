/**
 * Stored modules (module-cold-store.cjs) against a real server: which modules
 * may be stored, the db-patch that takes their bodies out, reading the
 * bodies back, export putting them back, the stub guard, asset protection
 * and the orphan purge once a module is whole again.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { applyPatch } from 'fast-json-patch'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')
const DB_KEY_HEX = hex('database/database.bin')

const lore = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({
  key: `${tag}-${i}`, secondkey: '', insertorder: 100, comment: `${tag} ${i}`,
  content: `${tag} entry ${i} `.repeat(20), mode: 'normal', alwaysActive: false, selective: false,
}))
const body = (tag: string) => ({
  lorebook: lore(30, tag),
  regex: [{ comment: `${tag} regex`, in: 'a', out: 'b', type: 'editdisplay', ableFlag: false }],
  trigger: [{ comment: `${tag} trigger`, type: 'start', conditions: [], effect: [] }],
})
const mod = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Module ${id}`, description: `about ${id}`, ...body(id), ...extra })

const COLD = 'm-cold'
const IDS = [COLD, 'm-global', 'm-preset', 'm-bot', 'm-chat', 'm-tiny', 'm-mcp', 'missing']

function buildBackup(): Buffer {
  const database = {
    characters: [{
      chaId: 'keep', type: 'character', name: 'Kept', desc: '', firstMessage: 'hi', image: '',
      modules: ['m-bot'],
      chats: [{ id: 'keep-chat', name: 'Chat', localLore: [], note: '', message: [{ role: 'user', data: 'hello' }], modules: ['m-chat'] }],
      chatPage: 0,
    }],
    characterOrder: ['keep'],
    modules: [
      mod(COLD, { folderId: 'f1', favorite: true, assets: [['img', 'assets/m-asset.png', 'png']] }),
      mod('m-global'),
      mod('m-preset', { namespace: 'presetNs' }),
      mod('m-bot'),
      mod('m-chat'),
      { id: 'm-tiny', name: 'Tiny', description: '', lorebook: lore(1, 'tiny') },
      mod('m-mcp', { mcp: { url: 'http://127.0.0.1:1/mcp' } }),
    ],
    enabledModules: ['m-global'],
    botPresets: [{ name: 'Preset', moduleIntergration: 'presetNs' }],
    apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
    temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresetsId: 0, moduleIntergration: '', selectedCharacter: 0,
  }
  return encodeBackup([
    { name: 'database.risudat', data: encodeDb(database) },
    { name: 'm-asset.png', data: Buffer.from('fake-png-m-asset') },
    { name: 'orphan.png', data: Buffer.from('fake-png-orphan') },
  ])
}

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer({ env: { POCKETRISU_ARCHIVE_ORPHAN_GRACE_MS: '0' } })
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(buildBackup())
  expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, etag: res.headers.get('x-db-etag'), hash: utils.calculateHash(db).toString(16) }
}
function sendPatch(patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}
function storeModules(ids: string[]) {
  return client.fetch('/api/modules/cold', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  })
}
async function readBodies(refs: unknown[]) {
  const res = await client.fetch('/api/modules/cold-bodies', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs }),
  })
  expect(res.status).toBe(200)
  return (await res.json() as any).bodies
}
async function exportDb() {
  const entries = decodeBackup(await client.exportBackup())
  const dbEntry = entries.find((e) => e.name === 'database.risudat')
  expect(dbEntry).toBeTruthy()
  return decodeRisuDat(dbEntry!.data) as any
}
async function stats() {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return await res.json() as any
}
const moduleOf = (db: any, id: string) => db.modules.find((m: any) => m.id === id)

let marker: any

describe('stored modules', () => {
  test('only a module nothing uses is stored, by one db-patch', async () => {
    const before = await readDb()
    const res = await storeModules(IDS)
    expect(res.status).toBe(200)
    const out = await res.json() as any
    expect(out.results.map((r: any) => [r.id, r.ok, r.code])).toEqual([
      [COLD, true, undefined],
      ['m-global', false, 'MODULE_IN_USE'],
      ['m-preset', false, 'MODULE_IN_USE'],
      ['m-bot', false, 'MODULE_IN_USE'],
      ['m-chat', false, 'MODULE_IN_USE'],
      ['m-tiny', false, 'MODULE_TOO_SMALL'],
      ['m-mcp', false, 'MODULE_MCP'],
      ['missing', false, 'MODULE_NOT_FOUND'],
    ])
    marker = out.results[0].marker
    expect(marker).toMatchObject({ lorebookCount: 30, regexCount: 1, triggerCount: 1 })
    expect(marker.bytes).toBeGreaterThan(4096)

    const after = await readDb()
    const stub = moduleOf(after.db, COLD)
    expect(stub.nodeOnlyColdModule).toEqual(marker)
    expect(stub.lorebook).toBeUndefined()
    expect(stub.regex).toBeUndefined()
    expect(stub.trigger).toBeUndefined()
    // The catalog entry stays as it was, asset list included.
    expect(stub).toMatchObject({ name: `Module ${COLD}`, description: `about ${COLD}`, folderId: 'f1', favorite: true })
    expect(stub.assetManifest).toBeTruthy()
    for (const id of IDS.slice(1, 7)) expect(moduleOf(after.db, id)).toEqual(moduleOf(before.db, id))

    // Other pages land exactly this change on the revision it names.
    const published = out.published
    expect(published.prevHash).toBe(before.hash)
    expect(published.nextHash).toBe(after.hash)
    expect(published.etag).toBe(after.etag)
    expect(published.prevEtag).toBe(before.etag)
    const landed = applyPatch(structuredClone(before.db), published.ops, true, false).newDocument
    expect(utils.calculateHash(landed).toString(16)).toBe(after.hash)

    const again = await (await storeModules([COLD])).json() as any
    expect(again.results).toEqual([{ id: COLD, ok: false, code: 'MODULE_ALREADY_COLD' }])
    expect(again.published).toBeNull()
  })

  test('the body reads back by its row', async () => {
    const [found, gone] = await readBodies([{ id: COLD, archivedAt: marker.archivedAt }, { id: COLD, archivedAt: 1 }])
    expect(found.body).toEqual(utils.normalizeJSON(body(COLD)))
    expect(gone).toEqual({ id: COLD, archivedAt: 1, missing: true })
  })

  test('a stub may change its catalog entry, never name a row that does not exist', async () => {
    let view = await readDb()
    const index = view.db.modules.findIndex((m: any) => m.id === COLD)
    const renamed = await sendPatch([{ op: 'replace', path: `/modules/${index}/name`, value: 'Renamed while stored' }], view.hash)
    expect(renamed.status).toBe(200)

    view = await readDb()
    const tiny = view.db.modules.findIndex((m: any) => m.id === 'm-tiny')
    const dangling = await sendPatch([{ op: 'add', path: `/modules/${tiny}/nodeOnlyColdModule`, value: { archivedAt: 123, bytes: 1 } }], view.hash)
    expect(dangling.status).toBe(409)
    expect((await dangling.json() as any).code).toBe('ARCHIVE_GUARD_REJECTED')
  })

  test('export puts the body back', async () => {
    const db = await exportDb()
    const whole = moduleOf(db, COLD)
    expect(whole.nodeOnlyColdModule).toBeUndefined()
    expect(whole.name).toBe('Renamed while stored')
    expect(whole.lorebook).toEqual(utils.normalizeJSON(body(COLD)).lorebook)
    expect(whole.regex).toHaveLength(1)
    expect(whole.trigger).toHaveLength(1)
    expect(whole.assets).toEqual([['img', 'assets/m-asset.png', 'png']])
  })

  test('the stored module keeps its assets out of the orphan count', async () => {
    const s = await stats()
    expect(s.orphan.available).toBe(true)
    expect(s.orphan.count).toBe(1) // orphan.png only
    expect(s.prefixes['module-cold/'].count).toBe(1)
  })

  test('a module put back leaves its row to the orphan purge', async () => {
    const view = await readDb()
    const index = view.db.modules.findIndex((m: any) => m.id === COLD)
    const [{ body: stored }] = await readBodies([{ id: COLD, archivedAt: marker.archivedAt }])
    const { nodeOnlyColdModule: _marker, ...stub } = view.db.modules[index]
    const res = await sendPatch([{ op: 'replace', path: `/modules/${index}`, value: { ...stub, ...stored } }], view.hash)
    expect(res.status).toBe(200)
    expect(moduleOf((await readDb()).db, COLD).lorebook).toHaveLength(30)

    const purge = await client.fetch('/api/db/archive/purge-orphans', { method: 'POST' })
    expect(purge.status).toBe(200)
    expect((await purge.json() as any).deleted).toBe(1)
    expect((await stats()).prefixes['module-cold/']?.count ?? 0).toBe(0)
  })
})
