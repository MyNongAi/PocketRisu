/**
 * prewarmDb (runtime flag): a server that starts with a database loads it and
 * plans its read payload in the background, so the first read is warm and
 * serves the same bytes a cold read would.
 */
import { afterAll, expect, test } from 'vitest'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { sessionCookie } from './helpers/disk.js'

const Sqlite = require('better-sqlite3')
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function readBytes(client: RisuClient) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return { bytes: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('x-db-etag') }
}

async function waitForLine(srv: ServerHandle, pattern: RegExp, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const line = srv.stdout().split('\n').find((entry) => pattern.test(entry))
    if (line || Date.now() > deadline) return line ?? null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// A second server on a consistent SQLite snapshot of the first, as after a restart.
function restartOf(source: ServerHandle, env: Record<string, string> = {}) {
  return spawnServer({
    env,
    seedSave: async (saveDir) => {
      const db = new Sqlite(path.join(source.cwd, 'save/risuai.db'), { readonly: true })
      try { await db.backup(path.join(saveDir, 'risuai.db')) } finally { db.close() }
    },
  })
}

test('with prewarmDb the first read after a restart is warm and serves the same bytes', async () => {
  const first = await spawnServer()
  servers.push(first)
  const client = await createClient(first.port, first.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 3, chatsPerCharacter: 2 }))).ok).toBe(true)
  const flushed = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
  expect(flushed.status).toBe(200)

  const cold = await restartOf(first)
  servers.push(cold)
  const coldRead = await readBytes(await createClient(cold.port, cold.password))
  expect(await waitForLine(cold, /\[Read\] database\/database\.bin .*\bload \d+/, 3000)).not.toBeNull()

  const warm = await restartOf(first, { POCKETRISU_FLAG_PREWARM_DB: 'true' })
  servers.push(warm)
  expect(await waitForLine(warm, /\[Prewarm\] database\/database\.bin ready in \d+ ms/, 15_000)).not.toBeNull()
  const warmRead = await readBytes(await createClient(warm.port, warm.password))
  const readLine = await waitForLine(warm, /\[Read\] database\/database\.bin/, 3000)
  expect(readLine).not.toBeNull()
  // The warm path: no queue wait, flush or load stage.
  expect(readLine).not.toMatch(/\b(?:queue|flush|load) \d+/)
  expect(warmRead.bytes.equals(coldRead.bytes)).toBe(true)
  expect(warmRead.etag).toBe(coldRead.etag)

  // Off by default: the cold server never preloaded.
  expect(cold.stdout()).not.toMatch(/\[Prewarm\]/)
})
