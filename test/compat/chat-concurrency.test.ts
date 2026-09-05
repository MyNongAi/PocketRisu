import { afterAll, describe, expect, test } from 'vitest'
import { Packr } from 'msgpackr'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []
const utils = require('../../server/node/utils.cjs')
const Sqlite = require('better-sqlite3')
const DB_KEY = Buffer.from('database/database.bin').toString('hex')

afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

function encodeChat(id: string, marker: string): Uint8Array {
  return new Uint8Array(Buffer.concat([
    MAGIC_RAW,
    packr.encode({
      id,
      name: id,
      lastDate: Date.now(),
      localLore: [],
      scriptstate: {},
      note: '',
      message: [{ role: 'char', data: marker }],
    }),
  ]))
}

async function boot() {
  const server = await spawnServer()
  servers.push(server)
  const client = await createClient(server.port, server.password)
  expect((await client.importBackup(createSeedBackup({
    characterCount: 1,
    chatsPerCharacter: 2,
  }))).ok).toBe(true)
  return client
}

function session(id: string) {
  return { 'x-session-id': id, 'x-user-active': '1' }
}

describe('per-chat optimistic concurrency', () => {
  test('PC and phone may claim different chats, but cannot write each other\'s active chat', async () => {
    const client = await boot()
    const read = (id: string, index: number) => client.fetch(`/api/chat-content/test-char-0/${index}`, { headers: { 'x-chat-id': id } })
    const a = await read('chat-0-0', 0)
    const b = await read('chat-0-1', 1)
    const pc = { ...session('pc'), 'x-chat-client-id': 'pc-page' }
    const phone = { ...session('phone'), 'x-chat-client-id': 'phone-page' }
    const claim = (id: string, headers: Record<string, string>, etag: string) => client.fetch(`/api/chat-session/test-char-0/${id}/claim`, {
      method: 'POST', headers: { ...headers, 'x-chat-etag': etag },
    })
    expect((await claim('chat-0-0', pc, a.headers.get('x-chat-etag')!)).status).toBe(200)
    expect((await claim('chat-0-1', phone, b.headers.get('x-chat-etag')!)).status).toBe(200)
    const busy = await claim('chat-0-0', phone, a.headers.get('x-chat-etag')!)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ code: 'CHAT_BUSY' })
    const write = (identity: Record<string, string>) => client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST', headers: { ...identity, 'content-type': 'application/octet-stream', 'x-chat-id': 'chat-0-0', 'x-if-match': a.headers.get('x-chat-etag')! },
      body: encodeChat('chat-0-0', 'new response'),
    })
    expect((await write(phone)).status).toBe(409)
    expect((await write(pc)).status).toBe(200)
    await client.fetch('/api/chat-session/test-char-0/chat-0-0', { method: 'DELETE', headers: pc })
    const stale = await claim('chat-0-0', phone, a.headers.get('x-chat-etag')!)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'CHAT_VERSION_CONFLICT' })
    const latest = await read('chat-0-0', 0)
    expect((await claim('chat-0-0', phone, latest.headers.get('x-chat-etag')!)).status).toBe(200)
  })

  test('a successful chat save remains writable after the database flushes', async () => {
    const client = await boot()
    const catalog = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
    })
    expect(catalog.status).toBe(200)
    const initial = await client.fetch('/api/chat-content/test-char-0/0', {
      headers: { 'x-chat-id': 'chat-0-0', ...session('pc') },
    })
    const first = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': initial.headers.get('etag')!,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'saved before metadata'),
    })
    expect(first.status).toBe(200)
    const acknowledgedEtag = (await first.json()).etag
    const flushed = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
    })
    expect(flushed.status, flushed.ok ? '' : await flushed.text()).toBe(200)
    const second = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': acknowledgedEtag,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'the next message'),
    })
    expect({ status: second.status, body: await second.json() }).toMatchObject({
      status: 200,
      body: { success: true },
    })
  })

  test('a new chat payload is not discarded while its catalog patch is pending', async () => {
    const client = await boot()
    await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
    })
    const created = await client.fetch('/api/chat-content/test-char-0/2', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-new',
        'if-none-match': '*',
        ...session('pc'),
      },
      body: encodeChat('chat-new', 'must survive a background flush'),
    })
    expect(created.status).toBe(200)
    const flushed = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
    })
    expect(flushed.status, flushed.ok ? '' : await flushed.text()).toBe(200)
    const fetched = await client.fetch('/api/chat-content/test-char-0/2', {
      headers: { 'x-chat-id': 'chat-new', ...session('pc') },
    })
    expect(fetched.status).toBe(200)

    // A different process opens a consistent SQLite snapshot, as after restart.
    const source = servers.at(-1)!
    const restarted = await spawnServer({ seedSave: async (saveDir) => {
      const db = new Sqlite(path.join(source.cwd, 'save/risuai.db'), { readonly: true })
      try { await db.backup(path.join(saveDir, 'risuai.db')) } finally { db.close() }
    } })
    servers.push(restarted)
    const reconnected = await createClient(restarted.port, restarted.password)
    const recovered = await reconnected.fetch('/api/chat-content/test-char-0/2', {
      headers: { 'x-chat-id': 'chat-new' },
    })
    expect(recovered.status).toBe(200)
    const chat = await utils.decodeRisuSave(Buffer.from(await recovered.arrayBuffer()))
    expect(chat.message[0].data).toBe('must survive a background flush')

    // Finish the delayed catalog registration, then flush. The body is now in
    // the main DB and its temporary recovery row must be retired.
    const catalog = await reconnected.fetch('/api/read', { headers: { 'file-path': DB_KEY } })
    const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await catalog.arrayBuffer())))
    const attached = await reconnected.fetch('/api/patch', {
      method: 'POST',
      headers: { 'file-path': DB_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedHash: utils.calculateHash(db).toString(16),
        patch: [{ op: 'add', path: '/characters/0/chats/-', value: { id: 'chat-new', name: 'new', _stub: true } }],
      }),
    })
    expect(attached.status).toBe(200)
    expect((await reconnected.fetch('/api/read', { headers: { 'file-path': DB_KEY } })).status).toBe(200)
    const stored = new Sqlite(path.join(restarted.cwd, 'save/risuai.db'), { readonly: true })
    try {
      expect(stored.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'chat-payload-pending/%'").get().n).toBe(0)
    } finally { stored.close() }
    expect((await reconnected.fetch('/api/chat-content/test-char-0/2', { headers: { 'x-chat-id': 'chat-new' } })).status).toBe(200)
  })

  test('metadata patches do not invalidate the chat-body version, but still reach disk', async () => {
    const client = await boot()
    const catalog = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY } })
    const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await catalog.arrayBuffer())))
    const initial = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    const etag = initial.headers.get('x-chat-etag')!
    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'file-path': DB_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedHash: utils.calculateHash(db).toString(16), patch: [
        { op: 'replace', path: '/characters/0/chats/0/name', value: 'renamed' },
        { op: 'add', path: '/characters/0/chats/0/folderId', value: null },
        { op: 'add', path: '/characters/0/chats/0/modules', value: [] },
      ] }),
    })
    expect(patched.status).toBe(200)
    await client.fetch('/api/read', { headers: { 'file-path': DB_KEY } })
    const hydrated = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect(hydrated.headers.get('x-chat-etag')).toBe(etag)
    expect(hydrated.headers.get('etag')).not.toBe(initial.headers.get('etag'))
    expect(await utils.decodeRisuSave(Buffer.from(await hydrated.arrayBuffer()))).toMatchObject({ name: 'renamed', folderId: null, modules: [] })
  })

  test('lost POST responses can be retried, but changed create collisions cannot overwrite', async () => {
    const client = await boot()
    const headers = { 'content-type': 'application/octet-stream', 'x-chat-id': 'new-id', 'if-none-match': '*', ...session('pc') }
    const body = encodeChat('new-id', 'same retry')
    for (let retry = 0; retry < 2; retry++) {
      expect((await client.fetch('/api/chat-content/test-char-0/2', { method: 'POST', headers, body })).status).toBe(200)
    }
    expect((await client.fetch('/api/chat-content/test-char-0/2', { method: 'POST', headers, body: encodeChat('new-id', 'different data') })).status).toBe(409)
  })

  test('metadata-only placeholders and mismatched IDs cannot replace real messages', async () => {
    const client = await boot()
    for (const body of [{ id: 'chat-0-0', _stub: true }, { id: 'wrong-id', message: [] }]) {
      expect((await client.fetch('/api/chat-content/test-char-0/0', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-id': 'chat-0-0' }, body: JSON.stringify(body),
      })).status).toBe(400)
    }
    const untouched = await client.fetch('/api/chat-content/test-char-0/0', { headers: { 'x-chat-id': 'chat-0-0' } })
    expect((await utils.decodeRisuSave(Buffer.from(await untouched.arrayBuffer()))).message).toHaveLength(2)
  })

  test('a stale global writer may save a different hydrated chat', async () => {
    const client = await boot()
    const chatA = await client.fetch('/api/chat-content/test-char-0/0', {
      headers: { 'x-chat-id': 'chat-0-0', ...session('pc') },
    })
    expect(chatA.status).toBe(200)
    const chatAEtag = chatA.headers.get('etag')
    expect(chatAEtag).toBeTruthy()

    // The phone becomes the legacy global writer by changing another chat.
    const phoneWrite = await client.fetch('/api/chat-content/test-char-0/1', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-1',
        ...session('phone'),
      },
      body: encodeChat('chat-0-1', 'phone owns the writer lock'),
    })
    expect(phoneWrite.status).toBe(200)

    // The PC is globally stale, but its chat-specific baseline is current.
    const pcWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': chatAEtag!,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'reroll survives'),
    })
    expect(pcWrite.status).toBe(200)
    expect((await pcWrite.json()).etag).toBeTruthy()
  }, 30_000)

  test('two writes to the same chat reject the stale copy with 409', async () => {
    const client = await boot()
    const initial = await client.fetch('/api/chat-content/test-char-0/0', {
      headers: { 'x-chat-id': 'chat-0-0', ...session('pc') },
    })
    const initialEtag = initial.headers.get('etag')
    expect(initialEtag).toBeTruthy()

    const phoneWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': initialEtag!,
        ...session('phone'),
      },
      body: encodeChat('chat-0-0', 'new phone response'),
    })
    expect(phoneWrite.status).toBe(200)

    const stalePcWrite = await client.fetch('/api/chat-content/test-char-0/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'chat-0-0',
        'x-if-match': initialEtag!,
        ...session('pc'),
      },
      body: encodeChat('chat-0-0', 'stale pc reroll'),
    })
    expect(stalePcWrite.status).toBe(409)
    expect(await stalePcWrite.json()).toMatchObject({
      error: 'Chat changed on another device',
    })
  }, 30_000)
})
