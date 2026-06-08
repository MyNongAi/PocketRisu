/**
 * Chunking lifecycle integration tests.
 *
 * Boots a real server with a LOW chunk threshold (POCKETRISU_CHUNK_THRESHOLD)
 * so the DB blob actually chunks, then drives the full lifecycle over HTTP:
 *   import (chunks) → stats (chunk-aware) → export → re-import (round-trip) →
 *   snapshots/limits → optimize/gc.
 *
 * The default compat fixtures use tiny DBs (< 16 MB) that never chunk, so this
 * is the only suite that exercises the chunked path through db.cjs + server.cjs
 * end-to-end — exactly the wiring the unit tests can't reach.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

// Chunk anything larger than 4 KB so a normal seed DB chunks.
const CHUNK_ENV = { POCKETRISU_CHUNK_THRESHOLD: '4096' }

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map((s) => s.cleanup())) })

async function boot(): Promise<RisuClient> {
  const srv = await spawnServer({ env: CHUNK_ENV })
  servers.push(srv)
  return createClient(srv.port, srv.password)
}

// A DB large enough (~400 KB) to span several CDC chunks (avg ~16 KB, max 64 KB),
// so the test exercises real multi-chunk splitting, not a single-chunk blob.
function oversizedSeed(): Buffer {
  return createSeedBackup({ characterCount: 5, chatsPerCharacter: 2, messagesPerChat: 1000 })
}

async function getStats(client: RisuClient): Promise<any> {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return res.json()
}

describe('chunking lifecycle (real server, low threshold)', () => {
  test('importing an oversized DB chunks the blob through the real server', async () => {
    const client = await boot()
    const r = await client.importBackup(oversizedSeed())
    expect(r.ok).toBe(true)

    const s = await getStats(client)
    // The whole point: the DB blob is stored as chunks, not one raw value.
    expect(s.chunks.liveChunked).toBe(true)
    expect(s.chunks.count).toBeGreaterThan(1)
    expect(s.chunks.bytes).toBeGreaterThan(0)
  })

  test('chunked DB exports to standard .bin and round-trips into a fresh server', async () => {
    const client = await boot()
    await client.importBackup(oversizedSeed())

    const exported = await client.exportBackup()
    expect(exported.byteLength).toBeGreaterThan(4096)

    const client2 = await boot()
    const r2 = await client2.importBackup(exported)
    expect(r2.ok).toBe(true)

    const s2 = await getStats(client2)
    expect(s2.chunks.liveChunked).toBe(true) // re-chunked on the fresh server
    // Data survived chunk → export(reassemble) → re-chunk.
    const charRes = await client2.fetch('/api/db/stats/characters')
    expect(charRes.status).toBe(200)
    const chars = await charRes.json()
    expect(chars.characters.length).toBeGreaterThanOrEqual(5)
  })

  test('snapshot endpoints report chunk-aware sizes (never the 13-byte marker)', async () => {
    const client = await boot()
    await client.importBackup(oversizedSeed())

    const lim = await (await client.fetch('/api/db/snapshots/limits')).json()
    expect(lim.maxBytes).toBeGreaterThan(0)
    expect(typeof lim.currentBytes).toBe('number')

    const snaps = await (await client.fetch('/api/db/snapshots')).json()
    for (const sn of snaps.snapshots) {
      expect(sn.size).not.toBe(13) // 13 = CHUNK_MARKER length (the old bug)
    }
  })

  test('optimize runs gc and reports chunksReclaimed', async () => {
    const client = await boot()
    await client.importBackup(oversizedSeed())

    const res = await client.fetch('/api/db/optimize', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.chunksReclaimed).toBe('number')
  })
})
