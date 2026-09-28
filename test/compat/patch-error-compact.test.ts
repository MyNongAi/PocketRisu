/**
 * A patch that fast-json-patch rejects must not carry the database in its
 * error. The library formats the whole document into the message, which on a
 * real database crashed the server ("Invalid string length") and copied chat
 * text into the log and the 500 response.
 */
import { afterAll, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const MARKER = 'PATCH-ERROR-MARKER-7f3a'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

test('a rejected patch answers and logs a short error without database content', async () => {
  const srv = await spawnServer()
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)

  const read = async () => {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    expect(res.status).toBe(200)
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  }
  const patch = (ops: unknown[], db: any) => client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch: ops, expectedHash: utils.calculateHash(db).toString(16) }),
  })

  // Put a recognizable string into the cached database first.
  let db = await read()
  expect((await patch([{ op: 'replace', path: '/characters/0/name', value: MARKER }], db)).status).toBe(200)
  db = await read()
  expect(db.characters[0].name).toBe(MARKER)

  // Removing a field that does not exist fails validation inside applyPatch.
  const failed = await patch([{ op: 'remove', path: '/characters/0/noSuchField' }], db)
  expect(failed.status).toBe(500)
  const body = await failed.text()
  expect(body.length).toBeLessThan(2000)
  expect(body).not.toContain(MARKER)
  expect(body).toContain('/characters/0/noSuchField')

  const output = srv.stdout?.() ?? ''
  expect(output).not.toContain(MARKER)

  // The failed patch left the database untouched.
  expect((await read()).characters[0].name).toBe(MARKER)
})
