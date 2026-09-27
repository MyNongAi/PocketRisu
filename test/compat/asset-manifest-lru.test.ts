/**
 * The asset manifest LRU holds what requests read. Loading database.bin (the
 * reconcile strip writes every owner's manifest), a full write and the asset
 * reference scan behind the storage stats and the orphan sweep all walk every
 * manifest; none of them may fill the cache or evict what a read cached.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const db = {
    apiType: 'openai',
    characters: [{
      chaId: 'c1', name: 'Char', image: 'assets/avatar.png', chats: [],
      additionalAssets: [['x.png', 'assets/x.png', 'png'], ['y.png', 'assets/y.png', 'png']],
    }],
    modules: [{ id: 'm1', name: 'Pack', assets: [['m.png', 'assets/m.png', 'png']] }],
  }
  const entries = [{ name: 'database.risudat', data: Buffer.from(utils.encodeRisuSaveLegacy(db)) }]
  // Backup asset entries are named by basename and stored as assets/<name>.
  for (const name of ['avatar.png', 'x.png', 'y.png', 'm.png', 'orphan.png']) {
    entries.push({ name, data: Buffer.from(`fake-png-${name}`) })
  }
  expect((await client.importBackup(encodeBackup(entries))).ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, etag: res.headers.get('x-db-etag') }
}

async function manifestStats() {
  const res = await client.fetch('/api/asset-manifests/stats')
  expect(res.status).toBe(200)
  return await res.json() as { liveManifests: number; cacheEntries: number; cacheRawBytes: number }
}

describe('asset manifest LRU', () => {
  test('loading the database writes every manifest and caches none', async () => {
    const { db } = await readDb()
    expect(db.characters[0].additionalAssetManifest?.id).toBeTruthy()
    expect(db.modules[0].assetManifest?.id).toBeTruthy()
    expect(await manifestStats()).toMatchObject({ liveManifests: 2, cacheEntries: 0, cacheRawBytes: 0 })
  })

  test('a page read caches its manifest; the reference scan and a full write leave it as it was', async () => {
    const { db, etag } = await readDb()
    const id = db.characters[0].additionalAssetManifest.id
    const page = await client.fetch(`/api/asset-manifests/${encodeURIComponent(id)}?offset=0&limit=10`)
    expect(page.status).toBe(200)
    const cached = await manifestStats()
    expect(cached.cacheEntries).toBe(1)

    // The storage stats run the same reference scan as the orphan sweep: the
    // manifests still protect x, y and m, so only orphan.png is unreferenced.
    const stats = await client.fetch('/api/db/stats')
    expect(stats.status).toBe(200)
    expect((await stats.json() as any).orphan).toMatchObject({ available: true, count: 1 })
    expect(await manifestStats()).toMatchObject({ cacheEntries: 1, cacheRawBytes: cached.cacheRawBytes })

    // A full write strips (reconciles) the persisted database again.
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': etag! },
      body: Buffer.from(utils.encodeRisuSaveLegacy({ ...db, globalNote: 'full write' })),
    })
    expect(write.status).toBe(200)
    expect(await manifestStats()).toMatchObject({ liveManifests: 2, cacheEntries: 1, cacheRawBytes: cached.cacheRawBytes })

    const purge = await client.fetch('/api/db/assets/purge-orphans', { method: 'POST' })
    expect(purge.status).toBe(200)
    expect(await purge.json()).toMatchObject({ ok: true, deleted: 1 })
    expect(await manifestStats()).toMatchObject({ cacheEntries: 1, cacheRawBytes: cached.cacheRawBytes })
  })
})
