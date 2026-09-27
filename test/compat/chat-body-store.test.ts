/**
 * The server's chat bodies live in chat-body-store.cjs as msgpack bytes.
 * These drive it through the HTTP routes: a catalog reload in the middle of a
 * full write, the bytes a chat GET serves, and a test mode that deep-freezes
 * every cached root and every chat a persist hydrates, so that an in-place
 * mutation of cached state fails instead of silently aliasing.
 */
import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { readDiskDb, readDiskValue, sessionCookie } from './helpers/disk.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')
const Sqlite = require('better-sqlite3')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const COLD_STORAGE_HEADER = 'COLDSTORAGE'
const sessionHeaders = { 'x-session-id': 'chat-body-store', 'x-user-active': '1' }

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

async function boot(env: Record<string, string> = {}, seed: Parameters<typeof createSeedBackup>[0] = { characterCount: 2, chatsPerCharacter: 2 }) {
  const srv = await spawnServer({ env })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  expect((await client.importBackup(createSeedBackup(seed))).ok).toBe(true)
  return { srv, client }
}

async function decodeBody(res: Response) {
  return utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as Promise<any>
}

async function readDb(client: RisuClient) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await decodeBody(res)) as any
  return { db, etag: res.headers.get('x-db-etag')!, hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(client: RisuClient, patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

function sendWrite(client: RisuClient, db: unknown, headers: Record<string, string> = {}) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, ...sessionHeaders, ...headers },
    body: Buffer.from(utils.encodeRisuSaveLegacy(db)),
  })
}

async function flush(client: RisuClient) {
  const res = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
  expect(res.status).toBe(200)
}

function getChat(client: RisuClient, chaId: string, chatId: string, index = 0) {
  return client.fetch(`/api/chat-content/${chaId}/${index}`, { headers: { 'x-chat-id': chatId } })
}

async function postChat(client: RisuClient, chaId: string, chat: any, headers: Record<string, string> = {}) {
  return client.fetch(`/api/chat-content/${chaId}/0`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-chat-id': chat.id, ...sessionHeaders, ...headers },
    body: Buffer.from(utils.encodeRisuSaveLegacy(chat)),
  })
}

async function appendToChat(client: RisuClient, chaId: string, chatId: string, text: string) {
  const read = await getChat(client, chaId, chatId)
  expect(read.status).toBe(200)
  const chat = await decodeBody(read)
  const saved = await postChat(client, chaId, { ...chat, message: [...chat.message, { role: 'user', data: text }] }, {
    'x-if-match': read.headers.get('x-chat-etag')!,
  })
  expect(saved.status).toBe(200)
}

// What /api/read serves for a database read from disk: chats as stubs.
function clientView(db: any) {
  return {
    ...db,
    characters: db.characters.map((c: any) => ({
      ...c,
      chats: c.chats.map((ch: any) => ({ id: ch.id, name: ch.name, _stub: true, lastDate: ch.lastDate })),
    })),
  }
}

function diskChat(disk: any, chaId: string, chatId: string) {
  return disk.characters.find((c: any) => c.chaId === chaId)?.chats.find((c: any) => c.id === chatId)
}

describe('a catalog reload in the middle of a full write', () => {
  // After an import the root is cold and the chat store is loaded. A full
  // write then reloads the catalog (and the store) before it hydrates. The
  // chat it carries inline must be the one that stays: the design this
  // store replaced kept the pre-write body when the reload happened after
  // the write's snapshot, and the next persist wrote that older body back.
  test('adopts the inline body it wrote, and keeps it through later persists', async () => {
    const { srv, client } = await boot()
    const disk = await readDiskDb(srv.cwd)
    await appendToChat(client, 'test-char-1', 'chat-1-0', 'acknowledged before the write')

    const view = clientView(disk)
    const inline = { ...diskChat(disk, 'test-char-0', 'chat-0-0') }
    inline.message = [...inline.message, { role: 'user', data: 'written inline' }]
    view.characters[0].chats[0] = inline
    const write = await sendWrite(client, view)
    expect(write.status).toBe(200)

    // Served from the store at once.
    const served = await decodeBody(await getChat(client, 'test-char-0', 'chat-0-0'))
    expect(served.message.at(-1).data).toBe('written inline')
    // On disk right away; the acknowledged body of the other chat was merged in.
    let after = await readDiskDb(srv.cwd)
    expect(diskChat(after, 'test-char-0', 'chat-0-0').message.at(-1).data).toBe('written inline')
    expect(diskChat(after, 'test-char-1', 'chat-1-0').message.at(-1).data).toBe('acknowledged before the write')

    // A later persist (a patch) must not bring the older body back.
    const { hash } = await readDb(client)
    expect((await sendPatch(client, [{ op: 'replace', path: '/characters/1/name', value: 'renamed' }], hash)).status).toBe(200)
    await flush(client)
    after = await readDiskDb(srv.cwd)
    expect(after.characters[1].name).toBe('renamed')
    expect(diskChat(after, 'test-char-0', 'chat-0-0').message.at(-1).data).toBe('written inline')
    expect(diskChat(after, 'test-char-0', 'chat-0-0')._stub).toBeUndefined()
    expect(diskChat(after, 'test-char-1', 'chat-1-0').message.at(-1).data).toBe('acknowledged before the write')
  })
})

