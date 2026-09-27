/**
 * database.bin writes that fail or wait half-way must never let an older
 * in-memory view overwrite what was acknowledged or already written.
 * Faults are injected into the spawned server with --require preloads.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskDb, sessionCookie } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
// fileURLToPath, not URL.pathname: on Windows .pathname is "/H:/..." and the
// server child fails to load the preload.
const FAIL_AFTER_DB_WRITE = fileURLToPath(new URL('./helpers/fail-after-db-write-preload.cjs', import.meta.url))

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function boot(preloads: string[]) {
  const srv = await spawnServer({ env: { NODE_OPTIONS: preloads.map((p) => `--require ${p}`).join(' ') } })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)
  return { srv, client }
}

async function readDb(client: RisuClient) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, etag: res.headers.get('x-db-etag'), hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(client: RisuClient, patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

async function flush(client: RisuClient) {
  const res = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
  expect(res.status).toBe(200)
}

describe('a full database write', () => {
  // The blob is committed, then something after kvSet throws. The cached
  // root is still the one from before the write and the save timer of an
  // earlier patch is still armed: left alone, that timer wrote the older
  // view over the blob just written.
  test('that fails after kvSet is not overwritten by the older cached view', async () => {
    const { srv, client } = await boot([FAIL_AFTER_DB_WRITE])
    const before = await readDb(client)
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'patched' }], before.hash)
    expect(patched.status).toBe(200)
    const { etag } = await patched.json() as { etag: string }

    const mine = { ...before.db, characters: before.db.characters.map((c: any, i: number) => (i === 0 ? { ...c, name: 'written' } : c)) }
    await writeFile(path.join(srv.cwd, 'fail-after-db-write'), '')
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': etag },
      body: Buffer.from(utils.encodeRisuSaveLegacy(mine)),
    })
    await rm(path.join(srv.cwd, 'fail-after-db-write'))
    expect(write.status).toBe(500)
    expect((await readDiskDb(srv.cwd)).characters[0].name).toBe('written')

    // What the patch's timer would do, now.
    await flush(client)
    const disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].name).toBe('written')
    expect(disk.characters[0].chats[0].message.length).toBeGreaterThan(0)
    // The server re-reads what is on disk instead of the dropped view.
    expect((await readDb(client)).db.characters[0].name).toBe('written')
  })
})
