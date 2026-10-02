/**
 * The stale-build write fence as server.cjs mounts it (build-fence.cjs). With
 * dist/build-id.txt present, a write carrying another build's id is refused
 * with 426 and changes nothing, while the same write with the served id or
 * without the header is applied. Reads stay open, and a rebuild under the
 * running server is picked up without a restart.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const BUILD_HEADER = 'x-pocketrisu-build'

let srv: ServerHandle
let client: RisuClient
let buildIdFile: string

beforeAll(async () => {
  srv = await spawnServer({
    seedSave: async (saveDir) => {
      const dist = path.join(saveDir, '..', 'dist')
      await mkdir(dist, { recursive: true })
      buildIdFile = path.join(dist, 'build-id.txt')
      await writeFile(buildIdFile, 'build-a\n')
    },
  })
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(createSeedBackup({ characterCount: 1 }))
  expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb(build?: string) {
  const res = await client.fetch('/api/read', {
    headers: { 'file-path': DB_KEY_HEX, ...(build ? { [BUILD_HEADER]: build } : {}) },
  })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, hash: utils.calculateHash(db).toString(16) }
}

async function patchNote(note: string, build?: string) {
  const { hash } = await readDb()
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'file-path': DB_KEY_HEX,
      ...(build ? { [BUILD_HEADER]: build } : {}),
    },
    body: JSON.stringify({ patch: [{ op: 'add', path: '/globalNote', value: note }], expectedHash: hash }),
  })
}

describe('stale-build write fence', () => {
  test('the server names the build it serves', () => {
    expect(srv.stdout()).toContain('[BuildFence] serving client build build-a')
  })

  test('a write from another build is refused and changes nothing', async () => {
    const before = (await readDb()).db.globalNote
    const refused = await patchNote('from the old tab', 'build-old')
    expect(refused.status).toBe(426)
    expect(await refused.json()).toMatchObject({ code: 'STALE_CLIENT_BUILD', serverBuild: 'build-a' })
    expect((await readDb()).db.globalNote).toBe(before)

    const remove = await client.fetch('/api/remove', {
      headers: { 'file-path': DB_KEY_HEX, [BUILD_HEADER]: 'build-old' },
    })
    expect(remove.status).toBe(426)
  })

  test('the served build and header-less clients still write, and reads stay open', async () => {
    expect((await patchNote('current build', 'build-a')).status).toBe(200)
    expect((await readDb('build-old')).db.globalNote).toBe('current build')
    expect((await patchNote('no header')).status).toBe(200)
    expect((await readDb()).db.globalNote).toBe('no header')
  })

  test('a rebuild under the running server moves the fence', async () => {
    await writeFile(buildIdFile, 'build-bb\n')
    const refused = await patchNote('previous build', 'build-a')
    expect(refused.status).toBe(426)
    expect(await refused.json()).toMatchObject({ serverBuild: 'build-bb' })
    expect((await patchNote('rebuilt', 'build-bb')).status).toBe(200)
  })
})