describe('chat GET bytes', () => {
  test('are the legacy encoding of the stored chat, before and after a restart', async () => {
    const { srv, client } = await boot()
    const disk = await readDiskDb(srv.cwd)
    const res = await getChat(client, 'test-char-0', 'chat-0-0')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(Buffer.from(utils.encodeRisuSaveLegacy(diskChat(disk, 'test-char-0', 'chat-0-0'))))).toBe(true)
    expect(res.headers.get('etag')).toMatch(/^"?[0-9a-f]{32}"?$/)

    // A saved body keeps its content ETag across a restart, including
    // undefined-valued fields a restart drops.
    const chat = await decodeBody(await getChat(client, 'test-char-0', 'chat-0-1'))
    const edited = { ...chat, note: undefined, message: [...chat.message, { role: 'user', data: 'saved', extra: undefined }] }
    const saved = await postChat(client, 'test-char-0', edited)
    expect(saved.status).toBe(200)
    const { etag } = await saved.json() as { etag: string }
    const beforeRestart = await getChat(client, 'test-char-0', 'chat-0-1')
    expect(beforeRestart.headers.get('x-chat-etag')).toBe(etag)
    expect(Buffer.from(await beforeRestart.arrayBuffer()).equals(Buffer.from(utils.encodeRisuSaveLegacy(edited)))).toBe(true)
    await flush(client)

    // A different process opens a consistent SQLite snapshot, as after restart.
    const again = await spawnServer({ seedSave: async (saveDir) => {
      const db = new Sqlite(path.join(srv.cwd, 'save/risuai.db'), { readonly: true })
      try { await db.backup(path.join(saveDir, 'risuai.db')) } finally { db.close() }
    } })
    servers.push(again)
    const client2 = await createClient(again.port, again.password)
    const afterRestart = await getChat(client2, 'test-char-0', 'chat-0-1')
    expect(afterRestart.status).toBe(200)
    expect(afterRestart.headers.get('x-chat-etag')).toBe(etag)
    const body = await decodeBody(afterRestart)
    expect(body.message.at(-1).data).toBe('saved')
    expect(Buffer.from(utils.encodeRisuSaveLegacy(body)).equals(Buffer.from(utils.encodeRisuSaveLegacy(utils.normalizeJSON(edited))))).toBe(true)
  })
})

