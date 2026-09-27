/**
 * Measurement hooks for the live machine: per-save stage timings on stdout
 * and GET /api/debug/memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { sessionCookie } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 3, chatsPerCharacter: 2 }))).ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

// Lines the server printed that match, waiting briefly: stdout is a pipe and
// may arrive after the HTTP response that followed the write.
async function outputLines(pattern: RegExp, atLeast: number) {
  const deadline = Date.now() + 3000
  for (;;) {
    const lines = srv.stdout().split('\n').filter((line) => pattern.test(line))
    if (lines.length >= atLeast || Date.now() > deadline) return lines
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

describe('save diagnostics', () => {
  test('log one timing line per database read and per persist', async () => {
    const db = await readDb()
    const reads = await outputLines(/\[Read\]/, 1)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatch(/\[Read\] database\/database\.bin [\d.]+MB: flush \d+ blob \d+ load \d+ encode \d+ etag \d+ total \d+ ms/)

    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({
        patch: [{ op: 'replace', path: '/characters/0/name', value: 'timed' }],
        expectedHash: utils.calculateHash(db).toString(16),
      }),
    })
    expect(patched.status).toBe(200)
    const before = (await outputLines(/\[Persist\]/, 0)).length
    const flush = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
    expect(flush.status).toBe(200)
    const lines = await outputLines(/\[Persist\]/, before + 1)
    expect(lines).toHaveLength(before + 1)
    expect(lines.at(-1)).toMatch(/\[Persist\] database\/database\.bin [\d.]+MB: wait \d+ hydrate \d+ guards \d+ encode \d+ kvSet \d+ store \d+ total \d+ ms/)
  })

  test('GET /api/debug/memory reports process memory and cache counts', async () => {
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/debug/memory`)).status).toBe(400)

    await readDb()
    const res = await client.fetch('/api/debug/memory')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as any
    for (const field of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
      expect(typeof body.memoryUsage[field]).toBe('number')
    }
    expect(body.heap.used_heap_size).toBeGreaterThan(0)
    expect(body.heap.heap_size_limit).toBeGreaterThan(0)
    expect(Array.isArray(body.heapSpaces)).toBe(true)
    expect(body.dbCache.entries).toBeGreaterThanOrEqual(1)
    expect(body.dbCache.database).toMatchObject({ characters: 3, chatStubs: 6 })
    expect(body.fullChatStore).toEqual({ characters: 3, chats: 6 })
  })
})
