/**
 * Every database etag the server reports is the md5 of the bytes /api/read
 * serves. /api/read, /api/write, /api/patch and its 409s each encode the
 * client view on their own (through encodeRisuSaveLegacyBuffer, without the
 * Buffer.from copy they used to make), so this pins them to the same bytes.
 * The chat-content ETag is the md5 of the chat bytes it sends.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(createSeedBackup({ characterCount: 2 }))
  expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const bytes = Buffer.from(await res.arrayBuffer())
  const db = utils.normalizeJSON(await utils.decodeRisuSave(bytes)) as any
  return { db, bytes, etag: res.headers.get('x-db-etag'), hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

describe('database etags', () => {
  test('write, patch and a stale patch report the md5 of the bytes /api/read serves', async () => {
    const first = await readDb()
    expect(first.etag).toBe(md5(first.bytes))

    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': first.etag! },
      body: Buffer.from(utils.encodeRisuSaveLegacy({ ...first.db, globalNote: 'written' })),
    })
    expect(write.status).toBe(200)
    const writeEtag = (await write.json() as { etag: string }).etag
    const afterWrite = await readDb()
    expect(afterWrite.db.globalNote).toBe('written')
    expect(writeEtag).toBe(afterWrite.etag)
    expect(afterWrite.etag).toBe(md5(afterWrite.bytes))

    const patch = await sendPatch([{ op: 'add', path: '/globalNote', value: 'patched' }], afterWrite.hash)
    expect(patch.status).toBe(200)
    const patchEtag = (await patch.json() as { etag: string }).etag
    const afterPatch = await readDb()
    expect(afterPatch.db.globalNote).toBe('patched')
    expect(patchEtag).toBe(afterPatch.etag)
    expect(afterPatch.etag).toBe(md5(afterPatch.bytes))

    const stale = await sendPatch([{ op: 'add', path: '/globalNote', value: 'again' }], afterWrite.hash)
    expect(stale.status).toBe(409)
    expect((await stale.json() as { currentEtag: string }).currentEtag).toBe(afterPatch.etag)
  })

  test('chat content is sent with the md5 of its bytes as ETag', async () => {
    const res = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect(res.status).toBe(200)
    const bytes = Buffer.from(await res.arrayBuffer())
    const chat = utils.normalizeJSON(await utils.decodeRisuSave(bytes)) as any
    expect(chat.id).toBe('chat-0-0')
    expect(Array.isArray(chat.message)).toBe(true)
    expect(res.headers.get('etag')).toBe(md5(bytes))
  })
})