// Every root the server installs in dbCache is deep-frozen, every chat a
// persist hydrates from the store is frozen, and stored body bytes are
// checked on each read. The store module and the patch helpers are strict
// code, so a write into any of those throws there.
describe('with cached state frozen', () => {
  const FROZEN = { POCKETRISU_TEST_FREEZE_CACHE: '1' }

  test('persist, patch, write and chat flows never mutate cached state', async () => {
    const { srv, client } = await boot(FROZEN)
    const first = await readDb(client)
    const memory = await (await client.fetch('/api/debug/memory')).json() as any
    expect(memory.chatBodyStore.testHardening).toBe(true)

    // Patch in a hybrid chat (stub flag and a body) and a chat without an id.
    // Both are then the cached root's own objects in every persist.
    const hybrid = { id: 'hybrid-1', name: 'Hybrid', _stub: true, lastDate: 1, message: [{ role: 'user', data: 'hybrid body' }] }
    const idless = { name: 'Idless', lastDate: 1, message: [{ role: 'user', data: 'idless body' }] }
    const patched = await sendPatch(client, [
      { op: 'add', path: '/characters/0/chats/2', value: hybrid },
      { op: 'add', path: '/characters/0/chats/3', value: idless },
      { op: 'replace', path: '/characters/1/name', value: 'patched' },
    ], first.hash)
    expect(patched.status).toBe(200)
    await flush(client)
    let disk = await readDiskDb(srv.cwd)
    expect(disk.characters[1].name).toBe('patched')
    expect(diskChat(disk, 'test-char-0', 'hybrid-1').message[0].data).toBe('hybrid body')
    expect(disk.characters[0].chats[3].message[0].data).toBe('idless body')
    // The catalog was not touched: still the hybrid and the idless chat.
    const view = (await readDb(client)).db
    expect(view.characters[0].chats[2]._stub).toBe(true)
    expect(view.characters[0].chats[3].id).toBeUndefined()
    // The store holds the hybrid's body without its flag.
    const hybridBody = await decodeBody(await getChat(client, 'test-char-0', 'hybrid-1', 2))
    expect(hybridBody.message[0].data).toBe('hybrid body')
    expect(hybridBody._stub).toBeUndefined()

    // A second persist merges the hybrid with its stored body.
    const second = await readDb(client)
    expect((await sendPatch(client, [{ op: 'replace', path: '/characters/1/name', value: 'patched again' }], second.hash)).status).toBe(200)
    await flush(client)
    disk = await readDiskDb(srv.cwd)
    expect(diskChat(disk, 'test-char-0', 'hybrid-1')._stub).toBeUndefined()
    expect(diskChat(disk, 'test-char-0', 'hybrid-1').message[0].data).toBe('hybrid body')

    // Chat saves, a claim, and a persist of them.
    await appendToChat(client, 'test-char-0', 'chat-0-0', 'frozen-mode save')
    const read = await getChat(client, 'test-char-0', 'chat-0-0')
    const claim = await client.fetch('/api/chat-session/test-char-0/chat-0-0/claim', {
      method: 'POST',
      headers: { 'x-chat-client-id': 'client-a', 'x-chat-etag': read.headers.get('x-chat-etag')!, ...sessionHeaders },
    })
    expect(claim.status).toBe(200)
    await flush(client)
    expect(diskChat(await readDiskDb(srv.cwd), 'test-char-0', 'chat-0-0').message.at(-1).data).toBe('frozen-mode save')

    // A full write with an inline chat; the write then installs its view.
    const current = await readDb(client)
    const written = structuredClone(current.db)
    written.characters[1].chats[0] = { ...diskChat(disk, 'test-char-1', 'chat-1-0'), message: [{ role: 'user', data: 'full write' }] }
    expect((await sendWrite(client, written, { 'x-if-match': current.etag })).status).toBe(200)
    expect((await decodeBody(await getChat(client, 'test-char-1', 'chat-1-0'))).message[0].data).toBe('full write')
    const afterWrite = await readDb(client)
    expect((await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'after write' }], afterWrite.hash)).status).toBe(200)
    await flush(client)
    disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].name).toBe('after write')
    expect(diskChat(disk, 'test-char-1', 'chat-1-0').message[0].data).toBe('full write')
  })

  test('a cold-storage chat is restored on a copy and written back', async () => {
    const coldId = 'cold-chat-1'
    const { srv, client } = await boot(FROZEN, {
      characterCount: 1,
      chatsPerCharacter: 1,
      coldStorageEntries: { [coldId]: { message: [{ role: 'user', data: 'restored from cold storage' }] } },
    })
    const chat = { id: 'cold', name: 'Cold', lastDate: 1, message: [{ role: 'char', data: COLD_STORAGE_HEADER + coldId }] }
    expect((await postChat(client, 'test-char-0', chat)).status).toBe(200)
    const first = await getChat(client, 'test-char-0', 'cold')
    expect(first.status).toBe(200)
    expect((await decodeBody(first)).message[0].data).toBe('restored from cold storage')
    // The restored body is what the store holds now (its ETag names it).
    const second = await getChat(client, 'test-char-0', 'cold')
    expect(second.headers.get('x-chat-etag')).toBe(first.headers.get('x-chat-etag'))
    expect(readDiskValue(srv.cwd, 'database/database.bin')).not.toBeNull()
  })
})
