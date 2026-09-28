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
const SLOW_DB_DECODE = fileURLToPath(new URL('./helpers/slow-db-decode-preload.cjs', import.meta.url))
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

// Reads the change feed from `since` until `marker` shows up (or timeoutMs).
async function readEventsUntil(client: RisuClient, since: { instance: string; seq: string }, marker: RegExp, timeoutMs = 3000) {
  const res = await client.fetch(`/api/sync/events?since=${since.seq}&instance=${since.instance}`)
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => { reader.cancel().catch(() => {}) }, timeoutMs)
  try {
    while (!marker.test(text)) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return text
}

// test-char-1 is deactivated with a bodiless stub chat (`gone`) that no
// archive row can fill, so every database persist from now on decodes the
// archive rows (and waits there while `slow-archive-decode` exists).
async function makeEveryPersistDecodeArchiveRows(client: RisuClient) {
  const seeded = await readDb(client)
  seeded.db.characters[1].chats.push({ id: 'gone', name: 'Gone', _stub: true })
  expect((await sendWrite(client, seeded.db, { 'x-if-match': seeded.etag! })).status).toBe(200)
  const archived = await client.fetch('/api/characters/archive-batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders },
    body: JSON.stringify({ chaIds: ['test-char-1'], acceptLostChats: true }),
  })
  expect((await archived.json() as any).results[0].ok).toBe(true)
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

  // That failure path answered 500 without publishing db-stale, so other
  // devices kept editing the view from before the write until they reloaded.
  test('that fails after kvSet still tells other devices to resync', async () => {
    const { srv, client } = await boot([FAIL_AFTER_DB_WRITE])
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    expect(res.status).toBe(200)
    const since = { instance: res.headers.get('x-sync-instance')!, seq: res.headers.get('x-sync-seq')! }
    const etag = res.headers.get('x-db-etag')!
    const db = await decodeDb(res)
    db.characters[0].name = 'written'

    await writeFile(path.join(srv.cwd, 'fail-after-db-write'), '')
    const write = await sendWrite(client, db, { 'x-if-match': etag })
    await rm(path.join(srv.cwd, 'fail-after-db-write'))
    expect(write.status).toBe(500)

    const events = await readEventsUntil(client, since, /event: db-stale\n/)
    expect(events).toMatch(/event: db-stale\ndata: \{[^\n]*"reason":"full-write"/)
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

describe('an /api/read flush', () => {
  // The flush ran outside the storage queue. With the root cold and a chat
  // save pending, its no-root branch decoded the blob, and after that await
  // wrote the root it had decoded: a full write that the queue ran meanwhile
  // was overwritten on disk (and the chat store it rebuilt was written too).
  test('does not write an older root over a full write that lands during its decode', async () => {
    const { srv, client } = await boot([SLOW_DB_DECODE])
    const disk = await readDiskDb(srv.cwd)
    await saveChat(client, 'acknowledged')

    await writeFile(path.join(srv.cwd, 'slow-db-decode'), '1500')
    const reading = client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    await sleep(300)
    const write = await sendWrite(client, clientView(disk, { index: 1, name: 'renamed' }), sessionHeaders)
    expect(write.status).toBe(200)
    expect((await reading).status).toBe(200)

    await flush(client)
    const after = await readDiskDb(srv.cwd)
    expect(after.characters[1].name).toBe('renamed')
    expect(after.characters[0].chats[0].message.at(-1).data).toBe('acknowledged')
    expect((await readDb(client)).db.characters[1].name).toBe('renamed')
  }, 20_000)

  // Outside the queue, every patch that landed while the flush's persist
  // decoded archive rows replaced the root, so the persist decoded again:
  // the read took as long as the patches kept coming. A warm read no longer
  // flushes at all (the root it serves holds every accepted write, and the
  // armed timer persists it): it answers at once, with the root of the
  // moment, and the timer's persist writes the patches later.
  test('is not held up by a stream of patches', async () => {
    const { srv, client } = await boot([SLOW_ARCHIVE_DECODE])
    await makeEveryPersistDecodeArchiveRows(client)
    const { db } = await readDb(client)
    const rename = async (name: string) => {
      const res = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: name }], utils.calculateHash(db).toString(16))
      expect(res.status).toBe(200)
      db.characters[0].name = name
    }
    await rename('p0') // arms the save timer

    await writeFile(path.join(srv.cwd, 'slow-archive-decode'), '600')
    let readAnswered = false
    const reading = client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } }).then((res) => { readAnswered = true; return res })
    let n = 1
    const stopAt = Date.now() + 4000
    while (Date.now() < stopAt) {
      await sleep(250)
      await rename(`p${n++}`)
    }
    const readDuringStream = readAnswered
    const served = await decodeDb(await reading)
    await rm(path.join(srv.cwd, 'slow-archive-decode'))

    // Answered while the patches were still coming, with the root of the
    // moment it was sent: no patch was applied before it.
    expect(readDuringStream).toBe(true)
    expect(served.characters[0].name).toBe('p0')
    await flush(client)
    expect((await readDiskDb(srv.cwd)).characters[0].name).toBe(db.characters[0].name)
  }, 30_000)
})

describe('a database persist that waits on archive rows', () => {
  // A patch and a chat save that arrive while a flush waits on an archive
  // row. The /api/read flush used to run outside the storage queue, so they
  // landed during the wait: the persist then wrote the older root and
  // rebuilt the chat store from it, reverting the acknowledged body. Every
  // flush now holds the queue (here /api/db/flush; a warm /api/read no
  // longer flushes), so both wait for it, and neither is lost.
  test('lets what arrives meanwhile wait, and loses none of it', async () => {
    const { srv, client } = await boot([SLOW_ARCHIVE_DECODE])
    await makeEveryPersistDecodeArchiveRows(client)

    const before = await readDb(client)
    const first = await sendPatch(client, [{ op: 'replace', path: '/characters/0/name', value: 'first' }], before.hash)
    expect(first.status).toBe(200)
    before.db.characters[0].name = 'first'
    const chatRead = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect(chatRead.status).toBe(200)
    const chat = await decodeDb(chatRead)

    await writeFile(path.join(srv.cwd, 'slow-archive-decode'), '2000')
    // A warm read serves the patched root without flushing it.
    expect((await readDb(client)).db.characters[0].name).toBe('first')
    const flushing = flush(client) // persists the first patch; the persist now waits
    await sleep(400)
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
    // The flush wrote the first patch; the second was applied after it.
    await flushing
    await rm(path.join(srv.cwd, 'slow-archive-decode'))
    let disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].name).toBe('first')

    // The next persist writes both, and the chat store still holds the body.
    await flush(client)
    disk = await readDiskDb(srv.cwd)
    expect(disk.characters[0].name).toBe('second')
    expect(disk.characters[0].chats[0].message.at(-1).data).toBe('acknowledged while waiting')
    const reread = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    const body = await decodeDb(reread)
    expect(body.message.at(-1).data).toBe('acknowledged while waiting')
  }, 20_000)
})
