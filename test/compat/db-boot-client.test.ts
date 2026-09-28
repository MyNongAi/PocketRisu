/**
 * The client's delta boot loader (src/ts/storage/bootPayload.ts) against the
 * real server's POST /api/db/boot: the bytes it assembles are the /api/read
 * bytes, the second boot downloads only what a patch changed, and the same
 * holds through a forwarded (compressed) request as Tailscale Serve sends.
 */
import { afterAll, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { loadDatabaseViaBoot } from '../../src/ts/storage/bootPayload'
import { MemoryBootSegmentCache } from '../../src/ts/storage/bootPayloadCache'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function readFull(client: RisuClient) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return { bytes: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('x-db-etag'), hash: res.headers.get('x-db-hash') }
}

function bootFetch(client: RisuClient, extraHeaders: Record<string, string> = {}) {
  return (input: string, init: RequestInit) => client.fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...extraHeaders },
  })
}

test('the client loader assembles the /api/read bytes and later downloads only changes', async () => {
  const srv = await spawnServer()
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 6, chatsPerCharacter: 2 }))).ok).toBe(true)
  const cache = new MemoryBootSegmentCache()
  const subtle = globalThis.crypto.subtle

  const full = await readFull(client)
  const first = await loadDatabaseViaBoot({ fetch: bootFetch(client), cache, subtle })
  expect(first.bytes).not.toBeNull()
  expect(Buffer.from(first.bytes!).equals(full.bytes)).toBe(true)
  expect(first.etag).toBe(full.etag)
  expect(first.dbHash).toBe(full.hash)
  expect(first.stats!.cachedSegments).toBe(0)
  const committed = await first.commit!()
  expect(committed.ok).toBe(true)

  const db = utils.normalizeJSON(await utils.decodeRisuSave(full.bytes)) as any
  expect(utils.calculateHash(db).toString(16)).toBe(first.dbHash)
  const patched = await client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({
      patch: [{ op: 'replace', path: '/characters/2/name', value: 'renamed for the delta boot' }],
      expectedHash: utils.calculateHash(db).toString(16),
    }),
  })
  expect(patched.status).toBe(200)

  // Through a forwarded request, compressed like a phone's over Tailscale Serve.
  const forwarded = { 'x-forwarded-for': '100.64.0.7', 'accept-encoding': 'br' }
  const second = await loadDatabaseViaBoot({ fetch: bootFetch(client, forwarded), cache, subtle })
  const after = await readFull(client)
  expect(Buffer.from(second.bytes!).equals(after.bytes)).toBe(true)
  expect(second.etag).toBe(after.etag)
  expect(second.etag).not.toBe(first.etag)
  expect(second.stats!.networkSegments).toBe(1)
  expect(second.stats!.cachedSegments).toBe(second.stats!.segments - 1)
  expect(second.stats!.includedBytes).toBeLessThan(after.bytes.length / 4)
  const decoded = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(second.bytes!))) as any
  expect(decoded.characters[2].name).toBe('renamed for the delta boot')
  expect(utils.calculateHash(decoded).toString(16)).toBe(second.dbHash)
})
