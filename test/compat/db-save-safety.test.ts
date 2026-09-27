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
const SLOW_ARCHIVE_DECODE = fileURLToPath(new URL('./helpers/slow-archive-decode-preload.cjs', import.meta.url))
const sessionHeaders = { 'x-session-id': 'db-save-safety', 'x-user-active': '1' }

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

async function decodeDb(res: Response) {
  return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
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

function sendWrite(client: RisuClient, db: unknown, headers: Record<string, string>) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, ...headers },
    body: Buffer.from(utils.encodeRisuSaveLegacy(db)),
  })
}

async function flush(client: RisuClient) {
  const res = await client.fetch('/api/db/flush', { method: 'POST', headers: { cookie: await sessionCookie(client) } })
  expect(res.status).toBe(200)
}

// Appends a message to test-char-0's first chat through /api/chat-content.
// That save only updates the server's chat store and arms the save timer.
async function saveChat(client: RisuClient, text: string) {
  const read = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
  expect(read.status).toBe(200)
  const chat = await decodeDb(read)
  const saved = await client.fetch('/api/chat-content/test-char-0/0', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-chat-id': 'chat-0-0',
      'x-if-match': read.headers.get('x-chat-etag')!,
      ...sessionHeaders,
    },
    body: Buffer.from(utils.encodeRisuSaveLegacy({ ...chat, message: [...chat.message, { role: 'user', data: text }] })),
  })
  expect(saved.status).toBe(200)
}

// What /api/read would serve for a database read from disk: chats as stubs.
function clientView(db: any, rename?: { index: number; name: string }) {
  return {
    ...db,
    characters: db.characters.map((c: any, i: number) => ({
      ...c,
      ...(rename && rename.index === i ? { name: rename.name } : {}),
      chats: c.chats.map((ch: any) => ({ id: ch.id, name: ch.name, _stub: true, lastDate: ch.lastDate })),
    })),
  }
}

async function lastDiskMessage(cwd: string) {
  return (await readDiskDb(cwd)).characters[0].chats[0].message.at(-1).data
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

describe('a cold root while an acknowledged chat save is pending', () => {
  // After an import (or a restart) the root is cold while the chat store is
  // live, and a chat save loads only the store. Whatever loaded the root next
  // rebuilt the store from disk over the acknowledged body, and the pending
  // timer (or the write itself) then persisted the store without it.
  test('keeps the body through an unconditional full write', async () => {
    const { srv, client } = await boot([])
    const disk = await readDiskDb(srv.cwd)
    await saveChat(client, 'acknowledged')
    const write = await sendWrite(client, clientView(disk, { index: 1, name: 'renamed' }), sessionHeaders)
    expect(write.status).toBe(200)

    await flush(client)
    const after = await readDiskDb(srv.cwd)
    expect(after.characters[1].name).toBe('renamed')
    expect(after.characters[0].chats[0].message.at(-1).data).toBe('acknowledged')
  })

  test('keeps the body through a cold /api/patch, even one answered 409', async () => {
    const { srv, client } = await boot([])
    await saveChat(client, 'acknowledged')
    const patched = await sendPatch(client, [{ op: 'replace', path: '/characters/1/name', value: 'p' }], 'not-the-hash')
    expect(patched.status).toBe(409)

    await flush(client)
    expect(await lastDiskMessage(srv.cwd)).toBe('acknowledged')
  })

  test('keeps the body through a conditional full write while the etag is unknown', async () => {
    const { srv, client } = await boot([])
    const disk = await readDiskDb(srv.cwd)
    await saveChat(client, 'acknowledged')
    // dbEtag is null after the import, so the write loads the root to
    // derive it; the stale precondition is then answered 409.
    const write = await sendWrite(client, clientView(disk), { 'x-if-match': 'stale' })
    expect(write.status).toBe(409)

    await flush(client)
    expect(await lastDiskMessage(srv.cwd)).toBe('acknowledged')
    const chat = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect((await decodeDb(chat)).message.at(-1).data).toBe('acknowledged')
  })
})

describe('a database persist that waits on archive rows', () => {
  // /api/read flushes outside the storage queue, so a patch and a chat save
  // can land while its persist waits on an archive row. The persist used to
  // hydrate the root and chat store before that wait, write that older state
  // after it, and then rebuild the chat store from it: the acknowledged chat
  // body was reverted in memory and the next persist wrote the old one.
  test('writes the root and chat bodies current when it resumes', async () => {
    const { srv, client } = await boot([SLOW_ARCHIVE_DECODE])
    // Every persist now restores test-char-1 from its archive row: its `gone`
    // chat is a bodiless stub that no row can fill.
    const seeded = await readDb(client)
    seeded.db.characters[1].chats.push({ id: 'gone', name: 'Gone', _stub: true })
    const seedWrite = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': seeded.etag! },
      body: Buffer.from(utils.encodeRisuSaveLegacy(seeded.db)),
    })
    expect(seedWrite.status).toBe(200)
    const archived = await client.fetch('/api/characters/archive-batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders },
      body: JSON.stringify({ chaIds: ['test-char-1'], acceptLostChats: true }),
    })
    expect((await archived.json() as any).results[0].ok).toBe(true)

    const before = await readDb(client)
    const first = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'first' }], before.hash)
    expect(first.status).toBe(200)
    before.db.characters[0].name = 'first'
    const chatRead = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect(chatRead.status).toBe(200)
    const chat = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await chatRead.arrayBuffer()))) as any

    await writeFile(path.join(srv.cwd, 'slow-archive-decode'), '2000')
    const reading = readDb(client) // flushes the first patch; its persist now waits
    await new Promise((resolve) => setTimeout(resolve, 400))
    const second = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'second' }], utils.calculateHash(before.db).toString(16))
    expect(second.status).toBe(200)
    const saved = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': chatRead.headers.get('x-chat-etag')!,
        ...sessionHeaders,
      },
      body: Buffer.from(utils.encodeRisuSaveLegacy({ ...chat, message: [...chat.message, { role: 'user', data: 'acknowledged while waiting' }] })),
    })
    expect(saved.status).toBe(200)
    expect((await reading).db.characters[0].name).toBe('second')
    await rm(path.join(srv.cwd, 'slow-archive-decode'))

    // The persist that waited wrote what was current when it resumed.
    let disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].name).toBe('second')
    expect(disk.characters[0].chats[0].message.at(-1).data).toBe('acknowledged while waiting')

    // And it did not revert the chat store: the next persist keeps the body.
    await flush(client)
    disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].chats[0].message.at(-1).data).toBe('acknowledged while waiting')
    const reread = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    const body = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await reread.arrayBuffer()))) as any
    expect(body.message.at(-1).data).toBe('acknowledged while waiting')
  }, 20_000)
})
